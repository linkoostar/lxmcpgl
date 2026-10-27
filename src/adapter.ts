/**
 * UpstreamAdapter — 多上游统一适配层
 *
 * 每个上游（领星元工具模式、Sif 扁平 MCP、卖家精灵、NocoDB…）实现此接口。
 * 新增 upstream 只需要写一个 adapter + upstreams 表插一行。
 *
 * 现有 UpstreamClient (upstream.ts) 不动，LingxingMetaAdapter 包一层它。
 */

import type { UpstreamClient } from './upstream.js';

/** upstream 配置行（从 upstreams 表读） */
export interface UpstreamConfig {
  id: string;
  name: string;
  url: string;
  api_key?: string;
  adapter: string;
  active: number;
  sync_strategy: string;
  shop_field: string;
  notes?: string;
  headers?: string; // JSON string of { "x-api-key": "xxx", ... }
}

/** 标准化的工具定义（用于同步到 tools 表） */
export interface StandardTool {
  tool_id: string;         // 上游原始 tool_id
  exposed_name?: string;   // MCP tools/list 里暴露的名字（默认 tool_id）
  name?: string;           // 中文/可读名
  description?: string;
  input_schema?: string | null;
  tool_type?: 'read' | 'write' | 'other';
}

/** 上游返回的结构化错误（保留原始 code / traceId，供统一错误信封使用） */
export interface UpstreamErrorInfo {
  code?: number | string;
  message: string;
  trace_id?: string;
  raw?: unknown;
}

/** MCP tools/call 的返回（标准化 content） */
export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  upstreamError?: UpstreamErrorInfo;
}

/** Adapter 接口 — 所有上游必须实现 */
export interface UpstreamAdapter {
  /** 这个 adapter 能不能处理某个 config */
  canHandle(config: UpstreamConfig): boolean;

  /**
   * 列出上游所有可用工具（用于 tools 同步）
   * @param config  upstream 配置
   * @returns 标准化工具列表
   */
  listTools(config: UpstreamConfig): Promise<StandardTool[]>;

  /**
   * 调上游工具（MCP tools/call 转发）
   * @param config  upstream 配置
   * @param toolId  上游原始 tool_id（不是 exposed_name）
   * @param args    工具参数
   * @returns MCP content 格式
   */
  callTool(config: UpstreamConfig, toolId: string, args: Record<string, unknown>): Promise<McpCallResult>;

  /**
   * 从参数里提取店铺引用（sid / profile_id / seller_id / store_id…）
   * 用于网关店铺白名单校验 + call_logs
   */
  extractShopRefs(args: Record<string, unknown>): string[];

  /**
   * 从 call 返回里挖上游的 cost_credits / ￥ / token 消耗
   * 用于 cost_logs 费用分摊
   * @returns credits 数 or null（上游不返回 cost）
   */
  extractCost(contentText: string | null | undefined): number | null;

  /** 可选：同步 shop 列表（供 shops 表） */
  listShopIds?(config: UpstreamConfig): Promise<Array<{ sid: string; name?: string; country?: string; seller_id?: string }>>;

  /** 可选：轻量探活（健康检查用），不抛错，返回是否连通 */
  probe?(config: UpstreamConfig): Promise<boolean>;
}

/** 从上游错误对象里尽量挖出 traceId / requestId */
function pickTraceId(obj: any): string | undefined {
  if (!obj) return undefined;
  const d = obj.data ?? obj;
  return d?.traceId ?? d?.trace_id ?? d?.requestId ?? d?.request_id ?? obj?.traceId;
}

// =====================================================
// 注册中心 — 根据 config.adapter 字段路由到对应实现
// =====================================================

const registry: UpstreamAdapter[] = [];

export function registerAdapter(adapter: UpstreamAdapter): void {
  registry.push(adapter);
}

export function getAdapter(config: UpstreamConfig): UpstreamAdapter {
  const a = registry.find((r) => r.canHandle(config));
  if (!a) throw new Error(`未知 adapter 类型: ${config.adapter}`);
  return a;
}

// =====================================================
// Adapter 1: LingxingMetaAdapter — 领星元工具模式
//   上游只暴露 help/search/action 三个 MCP 工具
//   业务工具通过 action(toolId, params) 转发
// =====================================================

class LingxingMetaAdapter implements UpstreamAdapter {
  canHandle(c: UpstreamConfig): boolean { return c.adapter === 'lingxing-meta'; }

  async listTools(config: UpstreamConfig): Promise<StandardTool[]> {
    // 领星的工具同步逻辑现有 sync.ts 里已经实现（search 轮询拉 schema）
    // 这里直接返回空数组 — 实际同步由 sync.ts 里的 syncLingxingTools 做
    // M1.4 再迁过来
    return [];
  }

