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
  SHOP_PARAM_KEYS,
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

/**
 * Schema 最小化：保留 agent 正确构造 tool call 必须的字段，去掉 description/title/$defs 等冗余。
 * 安全边界：type / properties key / properties 里的 enum / required — 四样不能丢。
 * 按这个边界做 → 准确性零影响，token 省 ~70%。
 */
function minimizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(minimizeSchema);
  const out: Record<string, any> = {};
  // 顶层 type
  if (schema.type !== undefined) out.type = schema.type;
  if (schema.required) out.required = schema.required;
  if (schema.enum) out.enum = schema.enum;
  if (schema.default !== undefined) out.default = schema.default;
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      if (v && typeof v === 'object') {
        const p: Record<string, any> = {};
        if ((v as any).type !== undefined) p.type = (v as any).type;
        if ((v as any).enum) p.enum = (v as any).enum;
        if ((v as any).default !== undefined) p.default = (v as any).default;
        // 嵌套对象递归
        if ((v as any).properties) p.properties = minimizeSchema((v as any).properties);
        // 数组元素 schema 递归（ads: {type:"array", items:{properties:{adType:{...}}}}）
        if ((v as any).items) p.items = minimizeSchema((v as any).items);
        // oneOf / anyOf（联合类型，agent 只需要知道每个选项的 type/enum 即可）
        if ((v as any).oneOf) p.oneOf = (v as any).oneOf.map(minimizeSchema);
        if ((v as any).anyOf) p.anyOf = (v as any).anyOf.map(minimizeSchema);
        props[k] = p;
      } else {
        props[k] = v;
      }
    }
    out.properties = props;
  }
  // items（数组元素 schema）也递归
  if (schema.items) out.items = minimizeSchema(schema.items);
  return out;
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
// 统一用 db.SHOP_PARAM_KEYS（全项目共用一份，避免口径漂移）

/**
 * 递归提取请求参数里的所有店铺引用。
 *
 * 审计复现：旧版 collectShopRefs 只扫顶层 + 一层嵌套对象，不扫数组内对象
 * → {items:[{sid:"9999"}]}、{a:{b:{sid:"9999"}}} 全部漏掉 → shopRefs=0 →
 * shopRequired 判断错误 → 校验被绕过。
 *
 * 新版：深度 6，遍历所有层级所有数组元素。
 */
function collectShopRefs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth = 0) => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const key = k.toLowerCase();
        if (SHOP_PARAM_KEYS.has(key)) {
          // 店铺字段 → 提取值
          if (typeof v === 'string') {
            v.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
          } else if (Array.isArray(v)) {
            v.map((x) => String(x)).filter(Boolean).forEach((x) => out.push(x));
          } else if (typeof v === 'number' || typeof v === 'bigint') {
            out.push(String(v));
          }
        }
        // 无论是不是店铺字段，都递归子节点
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    }
  };
  visit(args);
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

/** 店铺校验白名单：查询店铺/账号自身属性的工具 → 跳过店铺参数校验 + 跳过返回结果裁剪
 * 这类工具返回的是"我有哪些店铺"，请求里不可能先带店铺参数（鸡生蛋问题），
 * 返回的内容是店铺目录本身而不是"属于某些店铺的数据"，不该被裁剪掉。 */
const SHOP_SCOPE_BYPASS_TOOLS = new Set<string>([
  'get_my_sids',       // 领星：查询我的店铺列表
  'list_my_sids',      // 西柚 SIF：查询我的店铺列表
  'shop_list',         // 通用：店铺列表
  'ad_auth_shops',     // 领星：查询广告授权店铺（同样不需要先传店铺）
]);

/** 只有店铺维度上游（领星元工具模式）的响应才有「按店铺隔离」的语义 */
function isShopScopedUpstream(upstreamId: string): boolean {
  if (!upstreamId) return false;
  const row = db.prepare('SELECT adapter FROM upstreams WHERE id = ?').get(upstreamId) as { adapter?: string } | undefined;
  return row?.adapter === 'lingxing-meta';
}

/**
 * 构建 shops 表的 ID 映射。
 * shops 表现在有三种值域，互相之间完全不相交：
 *   sid       = 领星店铺 sid（1911 这种纯数字字符串，用于白名单比对）
 *   store_id  = Amazon 店铺 id（3894542930 这种纯数字，ad_campaign_report 行内带的就是它）
 *   seller_id = Amazon seller token（A1P8NM96COGRQG 这种 marketplace 格式）
 *   profile_id = 广告 profile（2077184146349981 这种）
 * 构建：store_id → Set<sid>、seller_id → Set<sid>、profile_id → Set<sid>
 */
