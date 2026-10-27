import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import {
  db,
  getSetting,
  getToolByExposedName,
  getUserToolIds,
  getUserShopIds,
  touchUser,
  insertCallLog,
  type UserRow,
} from './db.js';
import { getUpstreamClient } from './upstream.js';
import { refreshToolSchema } from './sync.js';

/**
 * 下游 MCP 端点（无状态 streamableHttp）：
 *  - tools/list：按调用者身份摊平暴露业务工具
 *  - tools/call：鉴权 → 限流 → 工具/店铺校验 → 转发上游 action(toolId, params)
 */

export type McpIdentity =
  | { kind: 'admin' }
  | {
      kind: 'user';
      id: number;
      username: string;
      rate_limit: number;
      all_tools: number;
      all_shops: number;
    };

export function identityFromUser(u: UserRow): McpIdentity {
  return {
    kind: 'user',
    id: u.id,
    username: u.username,
    rate_limit: u.rate_limit,
    all_tools: u.all_tools,
    all_shops: u.all_shops,
  };
}

function safeParseSchema(s: string | null): Record<string, unknown> {
  if (s) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
  }
  return { type: 'object', properties: {} };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// ---------- 限流（每用户滑动窗口） ----------

const rateWindows = new Map<number, number[]>();
function checkRateLimit(userId: number, limitPerMin: number): boolean {
  if (!limitPerMin || limitPerMin <= 0) return true;
  const now = Date.now();
  const arr = (rateWindows.get(userId) ?? []).filter((t) => t > now - 60_000);
  if (arr.length >= limitPerMin) {
    rateWindows.set(userId, arr);
    return false;
  }
  arr.push(now);
  rateWindows.set(userId, arr);
  return true;
}

// ---------- 店铺参数校验 ----------

const SHOP_PARAM_KEYS = new Set([
  'sid',
  'sids',
  'store_id',
  'store_ids',
  'shop_id',
  'shop_ids',
  'profile_id',
  'profile_ids',
]);

function extractShopValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 3 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const part of value.split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractShopValues(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SHOP_PARAM_KEYS.has(k.toLowerCase())) extractShopValues(v, out, depth + 1);
      else extractShopValues(v, out, depth + 1);
    }
  }
}

function collectShopRefs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  // 仅扫描顶层与一层嵌套对象的店铺字段，避免误伤列表内容
  for (const [k, v] of Object.entries(args)) {
    if (SHOP_PARAM_KEYS.has(k.toLowerCase())) {
      extractShopValues(v, out, 0);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (SHOP_PARAM_KEYS.has(k2.toLowerCase())) extractShopValues(v2, out, 0);
      }
    }
  }
  return [...new Set(out)];
}

// ---------- 上游调用（code-102 自动刷新 Schema 重试） ----------

const SCHEMA_STALE_RE = /工具参数定义已更新|"code"\s*:\s*102/;

function respText(resp: any): string {
  const content = resp?.result?.content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  }
  return '';
}

async function callUpstreamTool(
  client: ReturnType<typeof getUpstreamClient>,
  toolId: string,
  args: Record<string, unknown>
): Promise<any> {
  let resp: any;
  try {
    resp = await client.callTool('action', { toolId, params: args });
  } catch (e: any) {
    if (SCHEMA_STALE_RE.test(String(e?.message || e))) {
      await refreshToolSchema(client, toolId);
      return await client.callTool('action', { toolId, params: args });
    }
    throw e;
  }
  // 上游可能把业务错误（code 102 Schema 过期）包在成功响应的 text 里，需检查内容后重试
  if (SCHEMA_STALE_RE.test(respText(resp))) {
    await refreshToolSchema(client, toolId);
    resp = await client.callTool('action', { toolId, params: args });
  }
  return resp;
}

// ---------- 主处理 ----------