  async callTool(config: UpstreamConfig, toolId: string, args: Record<string, unknown>): Promise<McpCallResult> {
    // 复用现有 UpstreamClient
    const { getUpstreamClient } = await import('./upstream.js');
    const client = getUpstreamClient(config.url, config.api_key ?? '');
    const resp = await client.callTool('action', { toolId, params: args });
    if (resp?.error) {
      return {
        content: [],
        isError: true,
        upstreamError: {
          code: resp.error.code,
          message: resp.error.message ?? '上游返回错误',
          trace_id: pickTraceId(resp.error),
          raw: resp.error,
        },
      };
    }
    if (!resp?.result?.content) {
      return { content: [], isError: true, upstreamError: { message: '上游无响应' } };
    }
    return { content: resp.result.content, isError: resp.result.isError };
  }

  async probe(config: UpstreamConfig): Promise<boolean> {
    try {
      const { getUpstreamClient } = await import('./upstream.js');
      const client = getUpstreamClient(config.url, config.api_key ?? '');
      await client.ensureInit();
      return true;
    } catch {
      return false;
    }
  }

  extractShopRefs(args: Record<string, unknown>): string[] {
    const out: string[] = [];
    const SHOP_KEYS = new Set(['sid', 'sids', 'shop_id', 'shop_ids', 'store_id', 'seller_id', 'profile_id', 'pvi_ids']);
    for (const [k, v] of Object.entries(args)) {
      if (!SHOP_KEYS.has(k)) continue;
      if (typeof v === 'string') {
        v.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
      } else if (Array.isArray(v)) {
        v.map((x) => String(x)).forEach((x) => out.push(x));
      }
    }
    return [...new Set(out)];
  }

  extractCost(_contentText: string | null | undefined): number | null {
    // 领星免费版不返回 cost
    return null;
  }
}

/**
 * 空壳检测：解析 content 里的 JSON，判断是否关键字段全 null 但 isError=false
 * 返回警告字符串（null = 正常）
 * 西柚等上游在参数合法但数据确实不存在时，返回 {asin:'xxx', title:null, price:null, ...}
 * Agent 会误判为"该商品没数据"，我们加个 __gateway_warn 提示
 */
function detectEmptyShell(content: Array<{ type: string; text?: string }>, toolId: string): string | null {
  try {
    const text = content.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    const candidates: unknown[] = [];
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed)) { if (parsed.length > 0) candidates.push(parsed[0]); }
      else {
        candidates.push(parsed);
        if (parsed.data) candidates.push(parsed.data);
        if (Array.isArray(parsed.data) && parsed.data.length > 0) candidates.push(parsed.data[0]);
      }
    }
    for (const cand of candidates) {
      if (!cand || typeof cand !== 'object' || Array.isArray(cand)) continue;
      const obj = cand as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => !['asin', 'asins', 'sku', 'keyword', 'seller_id'].includes(k));
      if (keys.length < 3) continue;
      const nullCount = keys.filter((k) => obj[k] === null || obj[k] === undefined || obj[k] === '').length;
      if (nullCount / keys.length >= 0.85) {
        return `⚠️ 上游返回疑似空壳数据（${nullCount}/${keys.length} 字段为 null），工具: ${toolId}`;
      }
    }
  } catch { /* 非 JSON */ }
  return null;
}

// =====================================================
// Adapter 2: FlatMcpAdapter — 标准扁平 MCP
//   Sif / 西柚 / 卖家精灵 等直接暴露业务工具
//   initialize → tools/list → tools/call
// =====================================================

class FlatMcpAdapter implements UpstreamAdapter {
  private clients = new Map<string, FlatMcpClient>();

  canHandle(c: UpstreamConfig): boolean { return c.adapter === 'flat-mcp'; }

  async listTools(config: UpstreamConfig): Promise<StandardTool[]> {
    const client = this.getOrCreateClient(config);
    await client.initialize();
    const raw = await client.listTools();
    return raw.map((t: any) => ({
      tool_id: t.name,
      exposed_name: t.name,
      name: t.description ? t.description.split(/[,，]/)[0].trim() : t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
      tool_type: classifyByName(t.name),
    }));
  }

  async callTool(config: UpstreamConfig, toolId: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = this.getOrCreateClient(config);
    await client.initialize();
    const resp = await client.callTool(toolId, args);
    if (resp?.error) {
      return {
        content: [],
        isError: true,
        upstreamError: {
          code: resp.error.code,
          message: resp.error.message ?? '上游返回错误',
          trace_id: pickTraceId(resp.error),
          raw: resp.error,
        },
      };
    }
    if (!resp?.result?.content) {
      return { content: [], isError: true, upstreamError: { message: '上游无响应' } };
    }
    const content = resp.result.content;
    // 空壳检测：某些上游返回 isError=false 但关键字段全 null
    const warn = detectEmptyShell(content, toolId);
    if (warn) {
      content.push({ type: 'text', text: JSON.stringify({ __gateway_warn: warn }) });
    }
    return { content, isError: resp.result.isError };
  }