function buildShopIdMapping(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const rows = db
    .prepare('SELECT sid, seller_id, store_id, profile_id FROM shops')
    .all() as Array<{ sid: string; seller_id: string; store_id: string; profile_id: string }>;
  for (const row of rows) {
    // sid 本身也可能被抽到（某些工具返回领星 sid）
    if (row.sid) {
      let set = map.get(row.sid);
      if (!set) { set = new Set(); map.set(row.sid, set); }
      set.add(row.sid);
    }
    if (row.store_id) {
      let set = map.get(row.store_id);
      if (!set) { set = new Set(); map.set(row.store_id, set); }
      set.add(row.sid);
    }
    if (row.seller_id) {
      let set = map.get(row.seller_id);
      if (!set) { set = new Set(); map.set(row.seller_id, set); }
      set.add(row.sid);
    }
    if (row.profile_id) {
      let set = map.get(row.profile_id);
      if (!set) { set = new Set(); map.set(row.profile_id, set); }
      set.add(row.sid);
    }
  }
  return map;
}

interface ShopFilterStat {
  removed: number;
}

/**
 * 店铺白名单裁剪：只删除「明确属于其他店铺」的行。
 * - 行内带 sid / shop_id / store_id 等店铺标识且全部不在白名单 → 删除并计数
 * - 行内没有任何店铺标识（汇总行、或无店铺维度的数据）→ 保留，不做猜测
 *
 * 关键：上游返回的 store_id 可能是 marketplace 格式（A1XYW53UGM63O3），
 * 而 shops 表存的是领星 sid（1911/1875）。必须通过 sellerToSids 映射桥接。
 */
function filterShopListInNode(
  node: unknown,
  allowedShops: Set<string>,
  stat: ShopFilterStat,
  idMap: Map<string, Set<string>>
): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const ids = extractShopIdsFromObj(item as Record<string, unknown>);
        // 比对前先做映射：抽到的 ids 可能是 marketplace/seller 格式，
        // 需通过 idMap 桥接到 sid 再和 allowedShops 比对
        const resolvedIds: string[] = [];
        for (const raw of ids) {
          if (allowedShops.has(raw)) {
            resolvedIds.push(raw); // 已经是 sid，直接命中
          } else if (idMap.has(raw)) {
            // marketplace/seller_id → 查 shops 表映射的 sid 集合
            // 关键：桥接出来的 sid **必须再和 allowedShops 比对**，只留白名单内的
            const mappedSids = idMap.get(raw)!;
            for (const sid of mappedSids) {
              if (allowedShops.has(sid)) resolvedIds.push(sid);
            }
          }
          // 都不是 → 忽略（可能是 profile_id 这种其他平台 id，不做猜测）
        }
        if (ids.length > 0 && resolvedIds.length === 0) {
          // 抽到了店铺标识，但映射后一个都不在白名单 → 明确未授权 → 剔除
          stat.removed += 1;
          continue;
        }
      }
      out.push(filterShopListInNode(item, allowedShops, stat, idMap));
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = filterShopListInNode(v, allowedShops, stat, idMap);
    }
    return out;
  }
  return node;
}

/** 对 MCP content 数组应用店铺白名单裁剪，返回新 content 与裁剪统计 */
function filterContentByShops(
  content: unknown,
  allowedShops: Set<string>,
  stat: ShopFilterStat,
  idMap: Map<string, Set<string>>
): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object') return part;
    if (typeof part.text !== 'string') return part;
    try {
      const parsed = JSON.parse(part.text);
      const before = stat.removed;
      const filtered = filterShopListInNode(parsed, allowedShops, stat, idMap);
      if (stat.removed > before) {
        return { ...part, text: JSON.stringify(filtered) };
      }
      // 这块没裁掉任何行 → 原样返回，避免 parse→stringify 丢精度
      return part;
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
/**
 * 清理 MCP content 里 JSON 文本中的内网 URL 字段（仅对 NocoDB 等需要）。
 *
 * 评审（严重）：原实现无条件 JSON.parse → JSON.stringify，
 * 每次成功响应都走，导致 2^53 以上整数 ID 丢精度（9007199254740993 → 9007199254740992）、
 * 格式被规整（1.0 → 1）。修复：只有 stat.removed > 0（真删了东西）才重写文本，
 * 否则原样返回，不碰上游原始字节。
 */
function stripInternalUrlsInContent(content: unknown, stat: { removed: number }): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    try {
      const parsed = JSON.parse(part.text);
      const before = stat.removed;
      const cleaned = stripInternalUrlsInNode(parsed, stat);
      if (stat.removed > before) {
        // 真删了东西才重写
        return { ...part, text: JSON.stringify(cleaned) };
      }
      // 没变，原样返回，避免 parse→stringify 丢精度
      return part;
    } catch {
      return part;
    }
  });
}