export async function handleMcpRequest(req: Request, res: Response, identity: McpIdentity): Promise<void> {
  const server = new Server(
    { name: 'lxmcpgl-gateway', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let rows: Array<{ exposed_name: string; name: string; description: string; input_schema: string | null }>;
    if (identity.kind === 'admin') {
      rows = db
        .prepare('SELECT exposed_name, name, description, input_schema FROM tools WHERE enabled = 1 ORDER BY tool_id')
        .all() as any[];
    } else {
      if (!identity.all_tools) {
        const allowed = new Set(getUserToolIds(identity.id));
        const all = db
          .prepare('SELECT tool_id, exposed_name, name, description, input_schema FROM tools WHERE enabled = 1 ORDER BY tool_id')
          .all() as any[];
        rows = all.filter((r) => allowed.has(r.tool_id));
      } else {
        rows = db
          .prepare('SELECT exposed_name, name, description, input_schema FROM tools WHERE enabled = 1 ORDER BY tool_id')
          .all() as any[];
      }
    }
    return {
      tools: rows.map((r) => ({
        name: r.exposed_name,
        description: r.description || r.name || r.exposed_name,
        inputSchema: safeParseSchema(r.input_schema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params.name ?? '');
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // 预先抽取店铺引用（后续可能要返回错误，提前提取好用于日志）
    const shopRefs = collectShopRefs(args);

    // 日志元信息（贯穿整个 handler）
    const logCtx = {
      caller: identity.kind === 'admin' ? 'admin' : identity.username,
      userId: identity.kind === 'user' ? identity.id : null,
      toolName: name,
      toolId: null as string | null,
      toolType: null as string | null,
      shopRefs,
      started: Date.now(),
    };

    function logOutcome(success: boolean, isError: boolean, error?: string): void {
      insertCallLog({
        caller: logCtx.caller,
        user_id: logCtx.userId,
        tool_name: logCtx.toolName,
        tool_id: logCtx.toolId,
        tool_type: logCtx.toolType,
        shop_refs: logCtx.shopRefs.length > 0 ? logCtx.shopRefs : null,
        success,
        is_error: isError,
        duration_ms: Date.now() - logCtx.started,
        error: error ?? null,
      });
    }

    // ---- 身份与限流 ----
    if (identity.kind === 'user') {
      const u = db.prepare('SELECT enabled FROM users WHERE id = ?').get(identity.id) as { enabled: number } | undefined;
      if (!u || !u.enabled) { logOutcome(false, true, '账号已停用'); return errorResult('账号已被停用'); }
      if (!checkRateLimit(identity.id, identity.rate_limit)) {
        logOutcome(false, true, `限流 ${identity.rate_limit}/分钟`);
        return errorResult(`调用过于频繁：当前限速 ${identity.rate_limit} 次/分钟`);
      }
      touchUser(identity.id);
    }

    const tool = getToolByExposedName(name);
    if (!tool || !tool.enabled) { logOutcome(false, true, '工具不存在或未启用'); return errorResult(`工具不存在或未启用: ${name}`); }
    logCtx.toolId = tool.tool_id;
    logCtx.toolType = tool.tool_type;

    // 用户工具白名单
    if (identity.kind === 'user' && !identity.all_tools) {
      const allowed = getUserToolIds(identity.id);
      if (!allowed.includes(tool.tool_id)) {
        logOutcome(false, true, '无权使用该工具');
        return errorResult(`无权使用该工具: ${name}`);
      }
    }

    // write 工具管控
    if (identity.kind === 'user' && tool.tool_type === 'write' && getSetting('block_write') === '1') {
      logOutcome(false, true, 'block_write 禁止写操作');
      return errorResult(`该工具为写操作，已被网关禁用: ${name}`);
    }

    if (!getSetting('upstream_key')) {
      logOutcome(false, true, '网关未配置上游密钥');
      return errorResult('网关未配置上游密钥，请管理员在 Web 后台完成配置');
    }

    // 店铺级校验（仅对运营用户生效）
    if (identity.kind === 'user' && !identity.all_shops && shopRefs.length > 0) {
      const allowedShops = new Set(getUserShopIds(identity.id));
      const denied = shopRefs.filter((r) => !allowedShops.has(r));
      if (denied.length > 0) {
        logOutcome(false, true, `无权访问店铺: ${denied.join(',')}`);
        return errorResult(`无权访问以下店铺: ${denied.join(', ')}`);
      }
    }

    // ---- 调用上游 ----
    const caller = logCtx.caller;
    try {
      const client = getUpstreamClient(getSetting('upstream_url'), getSetting('upstream_key'));
      const resp = await callUpstreamTool(client, tool.tool_id, args);
      const duration = Date.now() - logCtx.started;
      if (resp?.error) {
        const msg = String(resp.error).slice(0, 500);
        console.error(`[mcp] ${caller} ${name} 上游错误 (${duration}ms): ${msg.slice(0, 200)}`);
        logOutcome(false, true, msg);
        return errorResult(`上游错误: ${msg}`);
      }
      const content = resp?.result?.content;
      console.log(`[mcp] ${caller} ${name} ok ${duration}ms`);
      logOutcome(true, false);
      if (Array.isArray(content)) return { content };
      logOutcome(false, true, '上游返回为空');
      return errorResult('上游返回为空');
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      console.error(`[mcp] ${caller} ${name} 调用失败: ${msg.slice(0, 300)}`);
      logOutcome(false, true, msg);
      return errorResult(`调用失败: ${msg}`);
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