  async probe(config: UpstreamConfig): Promise<boolean> {
    try {
      const client = this.getOrCreateClient(config);
      await client.initialize();
      return true;
    } catch {
      return false;
    }
  }

  extractShopRefs(args: Record<string, unknown>): string[] {
    // 扁平 MCP 一般用 asin / shop_id / account_id
    const out: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string') {
        if (v.length <= 32) out.push(v);
      } else if (Array.isArray(v)) {
        v.map((x) => String(x)).forEach((x) => { if (x.length <= 32) out.push(x); });
      }
    }
    return [...new Set(out)];
  }

  extractCost(contentText: string | null | undefined): number | null {
    if (!contentText) return null;
    try {
      const parsed = JSON.parse(contentText);
      // Sif 顶层可能有 cost_credits / credits / cost 字段
      if (typeof parsed.cost_credits === 'number') return parsed.cost_credits;
      if (typeof parsed.credits === 'number') return parsed.credits;
      if (typeof parsed.cost === 'number') return parsed.cost;
      if (parsed.data) {
        if (typeof parsed.data.cost_credits === 'number') return parsed.data.cost_credits;
        if (typeof parsed.data.credits === 'number') return parsed.data.credits;
      }
    } catch { /* 非 JSON */ }
    return null;
  }

  private getOrCreateClient(config: UpstreamConfig): FlatMcpClient {
    const key = `${config.url}:${config.api_key ?? ''}:${config.headers ?? '{}'}`;
    let c = this.clients.get(key);
    if (!c) {
      // 解析自定义 headers（JSON string → object）
      let customHeaders: Record<string, string> = {};
      if (config.headers) {
        try { customHeaders = JSON.parse(config.headers); } catch { /* ignore */ }
      }
      c = new FlatMcpClient(config.url, config.api_key ?? '', customHeaders);
      this.clients.set(key, c);
    }
    return c;
  }
}

/** 标准扁平 MCP client（HTTP streamable + 可选自定义 headers） */
class FlatMcpClient {
  private initialized = false;
  constructor(
    private url: string,
    private apiKey: string,
    private customHeaders: Record<string, string> = {}
  ) {}

  private async rpc(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    // 先放自定义 headers，再用标准 headers 覆盖（Content-Type/Accept 不能被覆盖）
    const headers: Record<string, string> = {
      ...this.customHeaders,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.apiKey && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const resp = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const txt = await resp.text();
    // 支持 SSE（NocoDB/西柚这类用 streamable HTTP 会返回 event: + data: 多行）
    // 遍历所有行找最后一个 data: 开头的行（MCP SSE 可能多事件，我们要的是最后一个 JSON-RPC result）
    const lines = txt.split(/\r?\n/);
    let lastDataLine: string | null = null;
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (trimmed.startsWith('data:')) lastDataLine = trimmed.slice(5).trim();
    }
    if (lastDataLine !== null) {
      if (lastDataLine === '[DONE]') throw new Error('SSE done without response');
      return JSON.parse(lastDataLine);
    }
    // 不是 SSE，直接 JSON.parse
    return JSON.parse(txt);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const resp = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lxtp-mcp', version: '1.0.0' },
    });
    if (resp.error) throw new Error(`init error: ${resp.error.message}`);
    this.initialized = true;
  }

  async listTools(): Promise<any[]> {
    const resp = await this.rpc('tools/list', {});
    if (resp.error) throw new Error(`listTools error: ${resp.error.message}`);
    return resp.result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    // 不在这里抛错：把 JSON-RPC error 原样返回，交给 adapter 归一化（保留 code/traceId）
    return this.rpc('tools/call', { name, arguments: args });
  }
}

/** 工具读写分类（兜底） */
const WRITE_TOKENS = new Set([
  'put', 'add', 'create', 'update', 'delete', 'del', 'set', 'modify', 'cancel',
  'edit', 'remove', 'save', 'import', 'send', 'archive', 'push', 'upload',
  'pause', 'enable', 'disable', 'adjust', 'audit', 'approve', 'reject',
  'mark', 'reset', 'bind', 'unbind', 'apply',
]);
function classifyByName(name: string): 'read' | 'write' {
  const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => WRITE_TOKENS.has(t)) ? 'write' : 'read';
}

// 注册
registerAdapter(new LingxingMetaAdapter());
registerAdapter(new FlatMcpAdapter());