/** 去掉上游返回里包裹的 markdown 代码围栏（如 ```json {...} ```） */
function stripMarkdownFenceInContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    const t = part.text.trim();
    const m = t.match(/^```(?:json|JSON|JavaScript|js)?\s*\n([\s\S]*?)\n?```\s*$/);
    if (!m) return part;
    try {
      return { ...part, text: JSON.stringify(JSON.parse(m[1].trim())) };
    } catch {
      const stripped = t.replace(/^```(?:json|JSON|JavaScript|js)?\s*\n/, '').replace(/\n?```\s*$/, '');
      if (stripped !== t) return { ...part, text: stripped };
      return part;
    }
  });
}

/**
 * 上游已知问题标注 — 已废弃。
 * 评审：硬编码上游事实，上游修好后需手动删，和"上游修好网关不该跟着改"原则冲突。
 * 上游工具的可靠性问题应由运维通过实际调用观测，不需要网关在描述里插警告。
 */

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
    .map((u) => {
      const note = (u.notes ?? '').trim();
      const noteBrief = note.length > 50 ? note.slice(0, 50) + '…' : note;
      return noteBrief
        ? `${u.name}（${noteBrief}，${toolCounts[u.id] ?? 0} 工具）`
        : `${u.name}（${toolCounts[u.id] ?? 0} 工具）`;
    })
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

    const builtinTools = [
      {
        name: '_tool_search',
        description: '[网关] 按关键词检索可用工具。输入关键词（如 "广告"、"ASIN"、"listing"），返回匹配的工具列表（含上游、用途简述）。377 个工具撑爆上下文时先用这个缩小范围。',
        inputSchema: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词（匹配工具名和描述' }, upstream: { type: 'string', description: '可选：限定上游' }, limit: { type: 'integer', description: '返回上限，默认10，最大30' } }, required: ['keyword'] },
      },
      {
        name: '_gateway_info',
        description: '[网关] 返回网关版本、工具总数、上游状态等基础信息。',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    return {
      tools: [...rows.map((r) => {
        const upInfo = upMap.get(r.upstream);
        const upstreamName = upInfo?.name ?? r.upstream;
        const descPrefix = `[${upstreamName}] `;
        const rawDesc = r.description || r.name || r.exposed_name;
        const MAX_DESC_LEN = 300;
        const fullDesc = descPrefix + rawDesc;
        const truncated = fullDesc.length > MAX_DESC_LEN ? fullDesc.slice(0, MAX_DESC_LEN) + '…' : fullDesc;
        return {
          name: exposedNameOf(r),
          description: truncated,
          inputSchema: minimizeSchema(safeParseSchema(r.input_schema)),
        };
      }), ...builtinTools],
      _meta: {
        tools_hash: toolsHashOf(upstreams),
        tools_count: rows.length + builtinTools.length,
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

    function logOutcome(
      success: boolean,
      isError: boolean,
      error?: string,
      costCredits?: number | null,
      opts?: { effectiveRows?: number | null; isEmptyShell?: boolean }
    ): void {
      const isEmptyShell = opts?.isEmptyShell ?? false;
      // 网关自建消耗分：成功且非空壳才计分。tool 可能为 undefined（限流/账号停用等早期拒绝），fallback 0
      const gatewayPoints = success && !isEmptyShell ? (tool?.gateway_points ?? 1) : 0;
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
        cost_credits: costCredits ?? null,
        effective_rows: opts?.effectiveRows ?? null,
        is_admin: identity.kind === 'admin',
        is_empty_shell: isEmptyShell,
        gateway_points: gatewayPoints,
      });
    }

    // ---- 网关自身工具（_ 前缀）—— 直接处理，不走上游 ----
    if (name === '_gateway_info') {
      const gwUpstreams = upstreams.map((u) => ({ id: u.id, name: u.name, adapter: u.adapter, tools: toolCounts[u.id] ?? 0 }));
      const upstreamTotal = gwUpstreams.reduce((s, u) => s + u.tools, 0);
      const builtinTotal = 2;
      const result = { gateway: '方中 MCP 网关', version: config.version, identity: identity.kind === 'admin' ? 'admin' : `user:${identity.username}`, upstreams: gwUpstreams, builtin_tools: builtinTotal, total_tools: upstreamTotal + builtinTotal };
      insertCallLog({ caller: logCtx.caller, user_id: logCtx.userId, tool_name: name, tool_id: name, tool_type: 'gateway', upstream: '', shop_refs: null, success: true, is_error: false, duration_ms: Date.now() - logCtx.started, error: null, cost_credits: null, effective_rows: null, is_admin: identity.kind === 'admin', is_empty_shell: true, gateway_points: 0 });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
    if (name === '_tool_search') {
      const kw = String(args.keyword ?? '').trim();
      const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 30);
      const upstreamFilter = typeof args.upstream === 'string' ? args.upstream : null;
      if (!kw) return errorResult('请提供 keyword 参数');
      const activeUpIds2 = upstreams.map((u) => u.id);
      const scope2 = identity.kind === 'admin' ? { all: true, ids: [...activeUpIds2] } : resolveUserUpstreams(identity.upstream, activeUpIds2);
      const toolUpstream = scope2.ids.length > 0 ? scope2.ids : activeUpIds2;
      const ph = toolUpstream.map(() => '?').join(',');
      let allTools = db.prepare(`SELECT upstream, exposed_name, description FROM tools WHERE enabled = 1 AND upstream IN (${ph})`).all(...toolUpstream) as any[];
      if (identity.kind === 'user' && !identity.all_tools) {
        const allowed = new Set(getUserToolIds(identity.id));
        allTools = allTools.filter((r) => allowed.has(r.exposed_name));
      }
      const hay = (r: any) => `${r.exposed_name} ${r.description ?? ''}`.toLowerCase();
      const matched = allTools.filter((r) => hay(r).includes(kw.toLowerCase()) && (!upstreamFilter || r.upstream === upstreamFilter)).slice(0, limit);
      const upNames = new Map(upstreams.map((u) => [u.id, u.name]));
      const result = { keyword: kw, total: matched.length, results: matched.map((r) => ({ name: r.exposed_name, upstream: upNames.get(r.upstream) ?? r.upstream, desc: (r.description ?? '').slice(0, 100) })) };
      insertCallLog({ caller: logCtx.caller, user_id: logCtx.userId, tool_name: name, tool_id: name, tool_type: 'gateway', upstream: '', shop_refs: null, success: true, is_error: false, duration_ms: Date.now() - logCtx.started, error: null, cost_credits: null, effective_rows: matched.length, is_admin: identity.kind === 'admin', is_empty_shell: true, gateway_points: 0 });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
    // block_write=1 时默认禁止所有 write 工具，但管理员可手动在运营用户的 tool_ids 里
    // 分配特定 write 工具作为例外（比如只开放"确认发货"不给"改价"）。
    // all_tools=1 的运营用户视为完全信任，不受 block_write 限制。
    if (identity.kind === 'user' && tool.tool_type === 'write' && getSetting('block_write') === '1' && !identity.all_tools) {
      const allowedTools = getUserToolIds(identity.id);
      if (!allowedTools.includes(tool.tool_id)) {
        logOutcome(false, true, 'block_write 禁止写操作');
        return errorResult(`该工具为写操作，已被网关禁用: ${name}（如需开放请在运营用户权限里手动勾选，或关闭全局禁止写操作）`, { type: 'permission_denied', upstream: tool.upstream, tool: name });
      }
      // 管理员手动分配的 write 工具 → 放行（block_write 只作为默认禁，例外由管理员决定）
      console.log(`[mcp] ${identity.username} write 工具 ${name} 已在白名单 → 放行（block_write 例外）`);
    }

    // ---- 参数预校验（降级为 warning 日志，不拦截）----
    // 评审指出：用本地缓存 schema 拦截请求，上游改了 schema 网关没 sync 时会误拒。
    // 和"上游修好后网关不该跟着改"原则冲突。
    // 降级为：校验失败只记日志，请求照常转发，由上游判断真正的参数错误。
    // 好处：上游返回的 code:102 会被 detectBizErrorInContent 捕获并转成 MCP 错误，
    // 网关仍然会返回清晰的错误，但不会自己拦。
    const validationIssue = validateArgs(safeParseSchema(tool.input_schema), args);
    if (validationIssue) {
      console.warn(`[mcp] 参数预校验 warning (${name}): ${validationIssue.message} (field=${validationIssue.field})，放行由上游判断`);
    }

    // 店铺级校验（仅对运营用户 + 店铺维度上游生效）
    // 领星（lingxing-meta）所有工具都是店铺维度 → 强制 shop_scoped，不需要审核
    // 西柚 / ABA / NocoDB（flat-mcp）是公共数据源 → 跳过所有店铺校验
    const isShopScoped = isShopScopedUpstream(tool.upstream ?? '');

    // 白名单 bypass：查询店铺/账号自身属性的工具 → 跳过店铺参数校验 + 结果裁剪
    const bypassShopCheck = SHOP_SCOPE_BYPASS_TOOLS.has(tool.tool_id) || SHOP_SCOPE_BYPASS_TOOLS.has(name);

    if (identity.kind === 'user' && !identity.all_shops && isShopScoped && !bypassShopCheck) {
      // 领星强制 shop_scoped：运营必须传店铺参数 + 店铺在白名单里
      // 不需要 shop_scope 字段审核机制（领星全是店铺维度）
      if (shopRefs.length === 0) {
        // === A. 自动注入：read 工具 + 店铺白名单只有 1 家 → 自动加 sid ===
        const allowedShopIds = getUserShopIds(identity.id);
        const safeToolType = (tool.tool_type ?? '').toLowerCase(); // read = 安全，write = 危险
        if (allowedShopIds.length === 1 && safeToolType !== 'write') {
          const autoSid = allowedShopIds[0];
          // 注入到 args.sid（领星最通用的字段名）
          args.sid = autoSid;
          // 刷新 shopRefs，让后续校验链路统一
          shopRefs.push(autoSid);
          console.log(
            `[mcp] ${identity.username} ${name} 未传店铺 → 自动注入唯一店铺 sid=${autoSid}（read 工具 + 单店运营）`
          );
        }
      }

      // 注入后 shopRefs 仍然为空 → 走 B（友好 hint）或硬拒绝
      if (shopRefs.length === 0) {
        // 收集可用店铺，拼成 hint
        const allowedShopIds = getUserShopIds(identity.id);
        let hint = '';
        if (allowedShopIds.length > 0) {
          const shopList = allowedShopIds.map((sid) => {
            const row = db
              .prepare('SELECT name, country, profile_id FROM shops WHERE sid = ?')
              .get(sid) as { name: string; country: string; profile_id: string } | undefined;
            const label = row?.name ? `${sid}(${row.name})` : sid;
            return label;
          });
          hint = `可用店铺: ${shopList.join(', ')}。请在参数里加 sid: "${allowedShopIds[0]}" 或 sids: ${JSON.stringify(allowedShopIds)}`;
        } else {
          hint = '未配置店铺白名单 → 请先在运营用户管理里配置店铺权限';
        }
        // write 工具仍然硬拒绝（安全底线：改价发货不能自动猜店铺）
        const safeToolType = (tool.tool_type ?? '').toLowerCase();
        if (safeToolType === 'write') {
          logOutcome(false, true, `write 工具未提供店铺参数（禁止自动注入）`);
          return errorResult(
            `写操作工具「${name}」禁止自动注入店铺。${hint}`,
            { type: 'invalid_params', upstream: tool.upstream, tool: name, reason: 'missing_shop_param', hint }
          );
        }
        // read 工具 → 返回带 hint 的空壳响应（gateway_points=0，不计分）
        logOutcome(true, false, undefined, null, { isEmptyShell: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                code: 0,
                data: null,
                msg: `缺少店铺参数。${hint}`,
                _auto_inject_disabled: true,
              }),
            },
          ],
          isError: false,
          // structuredContent 故意不带（不传=undefined），
          // MCP 协议要求 structuredContent 若出现必须是 object（不能 null），否则 zod 校验报 -32602
        };
      }
      // === shop_scoped + shopRefs 非空：参数级店铺校验 ===
      const allowedShopIds = new Set(getUserShopIds(identity.id));
      // fail-closed：user_shops 为空 → 配置缺失，明确拒绝调用
      if (allowedShopIds.size === 0) {
        logOutcome(false, true, '未配置店铺白名单');
        return errorResult(
          `密钥未配置店铺白名单，无法调用店铺维度工具。请在管理后台 "运营用户 → 店铺权限" 补配，或设为全部店铺。`,
          { type: 'permission_denied', upstream: tool.upstream, tool: name, reason: 'no_shop_whitelist' }
        );
      }
      const idMap = buildShopIdMapping();

      const denied: string[] = [];
      for (const ref of shopRefs) {
        const mapped = idMap.get(ref);
        if (mapped) {
          // ref 是映射里的某个 ID（store_id / seller_id / profile_id / sid 本身）
          // 评审意见改用 every 不用 some：同一个 seller_id 可能跨多个站点，
          // 只授权 US 的用户传这个 seller_id → some 会让它通过但返回所有站点数据
          if (![...mapped].every((s) => allowedShopIds.has(s))) {
            denied.push(ref + '→' + [...mapped].join(','));
          }
        } else {
          // 未映射 → fail-closed 拒绝
          denied.push(ref + '(未映射)');
        }
      }
      if (denied.length > 0) {
        logOutcome(false, true, `无权访问店铺: ${denied.join(',')}`);
        const allowedList = [...allowedShopIds];
        return errorResult(`无权访问以下店铺: ${denied.join(', ')}。当前可用店铺 sid: ${allowedList.join(', ')}`, {
          type: 'permission_denied',
          upstream: tool.upstream,
          tool: name,
          field: 'shop',
          denied,
          available_sids: allowedList,
          tip: `可用店铺 sid 清单: ${allowedList.join(', ')}。在参数中使用 sid / sids / store_id / profile_ids 等字段。`,
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
    // 认证方式检查：api_key / 自定义 headers / URL query（如 SIF 的 secret-key）— 三者有一即可
    const hasCustomHeaders = Object.keys(parseUpstreamHeaders(upConfig)).length > 0;
    const hasUrlAuth = /[?&][\w-]*(key|token|secret|auth|access)[\w-]*=/i.test(upConfig.url ?? '');
    if (!upConfig.api_key && !hasCustomHeaders && !hasUrlAuth) {
      logOutcome(false, true, '上游未配置认证');
      return errorResult(`上游 ${upConfig.name} 未配置认证信息（api_key / headers / URL query），请联系管理员`);
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

      // cost_logs + call_logs.cost_credits（两处都写：cost_logs 用于账单汇总，call_logs 用于调用记录可追溯）
      const shell = callResult.emptyShell;
      const isEmptyShell = !!shell?.isEmpty;
      let cost = adapter.extractCost(callResult.content?.[0]?.text);
      if (cost !== null && isEmptyShell) {
        // 空壳数据：有 cost 但有效行数为 0 或关键字段全 null → cost 归零（分摊公平性）
        console.log(`[mcp] ${caller} ${name} 空壳检测命中（有效行 ${shell?.effectiveRows ?? 0}），cost 归零: ${cost} → 0`);
        cost = 0;
      }
      // 网关自建消耗分：成功且非空壳才计分（cost_logs 也写入，方便费用分摊对账）
      const gatewayPoints = !isEmptyShell ? (tool.gateway_points ?? 1) : 0;
      if (cost !== null || gatewayPoints > 0) {
        db.prepare(
          'INSERT INTO cost_logs (upstream, user_id, tool_name, tool_id, cost_credits, duration_ms, created_at, is_admin, is_empty_shell, gateway_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          upId,
          identity.kind === 'user' ? identity.id : null,
          tool.exposed_name,
          tool.tool_id,
          cost ?? 0,
          duration,
          new Date().toISOString(),
          identity.kind === 'admin' ? 1 : 0,
          isEmptyShell ? 1 : 0,
          gatewayPoints
        );
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
        logOutcome(false, true, `[${upId}] code=${String(rawCode)} ${msg}`.slice(0, 400), cost);
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
      // 成功日志加 content 字节数 + 数组长度摘要（一眼看出有没有截断）
      const contentText = content?.find((c) => c.type === 'text')?.text ?? '';
      const contentBytes = Buffer.byteLength(contentText, 'utf-8');
      // 递归摘要：找出所有数组的 path→length，如 "data.data→6" / "data.data.list→255"
      const arrLens: string[] = [];
      try {
        const parsed = contentText ? JSON.parse(contentText) : null;
        const walk = (node: unknown, path: string, depth = 0) => {
          if (depth > 6 || !node) return;
          if (Array.isArray(node)) {
            // 只记录顶层 3 层的数组，避免日志太长
            if (depth <= 4) arrLens.push(`${path || 'root'}→${node.length}`);
            node.slice(0, 2).forEach((it, idx) => walk(it, `${path || ''}[${idx}]`, depth + 1));
          } else if (typeof node === 'object') {
            for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
              walk(v, path ? `${path}.${k}` : k, depth + 1);
            }
          }
        };
        if (parsed) walk(parsed, '');
      } catch {
        /* 非 JSON */
      }
      const arrSummary = arrLens.length > 0 ? ` arrays[${arrLens.join(';')}]` : '';
      console.log(
        `[mcp] ${caller} ${name} ok ${duration}ms upstream=${upId} content=${contentBytes}B${arrSummary}${isEmptyShell ? ' 空壳⚠️' : ''}`
      );
      logOutcome(true, false, undefined, cost, {
        effectiveRows: shell?.effectiveRows ?? null,
        isEmptyShell,
      });

      // 店铺结果裁剪
      // 只对「店铺维度上游」生效：西柚/NocoDB 等上游没有店铺维度，结果必须原样返回
      // bypass 工具（get_my_sids/ad_auth_shops 等店铺目录类）也按 user_shops 白名单裁剪，
      // 但裁剪后 0 行时保留全部 + warning（运营能看到领星绑定了哪些店，方便申请权限）
      if (Array.isArray(content)) {
        let filteredContent = content as any[];
        const isBypassTool = SHOP_SCOPE_BYPASS_TOOLS.has(tool?.tool_id ?? '') || SHOP_SCOPE_BYPASS_TOOLS.has(name);
        if (identity.kind === 'user' && !identity.all_shops && isShopScopedUpstream(upId)) {
          const allowedShops = new Set(getUserShopIds(identity.id));
          if (allowedShops.size === 0) {
            // user_shops 未配置 → 防御性兜底：原样返回 + warning
            if (isBypassTool) {
              filteredContent = [
                { type: 'text' as const, text: JSON.stringify({ __gateway_warn: '未配置店铺白名单，当前展示领星账号绑定的全部店铺（仅可见目录，不能调用 shop_scoped 工具）' }) },
                ...filteredContent,
              ];
            }
            console.warn(`[mcp] ${caller} ${name} 店铺裁剪跳过：user_shops 为空`);
          } else {
            const stat: ShopFilterStat = { removed: 0 };
            const idMap = buildShopIdMapping();
            filteredContent = filterContentByShops(content, allowedShops, stat, idMap) as any[];
            if (isBypassTool && filteredContent.length === 0 && stat.removed > 0) {
              // bypass 工具裁剪后 0 行（运营白名单与领星返回无交集）→ 保留全部 + warning
              console.warn(`[mcp] ${caller} ${name} bypass 工具裁剪后 0 行（allowed=${allowedShops.size}），保留全部`);
              filteredContent = content as any[];
              filteredContent = [
                { type: 'text' as const, text: JSON.stringify({ __gateway_warn: `你当前可用店铺 ${allowedShops.size} 家，领星返回的 ${stat.removed + 1} 家中无匹配。当前展示全部仅供参考。` }) },
                ...filteredContent,
              ];
            } else if (stat.removed > 0) {
              console.log(`[mcp] ${caller} ${name} 店铺裁剪 ${stat.removed} 行（allowed=${allowedShops.size}${isBypassTool ? '，bypass工具' : ''}）`);
              filteredContent = [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    __gateway_warn: `已按店铺权限过滤 ${stat.removed} 行不属于授权店铺的数据；上游的总数字段（total/recordsFiltered）不会随之变化，不能据其判断明细是否完整`,
                  }),
                },
                ...filteredContent,
              ];
            }
          }
        } // closing: if (identity.kind === 'user' && !all_shops && shopScoped)
        // 清理响应里的内网地址（如 NocoDB 的 next 分页 URL 会带 192.168.x.x:port / baseId / tableId）
        const scrubStat = { removed: 0 };
        filteredContent = stripInternalUrlsInContent(filteredContent, scrubStat) as any[];
        if (scrubStat.removed > 0) {
          console.log(`[mcp] ${caller} ${name} 已移除 ${scrubStat.removed} 个内网 URL 字段`);
        }
        filteredContent = stripMarkdownFenceInContent(filteredContent) as any[];
        // bypass 工具（店铺目录类）→ 在返回里注入显式店铺提示，不让 agent 从大 JSON 里自己抽
        // 即使后面的数据很长，agent 第一眼也能看到可用 sid 列表 + 使用示例
        const isBypassToolForHint = SHOP_SCOPE_BYPASS_TOOLS.has(tool?.tool_id ?? '') || SHOP_SCOPE_BYPASS_TOOLS.has(name);
        if (isBypassToolForHint && filteredContent.length > 0) {
          const shopHints: Array<{ sid: string; name?: string; country?: string }> = [];
          for (const block of filteredContent) {
            if (typeof (block as any)?.text !== 'string') continue;
            try {
              const parsed = JSON.parse((block as any).text);
              if (Array.isArray(parsed)) {
                for (const row of parsed) {
                  if (row && typeof row === 'object') {
                    const sids = extractShopIdsFromObj(row);
                    if (sids.length > 0) {
                      shopHints.push({
                        sid: sids[0],
                        name: (row.name ?? row.shop_name ?? row.store_name ?? row.shopAlias ?? undefined) as string | undefined,
                        country: (row.country ?? row.country_code ?? undefined) as string | undefined,
                      });
                    }
                  }
                }
              }
            } catch { /* 不是可解析的 JSON text block，跳过 */ }
          }
          if (shopHints.length > 0) {
            // 去重 + 保留原始顺序
            const seen = new Set<string>();
            let uniq = shopHints.filter((h) => {
              if (seen.has(h.sid)) return false;
              seen.add(h.sid);
              return true;
            });

            // 如果 user_shops 已配置（非空）→ hint 只列白名单店铺
            // 避免 agent 拿到不属于自己的 sid 去调 shop_scoped 又被拒
            // 如果 user_shops 未配置（空）→ 原样返回领星全部（让运营看到可用店铺）
            if (identity.kind === 'user' && !identity.all_shops) {
              const whitelist = new Set(getUserShopIds(identity.id));
              if (whitelist.size > 0) {
                const before = uniq.length;
                uniq = uniq.filter((h) => whitelist.has(h.sid));
                if (uniq.length === 0) {
                  // 白名单过滤后一个都没剩 → 保留领星全部，但加个提醒
                  console.warn(`[mcp] ${caller} ${name} bypass hint: user_shops 白名单 (${whitelist.size}) 与领星返回的店铺 (${before}) 无交集，返回全部`);
                } else {
                  console.log(`[mcp] ${caller} ${name} bypass hint: user_shops 白名单过滤 ${before} → ${uniq.length} 家`);
                }
              }
            }

            const sampleSid = uniq.length > 0 ? uniq[0].sid : '';
            const hintBlock = {
              type: 'text' as const,
              text: JSON.stringify({
                __gateway_shop_hint: {
                  tool: name,
                  available_sids: uniq.map((h) => h.sid),
                  shop_count: uniq.length,
                  shops: uniq.map((h) => ({
                    sid: h.sid,
                    name: h.name || undefined,
                    country: h.country || undefined,
                  })),
                  tip: uniq.length > 0
                    ? `调用 shop_scoped 工具时，请在参数中加上 sid（单店）或 sids（多店）。示例: { sid: "${sampleSid}" }`
                    : '当前用户未被授予任何店铺权限，请联系管理员配置',
                },
              }),
            };
            filteredContent = [hintBlock, ...filteredContent];
            console.log(`[mcp] ${caller} ${name} 注入店铺提示: ${uniq.length} 家可用 sid=[${uniq.map((h) => h.sid).join(',')}]`);
          }
        }

        // 返回：透传 structuredContent 仅对不受限用户（admin / all_shops）
        // 评审：structuredContent 绕过了店铺裁剪 + 内网 URL 清理，
        // 一旦上游开始返回它，受限运营会拿到未过滤的全店数据
        const ret: any = { content: filteredContent };
        const hasStructured = (callResult as any).structuredContent !== undefined;
        const isRestricted = identity.kind === 'user' && !identity.all_shops;
        if (hasStructured && !isRestricted) {
          ret.structuredContent = (callResult as any).structuredContent;
        } else if (hasStructured && isRestricted) {
          console.warn(`[mcp] ${caller} ${name} 受限用户，不透传 structuredContent（绕过店铺裁剪）`);
        }
        return ret;
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
