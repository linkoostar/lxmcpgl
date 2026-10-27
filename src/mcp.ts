import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import {
  db,
  getSetting,
  getToolByExposedName,
  getUserToolIds,
  getUserShopIds,
  touchUser,
  insertCallLog,
  listUpstreams,
  getUpstreamToolCounts,
  parseUpstreamHeaders,
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
  | { kind: 'admin'; upstream: string }
  | {
      kind: 'user';
      id: number;
      username: string;
      upstream: string;
      rate_limit: number;
      all_tools: number;
      all_shops: number;
    };

/** 把 users.upstream 解析成用户可访问的 upstream id 数组
 *  - '' / NULL / '*' → 空数组表示「全部 active upstream」
 *  - 'lingxing,xiyou' → ['lingxing', 'xiyou']
 *  - 'lingxing' → ['lingxing']（旧行为兼容）
 */
export function resolveUserUpstreams(raw: string | undefined | null, activeIds: string[]): string[] {
  const val = (raw ?? '').trim();
  if (!val || val === '*') return activeIds;
  const list = val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 过滤掉已经不存在或停用的 upstream
  return list.filter((id) => activeIds.includes(id));
}

/** 判断 tool.upstream 是否在用户可访问范围里（空范围 = 全部） */
export function canUseUpstream(userScope: string[], toolUpstream: string): boolean {
  if (!userScope.length) return true; // 空范围 = 全部
  return userScope.includes(toolUpstream);
}

export function identityFromUser(u: UserRow): McpIdentity {
  return {
    kind: 'user',
    id: u.id,
    username: u.username,
    upstream: u.upstream ?? '',
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
// 注意：profile_id / profile_ids 是 Amazon 广告体系的 profile ID，和领星 shop sid 完全不同！
// 不能和 shop sid 混在一个白名单比对里 —— profile_id 暂不参与 shop 级校验（shops 表无映射）。

const SHOP_SID_KEYS = new Set([
  'sid',
  'sids',
  'store_id',
  'store_ids',
  'shop_id',
  'shop_ids',
]);

const SELLER_ID_KEYS = new Set([
  'seller_id',
  'seller_ids',
]);

const SHOP_PARAM_KEYS = new Set([...SHOP_SID_KEYS, ...SELLER_ID_KEYS]);

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

// ---------- 店铺结果过滤 ----------
// 上游返回的 content[].text 通常是 JSON 字符串 {code, data:{list:[...],...}} 或直接 {list:[...]}
// 递归识别数组中每个元素的店铺标识字段（sid / shop_id / profile_id / seller_id / id + country_code 等），
// 把不在 allowedShops 里的条目过滤掉。返回一个新的 JSON 字符串；解析失败就原样返回。

const SHOP_ID_KEYS = new Set([
  'sid', 'shop_id', 'shop_ids', 'store_id', 'store_ids',
  'shop_sids',
]);

/** 从一个对象里抽取所有店铺标识 */
function extractShopIdsFromObj(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (SHOP_ID_KEYS.has(key) && v != null && v !== '') {
      if (Array.isArray(v)) out.push(...v.map(String));
      else out.push(String(v));
    }
    // 领星的 get_my_sids 返回里 id 字段也常是店铺 id（country_code + name 一起出现时判定）
    if ((key === 'id' || key === 'shop_id') && typeof v !== 'object') {
      // 保守：仅当对象里同时出现 name / country_code 时把 id 当作店铺标识
      if ('name' in obj || 'country_code' in obj) out.push(String(v));
    }
  }
  return out;
}

function filterShopListInNode(node: unknown, allowedShops: Set<string>): unknown {
  if (Array.isArray(node)) {
    // 先尝试把这个数组当作候选店铺列表 —— 如果首元素有店铺标识字段，就用 allowedShops 过滤
    if (node.length > 0 && node[0] && typeof node[0] === 'object') {
      const first = node[0] as Record<string, unknown>;
      if (SHOP_ID_KEYS.has(
        Object.keys(first).some((k) => SHOP_ID_KEYS.has(k.toLowerCase()))
          ? Object.keys(first).find((k) => SHOP_ID_KEYS.has(k.toLowerCase()))!.toLowerCase()
          : ''
      ) || ('country_code' in first && 'name' in first)) {
        return node.filter((item) => {
          const ids = extractShopIdsFromObj(item as Record<string, unknown>);
          // 任何一个标识命中白名单就通过（兼容一条数据含多个店铺 id 的情况）
          if (ids.length === 0) return true; // 无店铺标识则不过滤（保险）
          return ids.some((id) => allowedShops.has(id));
        });
      }
    }
    // 否则递归各元素
    return node.map((x) => filterShopListInNode(x, allowedShops));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = filterShopListInNode(v, allowedShops);
    }
    return out;
  }
  return node;
}

/** 对 MCP content 数组应用店铺白名单过滤。就地修改并返回新 content */
function filterContentByShops(content: unknown, allowedShops: Set<string>): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object') return part;
    if (typeof part.text !== 'string') return part;
    try {
      const parsed = JSON.parse(part.text);
      const filtered = filterShopListInNode(parsed, allowedShops);
      return { ...part, text: JSON.stringify(filtered) };
    } catch {
      return part; // 非 JSON 文本原样返回
    }
  });
}

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
  // 构建动态 serverInfo — 让 Agent 启动时一眼知道网关聚合了哪些上游
  const upstreams = listUpstreams().filter((u) => u.active);
  const toolCounts = getUpstreamToolCounts();
  const upstreamDesc = upstreams
    .map((u) => `${u.name}（${u.notes || '无描述'}，${toolCounts[u.id] ?? 0} 工具）`)
    .join('；');
  const totalTools = upstreams.reduce((sum, u) => sum + (toolCounts[u.id] ?? 0), 0);
  const serverDesc = `方中 MCP 网关，聚合 ${upstreams.length} 个上游 · ${totalTools} 工具：${upstreamDesc}`;

  const server = new Server(
    { name: 'fangzhong-mcp-gateway', version: '1.0.0', description: serverDesc },
    { capabilities: { tools: { listChanged: false } } }
  );

  // 覆盖 SDK 默认的 initialize handler — 返回动态 serverInfo
  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: '2025-03-26',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: '方中 MCP 网关', version: '1.0.0' },
    _meta: undefined,
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // 先查 active upstream 列表，用于给每个工具打 tag + 解析用户 upstream 范围
    const activeUpIds = upstreams.map((u) => u.id);
    const upMap = new Map(upstreams.map((u) => [u.id, { name: u.name, notes: u.notes }]));

    let rows: Array<{ upstream: string; exposed_name: string; name: string; description: string; input_schema: string | null }>;
    if (identity.kind === 'admin') {
      rows = db
        .prepare('SELECT upstream, exposed_name, name, description, input_schema FROM tools WHERE enabled = 1 ORDER BY upstream, tool_id')
        .all() as any[];
    } else {
      // 用户 upstream 范围：空/NULL/'*' = 全部 active，逗号分隔 = 指定子集
      const userScope = resolveUserUpstreams(identity.upstream, activeUpIds);
      // 用 IN 查询跨 upstream 拉取
      const placeholders = userScope.length ? userScope.map(() => '?').join(',') : null;
      const sqlBase =
        'SELECT upstream, tool_id, exposed_name, name, description, input_schema FROM tools WHERE enabled = 1';
      const sql = placeholders ? `${sqlBase} AND upstream IN (${placeholders}) ORDER BY upstream, tool_id`
                               : `${sqlBase} ORDER BY upstream, tool_id`;
      const args = placeholders ? userScope : [];
      const all = db.prepare(sql).all(...args) as any[];

      if (!identity.all_tools) {
        const allowed = new Set(getUserToolIds(identity.id));
        rows = all.filter((r) => allowed.has(r.tool_id));
      } else {
        rows = all;
      }
    }
    return {
      tools: rows.map((r) => {
        const upInfo = upMap.get(r.upstream);
        const upstreamName = upInfo?.name ?? r.upstream;
        const upstreamDesc = upInfo?.notes ?? '';
        // 在 description 开头注入「来源」，LLM 一眼就能按域分组
        const descPrefix = upstreamDesc ? `[来自 ${upstreamName} · ${upstreamDesc}] ` : `[来自 ${upstreamName}] `;
        const rawDesc = r.description || r.name || r.exposed_name;
        return {
          name: r.exposed_name,
          description: descPrefix + rawDesc,
          inputSchema: safeParseSchema(r.input_schema),
          // 非标准扩展字段，Agent/客户端如果认 MCP tools 里的自定义字段可以直接用
          _upstream: r.upstream,
          _upstream_name: upstreamName,
          _upstream_desc: upstreamDesc,
        };
      }),
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
    // shop sid 白名单（sid / store_id / shop_id）—— 直接比对
    // seller_id 校验 —— 查 shops 表：这个 seller_id 关联的 shop sid 是否在白名单里
    if (identity.kind === 'user' && !identity.all_shops && shopRefs.length > 0) {
      const allowedShopIds = new Set(getUserShopIds(identity.id));
      // 上游所有 seller_id → shop sid 映射（缓存到 handler 内）
      const sellerToSids = new Map<string, Set<string>>();
      const sellerRows = db.prepare('SELECT seller_id, sid FROM shops').all() as Array<{ seller_id: string; sid: string }>;
      for (const row of sellerRows) {
        if (!row.seller_id) continue; // 过滤空值
        let set = sellerToSids.get(row.seller_id);
        if (!set) { set = new Set(); sellerToSids.set(row.seller_id, set); }
        set.add(row.sid);
      }

      const denied: string[] = [];
      for (const ref of shopRefs) {
        // 如果 ref 是 seller_id 格式（Amazon seller_id 通常 14-22 字符大写字母+数字）
        const isSellerId = sellerToSids.has(ref) || /^[A-Z0-9]{10,30}$/.test(ref);
        if (isSellerId) {
          // seller_id：映射到 shop sid 再比对
          const mapped = sellerToSids.get(ref);
          if (!mapped || ![...mapped].some((s) => allowedShopIds.has(s))) {
            denied.push(ref);
          }
        } else {
          // 默认当作 shop sid 直接比对
          if (!allowedShopIds.has(ref)) denied.push(ref);
        }
      }
      if (denied.length > 0) {
        logOutcome(false, true, `无权访问店铺: ${denied.join(',')}`);
        return errorResult(`无权访问以下店铺: ${denied.join(', ')}`);
      }
    }

    // ---- 调用上游（按 adapter 路由）----
    const caller = logCtx.caller;
    // 不管 admin 还是运营用户，都按 tool.upstream 路由（list 里已经过滤过权限了）
    const upId = tool.upstream ?? identity.upstream;
    // 额外校验：运营用户必须有这个 upstream 权限（防止 tools/call 被绕过）
    if (identity.kind === 'user') {
      const activeUpIds = upstreams.map((u) => u.id);
      const userScope = resolveUserUpstreams(identity.upstream, activeUpIds);
      if (!canUseUpstream(userScope, upId)) {
        logOutcome(false, true, `上游 ${upId} 不在用户权限范围`);
        return errorResult(`无权访问上游 ${upId}`);
      }
    }
    const upConfig = db.prepare('SELECT * FROM upstreams WHERE id = ?').get(upId) as any;
    if (!upConfig || !upConfig.active) {
      logOutcome(false, true, `上游 ${upId} 未启用`);
      return errorResult(`上游 ${upId} 未配置或已停用`);
    }
    // api_key 必填 — 除非 upstream 已经配置了自定义 headers 鉴权（如 NocoDB/ABA搜索词用 x-api-key）
    const hasCustomHeaders = Object.keys(parseUpstreamHeaders(upConfig)).length > 0;
    if (!upConfig.api_key && !hasCustomHeaders) {
      logOutcome(false, true, '上游未配置 API Key');
      return errorResult(`上游 ${upConfig.name} 未配置 API Key 或鉴权 Headers，请联系管理员`);
    }
    try {
      // 延迟 import 避免循环依赖
      const { getAdapter } = await import('./adapter.js');
      const adapter = getAdapter(upConfig);
      const callResult = await adapter.callTool(upConfig, tool.tool_id, args);
      const duration = Date.now() - logCtx.started;

      // cost_logs 写入（上游付费分摊）
      const cost = adapter.extractCost(callResult.content?.[0]?.text);
      if (cost !== null) {
        db.prepare(
          'INSERT INTO cost_logs (upstream, user_id, tool_name, tool_id, cost_credits, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(identity.upstream, identity.kind === 'user' ? identity.id : null, tool.exposed_name, tool.tool_id, cost, duration, new Date().toISOString());
      }

      if (callResult.isError) {
        const msg = callResult.content?.[0]?.text?.slice(0, 500) ?? '上游返回错误';
        console.error(`[mcp] ${caller} ${name} 上游错误 (${duration}ms): ${msg.slice(0, 200)}`);
        logOutcome(false, true, msg);
        return errorResult(`上游错误: ${msg.slice(0, 200)}`);
      }
      const content = callResult.content;
      console.log(`[mcp] ${caller} ${name} ok ${duration}ms upstream=${identity.upstream}`);
      logOutcome(true, false);

      // 店铺结果过滤
      if (Array.isArray(content)) {
        let filteredContent: unknown = content;
        if (identity.kind === 'user' && !identity.all_shops) {
          const allowedShops = new Set(getUserShopIds(identity.id));
          filteredContent = filterContentByShops(content, allowedShops);
        }
        return { content: filteredContent as any[] };
      }
      logOutcome(false, true, '上游返回为空');
      return errorResult('上游返回为空');
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      console.error(`[mcp] ${caller} ${name} 调用失败: ${msg.slice(0, 300)} upstream=${identity.upstream}`);
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
