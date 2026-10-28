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
  /** 空壳数据标记（detectEmptyShell 的结果透传） */
  emptyShell?: { isEmpty: boolean; effectiveRows: number; warn: string | null };
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

/**
 * 领星等上游**从不返回 JSON-RPC error**——所有业务错误（102 Schema 过期、403 权限等）
 * 都包在 result.content[].text 里：{"code":403,"msg":"...","success":false}
 * 解析 content text JSON，检测 code !== 1（或 code !== 0 视上游而定）或 success === false。
 * 返回 UpstreamErrorInfo；没有业务错误返回 null。
 */
/**
 * 领星等上游的业务响应都是**双层结构**：
 *   外层: {"success":true, "code":1, "msg":"操作成功", "data":{...}}
 *   内层: {"success":false, "code":0, "msg":"页条数必须在20,50...范围内", "data":null}
 * 外层几乎永远是 success=true code=1（不管业务成功与否），
 * 真正的业务错误藏在内层 data 里！
 *
 * 历史 bug：只查外层 → 参数校验失败、权限不够等业务错误被静默放行 →
 * Agent 拿空 data.list 继续算 → 出错误结论（成本>售价等）。
 */
function detectBizErrorInContent(content: Array<{ type: string; text?: string }>): UpstreamErrorInfo | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
    let parsed: any;
    try { parsed = JSON.parse(part.text); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    // ① 外层 success=false → 直接业务错误
    if (parsed.success === false) {
      return buildUpstreamError(parsed);
    }
    // ② 外层 code > 100 → 明确业务错误（领星 102/403/...）
    if (typeof parsed.code === 'number' && parsed.code !== 1 && parsed.code !== 0 && parsed.code > 100) {
      return buildUpstreamError(parsed);
    }

    // ====== 内层 data 检测（历史盲区！）======
    const inner = parsed.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      // ③ 内层 success=false → 业务错误（最常见的"假成功"信号）
      if (inner.success === false) {
        return buildUpstreamError({ ...parsed, ...inner, code: inner.code ?? parsed.code });
      }
      // ④ 内层 code 存在且 !== 1 → 业务错误（领星内层成功码也是 1，0 表示有问题）
      if (typeof inner.code === 'number' && inner.code !== 1) {
        return buildUpstreamError({ ...parsed, ...inner, code: inner.code });
      }
      // ⑤ 内层 msg 非空 + 内层 data 为 null/undefined → 大概率有问题
      //    典型：参数非法被拒，内层 data.msg="页条数必须..." 但 data.data=null
      if (
        typeof inner.msg === 'string' && inner.msg.length > 0 &&
        (inner.data === null || inner.data === undefined)
      ) {
        return buildUpstreamError({ ...parsed, ...inner, code: inner.code ?? parsed.code });
      }
    }
  }
  return null;
}

