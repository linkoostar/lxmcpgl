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
  parseUpstreamHeaders,
  type UserRow,
} from './db.js';
import { getUpstreamClient } from './upstream.js';
import { refreshToolSchema } from './sync.js';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';

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

/** 用户可访问的 upstream 范围（fail-closed 语义） */
export interface UpstreamScope {
  /** true = 显式全部（'' / NULL / '*'），ids 为当前 active upstream 全集 */
  all: boolean;
  /** 实际可访问的 upstream id 集合；空数组 = 无任何权限 */
  ids: string[];
}

/**
 * 把 users.upstream 解析成用户可访问的 upstream 范围
 *  - '' / NULL / '*' → 全部 active upstream
 *  - 'lingxing,xiyou' → ['lingxing', 'xiyou']（只保留 active）
 *  - 解析结果为空 / 全部无效 → ids = []（无权限，不再 fail-open）
 */
export function resolveUserUpstreams(raw: string | undefined | null, activeIds: string[]): UpstreamScope {
  const val = (raw ?? '').trim();
  if (!val || val === '*') return { all: true, ids: [...activeIds] };
  const list = val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 过滤掉已经不存在或停用的 upstream
  return { all: false, ids: list.filter((id) => activeIds.includes(id)) };
}

/** 判断 tool.upstream 是否在用户可访问范围里（空范围 = 无权限） */
export function canUseUpstream(scope: UpstreamScope, toolUpstream: string): boolean {
  return scope.ids.includes(toolUpstream);
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

/**
 * 工具定义版本哈希：只依赖 active upstream 的 (upstream, tool_id, updated_at, schema)。
 * 客户端缓存 tools/list 后，可通过该 hash 判断定义是否变化。
 */
export function toolsHashOf(activeUpstreams: Array<{ id: string }>): string {
  const ids = activeUpstreams.map((u) => u.id);
  if (ids.length === 0) return '';
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT upstream, tool_id, updated_at, input_schema FROM tools
       WHERE enabled = 1 AND upstream IN (${ph}) ORDER BY upstream, tool_id`
    )
    .all(...ids) as Array<{ upstream: string; tool_id: string; updated_at: string | null; input_schema: string | null }>;
  return createHash('sha256')
    .update(rows.map((r) => `${r.upstream}\u0000${r.tool_id}\u0000${r.updated_at ?? ''}\u0000${r.input_schema ?? ''}`).join('\u0001'))
    .digest('hex')
    .slice(0, 16);
}

function errorResult(message: string, extra: Record<string, unknown> = {}) {
  // 统一错误信封：{ error: { code, type, message, upstream, tool, upstream_code, trace_id, field, expected, got } }
  const body: Record<string, unknown> = {
    code: extra.type === 'invalid_params' ? -32602 : -32000,
    type: extra.type ?? 'gateway_error',
    message,
    ...extra,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }], isError: true };
}

// ---------- 参数预校验（按 tools/list 公示的 schema，保守策略） ----------

interface ValidationIssue {
  field: string;
  expected: string;
  got: string;
  message: string;
}

/** ID 类字段：上游常见「字符串逗号分隔」与「数组」两种约定，不做类型拦截 */
const FLEX_FIELD_RE =
  /(^|_)(id|ids|sid|sids|asin|asins|sku|skus|fid|fids|pid|pids|seller_id|seller_ids|profile_id|profile_ids|account_id|account_ids|shop_id|shop_ids|store_id|store_ids|pvi_ids)($|_)/i;

function jsonTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeLabel(t: unknown): string {
  if (Array.isArray(t)) return t.map(String).join('|');
  return String(t ?? 'unknown');
}

function matchesSchemaType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true; // 未知类型不拦
  }
}

/**
 * 保守校验：必填 + 枚举 + 明确的基础类型。
 * 故意不做 anyOf/oneOf/$ref/additionalProperties 校验，避免按上游错误的 schema 误拦。
 */
function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): ValidationIssue | null {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [];
  for (const f of required) {
    if (!(f in args) || args[f] === undefined) {
      return { field: f, expected: '必填', got: 'undefined', message: `缺少必填参数 ${f}` };
    }
  }
  const props =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, any>)
      : {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const ps = props[k];
    if (!ps || typeof ps !== 'object') continue;
    // 复合 schema 无法可靠判断，跳过
    if (ps.anyOf || ps.oneOf || ps.allOf || ps.$ref) continue;
    if (Array.isArray(ps.enum) && ps.enum.length > 0) {
      const hit = ps.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v));
      if (!hit) {
        return {
          field: k,
          expected: `枚举 ${ps.enum.map((x: unknown) => JSON.stringify(x)).join('|')}`,
          got: `${jsonTypeName(v)} ${JSON.stringify(v)?.slice(0, 60)}`,
          message: `参数 ${k} 取值不在允许范围`,
        };
      }
    }
    // ID 类字段放宽（string 与 array 都放行）
    if (FLEX_FIELD_RE.test(k)) continue;
    const t = ps.type;
    if (!t) continue;
    const ok = Array.isArray(t)
      ? t.some((x: unknown) => matchesSchemaType(v, String(x)))
      : matchesSchemaType(v, String(t));
    if (!ok) {
      return {
        field: k,
        expected: typeLabel(t),
        got: jsonTypeName(v),
        message: `参数 ${k} 类型应为 ${typeLabel(t)}，实际为 ${jsonTypeName(v)}`,
      };
    }
  }
  return null;
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

/** 从一个对象里抽取店铺标识（只认明确的店铺字段，避免把商品/活动自身的 id 误判成店铺） */
function extractShopIdsFromObj(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (SHOP_ID_KEYS.has(key) && v != null && v !== '') {
      if (Array.isArray(v)) out.push(...v.map(String));
      else out.push(String(v));
    }
    // 领星的 get_my_sids 用 id 表示店铺 id：仅当同一对象里出现 country_code 时才认定
    if (key === 'id' && typeof v !== 'object' && v !== null && 'country_code' in obj) {
      out.push(String(v));
    }
  }
  return out;
}

/** 只有店铺维度上游（领星元工具模式）的响应才有「按店铺隔离」的语义 */
function isShopScopedUpstream(upstreamId: string): boolean {
  if (!upstreamId) return false;
  const row = db.prepare('SELECT adapter FROM upstreams WHERE id = ?').get(upstreamId) as { adapter?: string } | undefined;
  return row?.adapter === 'lingxing-meta';
}

interface ShopFilterStat {
  removed: number;
}

/**
 * 店铺白名单裁剪：只删除「明确属于其他店铺」的行。
 * - 行内带 sid / shop_id / store_id 等店铺标识且全部不在白名单 → 删除并计数
 * - 行内没有任何店铺标识（汇总行、或无店铺维度的数据）→ 保留，不做猜测
 *
 * 历史教训：之前的 fail-closed 版本会把「整段没有店铺标识的主结果集」清空，
 * 导致上游明明返回了数据，下游却看到空数组 + 总数正确，属于静默丢数据。
 */
function filterShopListInNode(node: unknown, allowedShops: Set<string>, stat: ShopFilterStat): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const ids = extractShopIdsFromObj(item as Record<string, unknown>);
        if (ids.length > 0 && !ids.some((id) => allowedShops.has(id))) {
          stat.removed += 1;
          continue; // 明确属于未授权店铺，剔除
        }
      }
      out.push(filterShopListInNode(item, allowedShops, stat));
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = filterShopListInNode(v, allowedShops, stat);
    }
    return out;
  }
  return node;
}

/** 对 MCP content 数组应用店铺白名单裁剪，返回新 content 与裁剪统计 */
function filterContentByShops(content: unknown, allowedShops: Set<string>, stat: ShopFilterStat): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object') return part;
    if (typeof part.text !== 'string') return part;
    try {
      const parsed = JSON.parse(part.text);
      const filtered = filterShopListInNode(parsed, allowedShops, stat);
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

// ---------- 上游响应清理（内网地址） ----------
// NocoDB 等上游的分页字段（next/prev）会返回带内网地址、baseId、tableId 的绝对 URL，
// 这些地址下游既访问不到、也不该暴露，统一移除值为内网 URL 的字段。

const INTERNAL_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/|$)/i;

function stripInternalUrlsInNode(node: unknown, stat: { removed: number }): unknown {
  if (Array.isArray(node)) return node.map((x) => stripInternalUrlsInNode(x, stat));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string' && INTERNAL_URL_RE.test(v.trim())) {
        stat.removed += 1;
        continue; // 内网 URL 字段整条丢弃
      }
      out[k] = stripInternalUrlsInNode(v, stat);
    }
    return out;
  }
  return node;
}

/** 清理 MCP content 里 JSON 文本中的内网 URL 字段 */
function stripInternalUrlsInContent(content: unknown, stat: { removed: number }): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    try {
      const parsed = JSON.parse(part.text);
      return { ...part, text: JSON.stringify(stripInternalUrlsInNode(parsed, stat)) };
    } catch {
      return part;
    }
  });
}

/** 上游已知问题标注：让 Agent 在 tools/list 阶段就知道这些工具当前不可靠 */
const TOOL_CAVEATS: Record<string, string> = {
  'lingxing:platform_store_report_list': '⚠️ 上游已知问题：该接口常返回空/不可用数据，不要据此判断店铺业绩。',
  'lingxing:platform_walmart_bill_statement_list': '⚠️ 前置条件：需先在领星完成沃尔玛店铺授权与账期同步，否则返回空列表。',
};

// ---------- 主处理 ----------

export async function handleMcpRequest(req: Request, res: Response, identity: McpIdentity): Promise<void> {
  // 构建动态 serverInfo — 让 Agent 启动时一眼知道网关聚合了哪些上游
  const upstreams = listUpstreams().filter((u) => u.active);
  // 只统计「已启用 + 上游 active」的工具，必须和 tools/list 实际暴露的数量一致
  const toolCounts: Record<string, number> = {};
  if (upstreams.length > 0) {
    const ph = upstreams.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT upstream, COUNT(*) AS c FROM tools WHERE enabled = 1 AND upstream IN (${ph}) GROUP BY upstream`)
      .all(...upstreams.map((u) => u.id)) as Array<{ upstream: string; c: number }>;
    for (const r of rows) toolCounts[r.upstream] = r.c;
  }
  const upstreamDesc = upstreams
    .map((u) => `${u.name}（${u.notes || '无描述'}，${toolCounts[u.id] ?? 0} 工具）`)
    .join('；');
  const totalTools = upstreams.reduce((sum, u) => sum + (toolCounts[u.id] ?? 0), 0);
  const serverDesc = `方中 MCP 网关，聚合 ${upstreams.length} 个上游 · ${totalTools} 工具：${upstreamDesc}`;

  const server = new Server(
    { name: 'fangzhong-mcp-gateway', version: config.version, description: serverDesc },
    { capabilities: { tools: { listChanged: false } } }
  );

  // 覆盖 SDK 默认的 initialize handler — 返回动态 serverInfo + instructions
  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: '2025-03-26',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: '方中 MCP 网关', version: config.version },
    // MCP 标准字段：客户端会把这段说明带给模型，用于判断该网关能提供哪些数据域
    instructions: serverDesc,
    _meta: { tools_hash: toolsHashOf(upstreams) },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // 先查 active upstream 列表，用于给每个工具打 tag + 解析用户 upstream 范围
    const activeUpIds = upstreams.map((u) => u.id);
    const upMap = new Map(upstreams.map((u) => [u.id, { name: u.name, notes: u.notes }]));

    let rows: Array<{ upstream: string; tool_id: string; exposed_name: string; name: string; description: string; input_schema: string | null; updated_at: string | null }>;
    if (identity.kind === 'admin') {
      // admin 也只看「启用中且归属 active upstream」的工具，停用上游的历史工具不该被下游看到
      rows = db
        .prepare(`SELECT t.upstream, t.tool_id, t.exposed_name, t.name, t.description, t.input_schema, t.updated_at
                  FROM tools t
                  JOIN upstreams u ON u.id = t.upstream
                  WHERE t.enabled = 1 AND u.active = 1
                  ORDER BY t.upstream, t.tool_id`)
        .all() as any[];
    } else {
      // 用户 upstream 范围：空/NULL/'*' = 全部 active，逗号分隔 = 指定子集
      // fail-closed：解析结果为空表示「无任何权限」，必须直接返回空清单
      const scope = resolveUserUpstreams(identity.upstream, activeUpIds);
      if (scope.ids.length === 0) return { tools: [] };
      const placeholders = scope.ids.map(() => '?').join(',');
      const all = db
        .prepare(
          `SELECT upstream, tool_id, exposed_name, name, description, input_schema, updated_at FROM tools
           WHERE enabled = 1 AND upstream IN (${placeholders}) ORDER BY upstream, tool_id`
        )
        .all(...scope.ids) as any[];

      if (!identity.all_tools) {
        const allowed = new Set(getUserToolIds(identity.id));
        rows = all.filter((r) => allowed.has(r.tool_id));
      } else {
        rows = all;
      }
    }

    // 同一 exposed_name 命中多个 upstream 时，加 `upstream__` 前缀避免 Agent 调错上游
    const nameCount = new Map<string, number>();
    for (const r of rows) nameCount.set(r.exposed_name, (nameCount.get(r.exposed_name) ?? 0) + 1);
    const exposedNameOf = (r: { upstream: string; exposed_name: string }): string =>
      (nameCount.get(r.exposed_name) ?? 0) > 1 ? `${r.upstream}__${r.exposed_name}` : r.exposed_name;

    return {
      tools: rows.map((r) => {
        const upInfo = upMap.get(r.upstream);
        const upstreamName = upInfo?.name ?? r.upstream;
        const upstreamDesc = upInfo?.notes ?? '';
        // 在 description 开头注入「来源」，LLM 一眼就能按域分组
        const descPrefix = upstreamDesc ? `[来自 ${upstreamName} · ${upstreamDesc}] ` : `[来自 ${upstreamName}] `;
        const rawDesc = r.description || r.name || r.exposed_name;
        const caveat = TOOL_CAVEATS[`${r.upstream}:${r.tool_id}`];
        return {
          name: exposedNameOf(r),
          description: descPrefix + (caveat ? `${caveat} ` : '') + rawDesc,
          inputSchema: safeParseSchema(r.input_schema),
          // 非标准扩展字段，Agent/客户端如果认 MCP tools 里的自定义字段可以直接用
          _upstream: r.upstream,
          _upstream_name: upstreamName,
          _upstream_desc: upstreamDesc,
        };
      }),
      // 定义版本信息：客户端可据此判断缓存是否过期（listChanged=false 时不推送变更）
      _meta: {
        tools_hash: toolsHashOf(upstreams),
        tools_count: rows.length,
        synced_at: rows.reduce<string | null>((acc, r) => (r.updated_at && (!acc || r.updated_at > acc) ? r.updated_at : acc), null),
        gateway_version: config.version,
      },
    } as any;
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
      upstream: '' as string, // 路由到 upstream 时覆盖
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
        upstream: logCtx.upstream,
        shop_refs: logCtx.shopRefs.length > 0 ? logCtx.shopRefs : null,
        success,
        is_error: isError,
        duration_ms: Date.now() - logCtx.started,
        error: error ?? null,
      });
    }

    // 调用者可见的 upstream 范围（admin = 全部 active；用户 = users.upstream，fail-closed）
    const activeUpIds = upstreams.map((u) => u.id);
    const scope: UpstreamScope =
      identity.kind === 'admin'
        ? { all: true, ids: [...activeUpIds] }
        : resolveUserUpstreams(identity.upstream, activeUpIds);

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

    // 只在调用者可见的 upstream 范围内按暴露名解析工具（防止跨上游越权）
    const tool = getToolByExposedName(name, scope.ids);
    if (!tool || !tool.enabled) { logOutcome(false, true, '工具不存在或未启用'); return errorResult(`工具不存在或未启用: ${name}`, { type: 'tool_not_found', tool: name }); }
    logCtx.toolId = tool.tool_id;
    logCtx.toolType = tool.tool_type;
    logCtx.upstream = tool.upstream ?? ''; // 后续所有 logOutcome 都写正确的 upstream

    // 用户工具白名单
    if (identity.kind === 'user' && !identity.all_tools) {
      const allowed = getUserToolIds(identity.id);
      if (!allowed.includes(tool.tool_id)) {
        logOutcome(false, true, '无权使用该工具');
        return errorResult(`无权使用该工具: ${name}`, { type: 'permission_denied', upstream: tool.upstream, tool: name });
      }
    }

    // write 工具管控
    if (identity.kind === 'user' && tool.tool_type === 'write' && getSetting('block_write') === '1') {
      logOutcome(false, true, 'block_write 禁止写操作');
      return errorResult(`该工具为写操作，已被网关禁用: ${name}`, { type: 'permission_denied', upstream: tool.upstream, tool: name });
    }

    // ---- 参数预校验 ----
    // 上游（尤其领星）会把所有参数问题压缩成 code:102，调用方无法定位字段。
    // 网关按 tools/list 公示的 schema 先做保守校验，直接返回字段路径。
    const validationIssue = validateArgs(safeParseSchema(tool.input_schema), args);
    if (validationIssue) {
      logOutcome(false, true, `参数校验失败: ${validationIssue.message}`);
      return errorResult(`参数校验失败: ${validationIssue.message}`, {
        type: 'invalid_params',
        upstream: tool.upstream,
        tool: name,
        field: validationIssue.field,
        expected: validationIssue.expected,
        got: validationIssue.got,
      });
    }

    // 店铺级校验（仅对运营用户 + 店铺维度上游生效）
    // 非店铺维度上游（西柚/NocoDB 等）的参数里即使出现 seller_id 之类字段，也与 shops 白名单无关
    if (identity.kind === 'user' && !identity.all_shops && shopRefs.length > 0 && isShopScopedUpstream(tool.upstream ?? '')) {
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
        return errorResult(`无权访问以下店铺: ${denied.join(', ')}`, {
          type: 'permission_denied',
          upstream: tool.upstream,
          tool: name,
          field: 'shop',
          denied,
        });
      }
    }

    // ---- 调用上游（按 adapter 路由）----
    const caller = logCtx.caller;
    // 不管 admin 还是运营用户，都按 tool.upstream 路由（list 里已经过滤过权限了）
    const upId = tool.upstream ?? '';
    if (!upId) {
      logOutcome(false, true, '工具缺少 upstream 归属');
      return errorResult(`工具缺少 upstream 归属: ${name}`);
    }
    // 额外校验：运营用户必须有这个 upstream 权限（防止 tools/call 被绕过）
    if (identity.kind === 'user' && !canUseUpstream(scope, upId)) {
      logOutcome(false, true, `上游 ${upId} 不在用户权限范围`);
      return errorResult(`无权访问上游 ${upId}`);
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
      let callResult = await adapter.callTool(upConfig, tool.tool_id, args);

      // ===== code=102 自动刷新 Schema + 重试一次 =====
      // 领星上游工具定义更新后旧 schema 会过期，返回 code=102（业务错误，包在 content 里）。
      // adapter 层的 detectBizErrorInContent 已经把它转成 upstreamError.code=102。
      // 这里检测到 102 就调用 refreshToolSchema 拉新 schema，再调一次。
      const bizCode = callResult.upstreamError?.code;
      const bizMsg = String(callResult.upstreamError?.message ?? callResult.content?.[0]?.text ?? '');
      if (bizCode === 102 || SCHEMA_STALE_RE.test(bizMsg)) {
        console.log(`[mcp] ${caller} ${name} 触发 schema 刷新（code=${bizCode}）`);
        try {
          await refreshToolSchema(getUpstreamClient(upConfig.url, upConfig.api_key ?? ''), tool.tool_id, upId);
          callResult = await adapter.callTool(upConfig, tool.tool_id, args);
          console.log(`[mcp] ${caller} ${name} 刷新 schema 后重试完成`);
        } catch (refreshErr: any) {
          console.warn(`[mcp] ${caller} ${name} schema 刷新异常: ${String(refreshErr?.message ?? refreshErr).slice(0, 200)}`);
        }
      }

      const duration = Date.now() - logCtx.started;

      // cost_logs 写入（上游付费分摊）
      const cost = adapter.extractCost(callResult.content?.[0]?.text);
      if (cost !== null) {
        db.prepare(
          'INSERT INTO cost_logs (upstream, user_id, tool_name, tool_id, cost_credits, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(upId, identity.kind === 'user' ? identity.id : null, tool.exposed_name, tool.tool_id, cost, duration, new Date().toISOString());
      }

      // ---- 统一错误信封：保留上游原始 code / traceId，便于定位 ----
      if (callResult.isError || callResult.upstreamError) {
        const ue = callResult.upstreamError;
        let parsed: any = null;
        const text = callResult.content?.find((c) => c.type === 'text')?.text;
        if (!ue && text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 非 JSON，保留原文 */
          }
        }
        // rawCode 多级 fallback：领星把业务码（如 102）包在 error.data.code 或 data.code 里
        // adapter 层已经优先挖 error.data.code 写入 ue.code，这里再覆盖 content 解析路径的多级嵌套
        const rawCode =
          ue?.code ??
          parsed?.data?.code ??
          parsed?.data?.data?.code ??
          parsed?.code ??
          parsed?.error?.data?.code ??
          parsed?.error?.code ??
          null;
        const traceId =
          ue?.trace_id ??
          parsed?.traceId ??
          parsed?.trace_id ??
          parsed?.data?.traceId ??
          parsed?.data?.trace_id ??
          parsed?.error?.data?.traceId ??
          null;
        const rawMsg =
          ue?.message ??
          parsed?.message ??
          parsed?.error?.message ??
          text ??
          '上游返回错误';
        const msg = String(rawMsg).slice(0, 500);
        console.error(
          `[mcp] ${caller} ${name} 上游错误 (${duration}ms) code=${String(rawCode)} trace=${String(traceId)}: ${msg.slice(0, 200)}`
        );
        logOutcome(false, true, `[${upId}] code=${String(rawCode)} ${msg}`.slice(0, 400));
        return errorResult(`上游返回错误: ${msg}`, {
          type: 'upstream_error',
          upstream: upId,
          tool: name,
          upstream_code: rawCode,
          trace_id: traceId,
          raw: parsed?.data ?? undefined,
        });
      }
      const content = callResult.content;
      console.log(`[mcp] ${caller} ${name} ok ${duration}ms upstream=${identity.upstream}`);
      logOutcome(true, false);

      // 店铺结果裁剪
      // 只对「店铺维度上游」生效：西柚/NocoDB 等上游没有店铺维度，结果必须原样返回
      if (Array.isArray(content)) {
        let filteredContent = content as any[];
        if (identity.kind === 'user' && !identity.all_shops && isShopScopedUpstream(upId)) {
          const allowedShops = new Set(getUserShopIds(identity.id));
          const stat: ShopFilterStat = { removed: 0 };
          filteredContent = filterContentByShops(content, allowedShops, stat) as any[];
          if (stat.removed > 0) {
            console.log(`[mcp] ${caller} ${name} 店铺裁剪 ${stat.removed} 行（allowed=${allowedShops.size}）`);
            filteredContent = [
              ...filteredContent,
              {
                type: 'text' as const,
                text: JSON.stringify({
                  __gateway_warn: `已按店铺权限过滤 ${stat.removed} 行不属于授权店铺的数据；上游的总数字段（total/recordsFiltered）不会随之变化，不能据其判断明细是否完整`,
                }),
              },
            ];
          }
        }
        // 清理响应里的内网地址（如 NocoDB 的 next 分页 URL 会带 192.168.x.x:port / baseId / tableId）
        const scrubStat = { removed: 0 };
        filteredContent = stripInternalUrlsInContent(filteredContent, scrubStat) as any[];
        if (scrubStat.removed > 0) {
          console.log(`[mcp] ${caller} ${name} 已移除 ${scrubStat.removed} 个内网 URL 字段`);
        }
        return { content: filteredContent };
      }
      logOutcome(false, true, '上游返回为空');
      return errorResult('上游返回为空');
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500);
      const timedOut = /timeout|timed out|aborted/i.test(msg);
      console.error(`[mcp] ${caller} ${name} 调用失败: ${msg.slice(0, 300)} upstream=${upId}`);
      logOutcome(false, true, `[${upId}] ${msg}`.slice(0, 400));
      return errorResult(`调用上游失败: ${msg}`, {
        type: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
        upstream: upId,
        tool: name,
      });
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