/** 从内层+外层混合构造 UpstreamErrorInfo（内层字段优先） */
function buildUpstreamError(merged: any): UpstreamErrorInfo {
  return {
    code: merged.code,
    message: String(merged.msg ?? merged.message ?? '上游返回业务错误').slice(0, 500),
    trace_id: pickTraceId(merged),
    raw: merged,
  };
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

    // ===== 参数格式：嵌套 params，这是领星 upstream action 工具的 inputSchema 约定 =====
    // 领星元工具模式下，action 是一个 MCP 工具，它的 inputSchema 定义的是：
    //   { toolId: string, params: object }
    // help/search 是扁平（各自 inputSchema 简单），但 action 是嵌套的——
    // 因为 action 要转发到不定数量的业务工具，业务工具参数统一塞在 params 里。
    // 之前错误地改成扁平 { toolId, ...args }，导致 upstream 报 102 Schema 过期（参数结构不匹配）。
    const resp = await client.callTool('action', { toolId, params: args });

    // ===== 诊断日志：打印上游原始响应结构（开发/排查用，不影响逻辑） =====
    try {
      const result = resp?.result;
      const contentArr = result?.content;
      const parts: string[] = [];
      parts.push('upstream_response_keys=[' + Object.keys(resp ?? {}).join(',') + ']');
      parts.push('result_keys=[' + (result ? Object.keys(result).join(',') : 'N/A') + ']');
      if (Array.isArray(contentArr)) {
        parts.push('content_parts=' + contentArr.length);
        for (let i = 0; i < contentArr.length; i++) {
          const part = contentArr[i];
          if (part && typeof part === 'object') {
            const keys = Object.keys(part).join(',');
            parts.push('content[' + i + '] keys=[' + keys + ']');
            if (typeof (part as any).text === 'string') {
              const txt = (part as any).text as string;
              parts.push('content[' + i + '].text.length=' + txt.length);
              try {
                const parsed = JSON.parse(txt);
                const arrayLens: string[] = [];
                const walk = (node: unknown, path: string) => {
                  if (Array.isArray(node)) {
                    arrayLens.push(path + '→' + node.length);
                    node.forEach((it, idx) => {
                      if (idx < 2) walk(it, path + '[' + idx + ']');
                    });
                  } else if (node && typeof node === 'object') {
                    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
                      walk(v, path ? path + '.' + k : k);
                    }
                  }
                };
                walk(parsed, '');
                parts.push('content[' + i + '] arrays: ' + arrayLens.join('; '));
              } catch {
                parts.push('content[' + i + '].text 非 JSON');
              }
            }
          }
        }
      } else {
        parts.push('content 不是数组: ' + typeof contentArr);
      }
      parts.push('isError=' + (result?.isError ?? 'N/A'));
      console.log('[gw-diag] upstream raw [' + toolId + '] ' + parts.join(' | '));
    } catch (e) {
      console.log('[gw-diag] upstream raw [' + toolId + '] 诊断异常: ' + String(e));
    }

    if (resp?.error) {
      // 领星把业务错误码（如 102）包在 error.data.code 里，顶层 error.code 是 JSON-RPC 层的 -32000
      // 优先取 data.code，让排查时直接看到上游原始码
      const errData = resp.error.data as Record<string, unknown> | undefined;
      return {
        content: [],
        isError: true,
        upstreamError: {
          code: (errData?.code as number | undefined) ?? resp.error.code,
          message: resp.error.message ?? (errData?.message as string | undefined) ?? '上游返回错误',
          trace_id: pickTraceId(resp.error),
          raw: resp.error,
        },
      };
    }
    if (!resp?.result?.content) {
      return { content: [], isError: true, upstreamError: { message: '上游无响应' } };
    }
    // ===== 业务错误检测 =====
    // 领星 upstream **从不返回 JSON-RPC error**——所有业务错误（102 Schema 过期、403 权限、空数据）
    // 都包在 result.content[].text 里，isError 永远是 false。
    // 这里必须额外解析 content text JSON，检测 code !== 1 或 success === false。
    const bizErr = detectBizErrorInContent(resp.result.content);
    if (bizErr) {
      return {
        content: resp.result.content,
        isError: true,
        upstreamError: bizErr,
      };
    }
    return { content: resp.result.content, isError: resp.result.isError, emptyShell: detectEmptyShell(resp.result.content) };
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
 * 西柚等上游在参数合法但数据确实不存在时，返回 {asin:'xxx', title:null, price:null, ...}
 * 返回：{ warn, isEmpty, effectiveRows } — warn 非空表示疑似空壳
 * 同时统计主数组的有效行数（排除 null/空行），用于 call_logs.effective_rows
 */
export function detectEmptyShell(
  content: Array<{ type: string; text?: string }>
): { warn: string | null; isEmpty: boolean; effectiveRows: number } {
  let effectiveRows = 0;
  try {
    const text = content.find((c) => c.type === 'text')?.text;
    if (text) {
      const parsed = JSON.parse(text);
      // 递归找所有顶级数组，统计总行数
      const countArrays = (o: unknown): void => {
        if (Array.isArray(o)) {
          // 只计有效元素（非 null/undefined/空对象）
          const valid = o.filter((x) => x != null && !(typeof x === 'object' && Object.keys(x).length === 0));
          if (valid.length > 0 && valid.length > effectiveRows) effectiveRows = valid.length;
          for (const item of o) countArrays(item);
        } else if (o && typeof o === 'object') {
          for (const v of Object.values(o as Record<string, unknown>)) countArrays(v);
        }
      };
      countArrays(parsed);
    }

    if (!text) return { warn: null, isEmpty: false, effectiveRows };
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
        return { warn: `⚠️ 上游返回疑似空壳数据（${nullCount}/${keys.length} 字段为 null）`, isEmpty: true, effectiveRows };
      }
    }
  } catch { /* 非 JSON */ }
  return { warn: null, isEmpty: false, effectiveRows };
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
      // 同样优先挖 error.data.code（部分扁平 MCP 上游也会把业务码包在 data 里）
      const errData = resp.error.data as Record<string, unknown> | undefined;
      return {
        content: [],
        isError: true,
        upstreamError: {
          code: (errData?.code as number | undefined) ?? resp.error.code,
          message: resp.error.message ?? (errData?.message as string | undefined) ?? '上游返回错误',
          trace_id: pickTraceId(resp.error),
          raw: resp.error,
        },
      };
    }
    if (!resp?.result?.content) {
      return { content: [], isError: true, upstreamError: { message: '上游无响应' } };
    }
    // 扁平 MCP 上游也可能把业务错误包在 content 里（和领星同样风格）
    const bizErr = detectBizErrorInContent(resp.result.content);
    if (bizErr) {
      return { content: resp.result.content, isError: true, upstreamError: bizErr };
    }
    const content = resp.result.content;
    // 空壳检测：某些上游返回 isError=false 但关键字段全 null
    const shell = detectEmptyShell(content);
    if (shell.warn) {
      // __gateway_warn 插到 content 第一个位置
      content.unshift({ type: 'text', text: JSON.stringify({ __gateway_warn: shell.warn }) });
    }
    return { content, isError: resp.result.isError, emptyShell: shell };
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
