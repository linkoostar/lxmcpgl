import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  db,
  getSetting,
  setSetting,
  getSettingJSON,
  setSettingJSON,
  hashPassword,
  verifyPassword,
  sha256,
  getToolById,
  upsertShop,
  upsertShopByStoreId,
  listShops,
  listUsers,
  getUserById,
  getUserByKeyHash,
  getUserToolIds,
  getUserShopIds,
  setUserTools,
  setUserShops,
  getReadToolIds,
  getToolCountByType,
  listCallLogs,
  getCallLogStats,
  getCallLogTrend,
  cleanupCallLogs,
  listUpstreams,
  getUpstream,
  upsertUpstream,
  deleteUpstream,
  getUpstreamToolCounts,
  maskUpstreamKey,
  setToolShopScope,
  getBillingRates,
  setBillingRates,
  getMonthlyBillingReport,
  isValidYearMonth,
  currentYearMonthCn,
  DEFAULT_BILLING_RATES,
  type BillingRatesConfig,
  type BillingRate,
} from './db.js';
import { config, META_TOOLS } from './config.js';
import { getUpstreamClient, resetUpstreamClient, UpstreamError } from './upstream.js';
import { syncTools, syncUpstreamById, isSyncing, listTools, batchSetEnabled, syncAllUpstreams } from './sync.js';
import { checkAndNotifyToolsChanged } from './mcp.js';
import { getAdapter } from './adapter.js';
import { buildHealth } from './health.js';

// cookie 名带部署后缀，同域名多实例（如 8085 老网关 + 8086 新网关 + 8087 灰度）互不干扰
// 浏览器 cookie 不按端口隔离，必须靠名字区分
// 环境变量 LX_COOKIE_SUFFIX 控制后缀，默认用端口号；部署时显式指定更可控（例：LX_COOKIE_SUFFIX=prod1）
const cookieSuffix = process.env.LX_COOKIE_SUFFIX || String(config.port);
const COOKIE_NAME = `lx_session_${cookieSuffix}`;
const SESSION_TTL_MS = 12 * 3600 * 1000;

// ---------- 会话（HMAC 签名 token，重启不失效） ----------

function signSession(username: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${username}.${exp}`;
  const sig = createHmac('sha256', getSetting('session_secret')).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [username, exp, sig] = parts;
  if (!Number(exp) || Number(exp) < Date.now()) return null;
  const expect = createHmac('sha256', getSetting('session_secret')).update(`${username}.${exp}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b) ? username : null;
}

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const username = verifySession(getCookie(req, COOKIE_NAME));
  if (!username) {
    res.status(401).json({ error: '未登录或会话已过期' });
    return;
  }
  (req as any).username = username;
  next();
}

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Cookie 的 Secure 标记：仅在请求本身是 HTTPS 时添加。
 * req.secure 依据 req.protocol === 'https'；反代（TLS 在 Nginx/Caddy 终止）场景
 * 需要设置 app.set('trust proxy', ...) 才能从 X-Forwarded-Proto 还原出 https。
 * 不得无条件添加 —— 局域网 HTTP 部署下带 Secure 的 cookie 会被浏览器丢弃，登录直接失效。
 */
function cookieSecurityAttr(req: Request): string {
  return req.secure ? '; Secure' : '';
}

// ---------- 登录限速 ----------

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function loginLimited(ip: string): boolean {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return false;
  }
  rec.count++;
  return rec.count > 10;
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// ---------- 路由 ----------

export const apiRouter = express.Router();

apiRouter.get(
  '/health',
  wrap(async (req, res) => {
    // probe=1 时才主动探活上游（结果缓存 60s），默认只读本地状态，保证 Docker HEALTHCHECK 足够快
    const probe = String(req.query.probe ?? '') === '1';
    const payload = await buildHealth({ probe });
    res.status(payload.ok ? 200 : 503).json(payload);
  })
);

apiRouter.post(
  '/login',
  wrap(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (loginLimited(ip)) {
      res.status(429).json({ error: '尝试过于频繁，请 5 分钟后再试' });
      return;
    }
    const { username, password } = req.body ?? {};
    if (username !== getSetting('admin_username') || !verifyPassword(String(password ?? ''), getSetting('admin_password_hash'))) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(signSession(String(username)))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${cookieSecurityAttr(req)}`
    );
    res.json({ ok: true });
  })
);

apiRouter.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSecurityAttr(req)}`);
  res.json({ ok: true });
});

apiRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ username: (req as any).username, version: config.version });
  })
);

apiRouter.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const { old_password, new_password } = req.body ?? {};
    if (!verifyPassword(String(old_password ?? ''), getSetting('admin_password_hash'))) {
      res.status(400).json({ error: '原密码不正确' });
      return;
    }
    const np = String(new_password ?? '');
    if (np.length < 6) {
      res.status(400).json({ error: '新密码至少 6 位' });
      return;
    }
    setSetting('admin_password_hash', hashPassword(np));
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/settings',
  requireAuth,
  wrap(async (_req, res) => {
    const upstreamKey = getSetting('upstream_key');
    const toolCount = (db.prepare('SELECT COUNT(*) AS c FROM tools').get() as { c: number }).c;
    const typeCount = getToolCountByType();
    res.json({
      version: config.version,
      upstream_url: getSetting('upstream_url'),
      upstream_key_set: !!upstreamKey,
      upstream_key_masked: maskKey(upstreamKey),
      downstream_key_masked: maskKey(getSetting('downstream_key')),
      last_sync_at: getSetting('last_sync_at'),
      tool_count: toolCount,
      tool_type_count: typeCount,
      syncing: isSyncing(),
      block_write: getSetting('block_write') === '1',
      shop_count: listShops().length,
      // 默认权限模板
      default_tools_all: getSetting('default_tools_all') === '1',
      default_shops_all: getSetting('default_shops_all') === '1',
      default_tools: getSettingJSON<string[]>('default_tools', []),
      default_shops: getSettingJSON<string[]>('default_shops', []),
    });
  })
);

apiRouter.put(
  '/settings',
  requireAuth,
  wrap(async (req, res) => {
    const { upstream_url, upstream_key } = req.body ?? {};
    if (upstream_url !== undefined) {
      const url = String(upstream_url).trim();
      if (!/^https?:\/\//.test(url)) {
        res.status(400).json({ error: '上游地址必须以 http(s):// 开头' });
        return;
      }
      setSetting('upstream_url', url);
    }
    if (upstream_key !== undefined && String(upstream_key).trim() !== '') {
      setSetting('upstream_key', String(upstream_key).trim());
    }
    if (req.body?.block_write !== undefined) {
      setSetting('block_write', req.body.block_write ? '1' : '0');
    }
    // 默认权限模板
    if (req.body?.default_tools_all !== undefined) {
      setSetting('default_tools_all', req.body.default_tools_all ? '1' : '0');
    }
    if (req.body?.default_shops_all !== undefined) {
      setSetting('default_shops_all', req.body.default_shops_all ? '1' : '0');
    }
    if (Array.isArray(req.body?.default_tools)) {
      setSettingJSON('default_tools', req.body.default_tools.map(String));
    }
    if (Array.isArray(req.body?.default_shops)) {
      setSettingJSON('default_shops', req.body.default_shops.map(String));
    }
    resetUpstreamClient();
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/settings/test',
  requireAuth,
  wrap(async (req, res) => {
    const url = String(req.body?.upstream_url ?? getSetting('upstream_url')).trim();
    const key = String(req.body?.upstream_key ?? getSetting('upstream_key')).trim();
    if (!/^https?:\/\//.test(url) || !key) {
      res.json({ ok: false, error: '请先填写上游地址与密钥' });
      return;
    }
    try {
      const client = getUpstreamClient(url, key);
      const info = await client.initialize();
      res.json({ ok: true, serverInfo: info?.serverInfo ?? null, protocolVersion: info?.protocolVersion ?? null });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  })
);

apiRouter.post(
  '/tools/sync',
  requireAuth,
  wrap(async (req, res) => {
    if (isSyncing()) {
      res.status(409).json({ error: '已有同步任务在进行中' });
      return;
    }
    const upstreamId = String(req.body?.upstream_id ?? '').trim();
    if (upstreamId) {
      const r = await syncUpstreamById(upstreamId);
      checkAndNotifyToolsChanged();
      res.json({ [upstreamId]: r, totalSynced: r.synced });
    } else {
      const r = await syncAllUpstreams();
      checkAndNotifyToolsChanged();
      res.json(r);
    }
  })
);

// ---------- Upstreams CRUD（多上游管理）----------

const KNOWN_ADAPTERS = ['lingxing-meta', 'flat-mcp'];

function validateUpstreamId(id: string): string | null {
  if (!id) return 'id 不能为空';
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) return 'id 需为 2-32 位小写字母/数字/-/_ 且以字母/数字开头';
  return null;
}

apiRouter.get(
  '/upstreams',
  requireAuth,
  wrap(async (_req, res) => {
    const counts = getUpstreamToolCounts();
    const items = listUpstreams().map((u) => ({
      id: u.id,
      name: u.name,
      url: u.url,
      adapter: u.adapter,
      adapter_label: u.adapter === 'lingxing-meta' ? '领星元工具模式' : u.adapter === 'flat-mcp' ? '标准扁平 MCP' : u.adapter,
      active: !!u.active,
      sync_strategy: u.sync_strategy,
      shop_field: u.shop_field,
      notes: u.notes,
      api_key_set: !!u.api_key,
      api_key_masked: maskUpstreamKey(u.api_key),
      headers: u.headers || '{}',
      headers_preview: summarizeHeaders(u.headers),
      tool_count: counts[u.id] ?? 0,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));
    res.json({ items, known_adapters: KNOWN_ADAPTERS });
  })
);

function validateHeadersInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null; // null = 不改
  const str = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  if (!str || str === '{}') return '{}';
  try {
    const obj = JSON.parse(str);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 'headers 必须是 JSON 对象';
    return str;
  } catch {
    return 'headers 不是合法 JSON';
  }
}

/** 给前端展示 headers 有多少条（值脱敏） */
function summarizeHeaders(headersJson: string): string {
  if (!headersJson || headersJson === '{}') return '';
  try {
    const obj = JSON.parse(headersJson);
    const keys = Object.keys(obj);
    if (!keys.length) return '';
    return keys.map((k) => `${k}: ${maskHeaderValue(String(obj[k]))}`).join(', ');
  } catch {
    return '';
  }
}
function maskHeaderValue(v: string): string {
  if (!v) return '';
  if (v.length <= 6) return '****';
  return `${v.slice(0, 3)}****${v.slice(-3)}`;
}

apiRouter.post(
  '/upstreams',
  requireAuth,
  wrap(async (req, res) => {
    const { id, name, url, api_key, adapter, active, notes, headers } = req.body ?? {};
    const sid = String(id ?? '').trim();
    const err = validateUpstreamId(sid);
    if (err) { res.status(400).json({ error: err }); return; }
    if (getUpstream(sid)) { res.status(400).json({ error: `upstream ${sid} 已存在` }); return; }
    const sname = String(name ?? '').trim();
    if (!sname) { res.status(400).json({ error: 'name 不能为空' }); return; }
    const surl = String(url ?? '').trim();
    if (!/^https?:\/\//.test(surl)) { res.status(400).json({ error: 'url 必须以 http(s):// 开头' }); return; }
    const sadapter = String(adapter ?? 'flat-mcp').trim();
    if (!KNOWN_ADAPTERS.includes(sadapter)) { res.status(400).json({ error: `adapter 需为 ${KNOWN_ADAPTERS.join(' / ')}` }); return; }
    const headersErr = validateHeadersInput(headers);
    if (headersErr && typeof headersErr === 'string' && headersErr.startsWith('headers')) { res.status(400).json({ error: headersErr }); return; }
    const row = upsertUpstream({
      id: sid,
      name: sname,
      url: surl,
      api_key: api_key ? String(api_key).trim() : undefined,
      adapter: sadapter,
      active: active !== undefined ? (active ? 1 : 0) : 1,
      notes: notes ? String(notes) : '',
      headers: headersErr === null ? '{}' : headersErr,
    });
    res.json({ ok: true, upstream: row.id });
  })
);

apiRouter.put(
  '/upstreams/:id',
  requireAuth,
  wrap(async (req, res) => {
    const sid = String(req.params.id);
    const existing = getUpstream(sid);
    if (!existing) { res.status(404).json({ error: 'upstream 不存在' }); return; }
    const b = req.body ?? {};
    const patch: Parameters<typeof upsertUpstream>[0] = {
      id: sid,
      name: existing.name,
      url: existing.url,
      api_key: undefined, // 不覆盖
      adapter: existing.adapter,
      active: existing.active,
      sync_strategy: existing.sync_strategy,
      shop_field: existing.shop_field,
      notes: existing.notes,
    };
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.url !== undefined) {
      const u = String(b.url).trim();
      if (!/^https?:\/\//.test(u)) { res.status(400).json({ error: 'url 必须以 http(s):// 开头' }); return; }
      patch.url = u;
    }
    if (b.adapter !== undefined) {
      const a = String(b.adapter).trim();
      if (!KNOWN_ADAPTERS.includes(a)) { res.status(400).json({ error: `adapter 需为 ${KNOWN_ADAPTERS.join(' / ')}` }); return; }
      patch.adapter = a;
    }
    if (b.api_key !== undefined) {
      const k = String(b.api_key).trim();
      if (k) patch.api_key = k; // 只有非空才更新（留空表示不改）
    }
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.notes !== undefined) patch.notes = String(b.notes);
    if (b.headers !== undefined) {
      const h = validateHeadersInput(b.headers);
      if (h && h.startsWith('headers')) { res.status(400).json({ error: h }); return; }
      // null 表示前端传了但不想改 — 不传给 upsert，保留旧值
      if (h !== null) patch.headers = h;
    }
    upsertUpstream(patch);
    // 如果改的是领星上游（lingxing），同步更新老 settings 兼容
    if (sid === 'lingxing') {
      if (b.url !== undefined) setSetting('upstream_url', patch.url);
      if (b.api_key && String(b.api_key).trim() !== '') setSetting('upstream_key', String(b.api_key).trim());
      resetUpstreamClient();
    }
    res.json({ ok: true });
  })
);

apiRouter.delete(
  '/upstreams/:id',
  requireAuth,
  wrap(async (req, res) => {
    const sid = String(req.params.id);
    if (sid === 'lingxing') { res.status(400).json({ error: '领星 upstream 不能删除，请停用' }); return; }
    const existing = getUpstream(sid);
    if (!existing) { res.status(404).json({ error: 'upstream 不存在' }); return; }
    const changed = deleteUpstream(sid);
    res.json({ ok: true, deleted: changed });
  })
);

apiRouter.post(
  '/upstreams/:id/test',
  requireAuth,
  wrap(async (req, res) => {
    const sid = String(req.params.id);
    // 允许测试一个还没保存的 draft（前端可能传 url/api_key/adapter）
    const b = req.body ?? {};
    const useDraft = !!b.url;
    const up = useDraft
      ? {
          id: sid,
          name: String(b.name ?? sid),
          url: String(b.url).trim(),
          api_key: b.api_key ? String(b.api_key).trim() : '',
          adapter: String(b.adapter ?? 'flat-mcp').trim(),
          active: 1, sync_strategy: 'pull', shop_field: 'sid', notes: '',
          headers: String(b.headers ?? '{}'),
          created_at: '', updated_at: '',
        }
      : getUpstream(sid);
    if (!up) { res.status(404).json({ error: 'upstream 不存在' }); return; }
    if (!up.url || !up.adapter) { res.json({ ok: false, error: '缺少 url 或 adapter' }); return; }
    try {
      const adapter = getAdapter(up);
      const tools = await adapter.listTools(up as any);
      res.json({ ok: true, tool_count: tools.length, adapter: up.adapter });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  })
);

apiRouter.post(
  '/upstreams/:id/sync',
  requireAuth,
  wrap(async (req, res) => {
    if (isSyncing()) { res.status(409).json({ error: '已有同步任务在进行中' }); return; }
    const sid = String(req.params.id);
    const r = await syncUpstreamById(sid);
    checkAndNotifyToolsChanged();
    res.json({ upstream_id: sid, ...r });
  })
);

apiRouter.post(
  '/upstreams/sync-all',
  requireAuth,
  wrap(async (_req, res) => {
    if (isSyncing()) { res.status(409).json({ error: '已有同步任务在进行中' }); return; }
    const r = await syncAllUpstreams();
    checkAndNotifyToolsChanged();
    res.json(r);
  })
);

apiRouter.get(
  '/tools',
  requireAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(String(req.query.page_size ?? '50'), 10) || 50));
    const toolType = String(req.query.tool_type ?? '').trim() || undefined;
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    let enabled: number | undefined = undefined;
    if (req.query.enabled !== undefined && req.query.enabled !== '') enabled = String(req.query.enabled) === '1' ? 1 : 0;
    const shopScope = String(req.query.shop_scope ?? '').trim() || undefined;
    res.json(listTools(q, page, pageSize, toolType, enabled, upstream, shopScope));
  })
);

// PATCH /api/tools/:upstream/:tool_id —— 修改工具 shop_scope（管理员审核标记）
apiRouter.patch(
  '/tools/:upstream/:tool_id',
  requireAuth,
  wrap(async (req, res) => {
    const { upstream, tool_id } = req.params;
    const { shop_scope } = req.body ?? {};
    const valid = ['unreviewed', 'shop_scoped', 'global_safe'] as const;
    if (!valid.includes(shop_scope)) {
      res.status(400).json({ error: `shop_scope 必须是 ${valid.join(' / ')}` });
      return;
    }
    const ok = setToolShopScope(upstream, tool_id, shop_scope);
    if (!ok) {
      res.status(404).json({ error: `工具不存在: ${upstream}.${tool_id}` });
      return;
    }
    res.json({ ok: true, upstream, tool_id, shop_scope });
  })
);

// POST /api/tools/batch-shop-scope —— 批量审核 shop_scope
// body: { shop_scope: 'shop_scoped'|'global_safe'|'unreviewed', items: [{upstream, tool_id}] }
apiRouter.post(
  '/tools/batch-shop-scope',
  requireAuth,
  wrap(async (req, res) => {
    const { shop_scope, items } = req.body ?? {};
    const valid = ['unreviewed', 'shop_scoped', 'global_safe'] as const;
    if (!valid.includes(shop_scope)) {
      res.status(400).json({ error: `shop_scope 必须是 ${valid.join(' / ')}` });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'items 不能为空数组' });
      return;
    }
    let okCount = 0, failCount = 0;
    for (const it of items) {
      try {
        if (setToolShopScope(it.upstream, it.tool_id, shop_scope)) okCount++;
        else failCount++;
      } catch { failCount++; }
    }
    res.json({ ok: true, shop_scope, ok_count: okCount, fail_count: failCount, total: items.length });
  })
);

apiRouter.get(
  '/tools/:toolId',
  requireAuth,
  wrap(async (req, res) => {
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    const tool = getToolById(String(req.params.toolId), upstream);
    if (!tool) {
      res.status(404).json({ error: '工具不存在' });
      return;
    }
    let schema: unknown = null;
    if (tool.input_schema) {
      try {
        schema = JSON.parse(tool.input_schema);
      } catch {
        schema = null;
      }
    }
    res.json({ ...tool, input_schema: schema });
  })
);

apiRouter.put(
  '/tools/:toolId/enabled',
  requireAuth,
  wrap(async (req, res) => {
    const upstream = String(req.body?.upstream ?? req.query.upstream ?? '').trim();
    if (!upstream) {
      res.status(400).json({ error: '缺少 upstream 参数' });
      return;
    }
    const enabled = req.body?.enabled ? 1 : 0;
    const info = db
      .prepare('UPDATE tools SET enabled = ? WHERE upstream = ? AND tool_id = ?')
      .run(enabled, upstream, String(req.params.toolId));
    if (info.changes === 0) {
      res.status(404).json({ error: '工具不存在' });
      return;
    }
    checkAndNotifyToolsChanged();
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/settings/downstream-key',
  requireAuth,
  wrap(async (_req, res) => {
    // 管理员通用 Key 默认在 /settings 返回 masked，此处需主动点"显示"才拿明文
    const key = getSetting('downstream_key');
    res.json({ ok: true, downstream_key: key });
  })
);

apiRouter.post(
  '/downstream-key/reset',
  requireAuth,
  wrap(async (_req, res) => {
    const key = randomBytes(24).toString('hex');
    setSetting('downstream_key', key);
    res.json({ ok: true, downstream_key: key });
  })
);

// ---------- 批量启停 ----------

apiRouter.post(
  '/tools/batch-enabled',
  requireAuth,
  wrap(async (req, res) => {
    const { items, tool_ids, all, q, upstream, filter_enabled } = req.body ?? {};
    const enabled = !!req.body?.enabled;
    if (!Array.isArray(items) && !Array.isArray(tool_ids) && all !== true) {
      res.status(400).json({ error: '请提供 items / tool_ids 或 all=true' });
      return;
    }
    const changed = batchSetEnabled(
      {
        items: Array.isArray(items)
          ? items.map((i: any) => ({ upstream: String(i?.upstream ?? ''), tool_id: String(i?.tool_id ?? '') }))
          : undefined,
        tool_ids: Array.isArray(tool_ids) ? tool_ids.map(String) : undefined,
        all: all === true,
        q: String(q ?? ''),
        upstream: String(upstream ?? '').trim() || undefined,
        filter_enabled: filter_enabled === 0 || filter_enabled === 1 || filter_enabled === '0' || filter_enabled === '1' ? filter_enabled : undefined,
      },
      enabled
    );
    checkAndNotifyToolsChanged();
    res.json({ ok: true, changed });
  })
);

// ---------- 店铺 ----------

apiRouter.get(
  '/shops',
  requireAuth,
  wrap(async (_req, res) => {
    res.json({ items: listShops() });
  })
);

apiRouter.post(
  '/shops/sync',
  requireAuth,
  wrap(async (_req, res) => {
    if (!getSetting('upstream_key')) {
      res.status(400).json({ error: '请先配置上游密钥' });
      return;
    }
    try {
      const client = getUpstreamClient(getSetting('upstream_url'), getSetting('upstream_key'));

      // ① get_my_sids — 领星 sid + name + country + seller_id
      const mySidsResp = await client.callTool('action', { toolId: 'get_my_sids', params: {} });
      if (mySidsResp?.error) throw new Error(JSON.stringify(mySidsResp.error).slice(0, 300));
      const mySidsText = mySidsResp?.result?.content?.find((c: any) => c?.type === 'text')?.text ?? '';
      const mySidsPayload = JSON.parse(mySidsText);
      const mySidsList = mySidsPayload?.data?.list ?? mySidsPayload?.data ?? [];
      if (Array.isArray(mySidsList)) {
        for (const s of mySidsList) {
          const sid = s?.id ?? s?.sid;
          if (sid === undefined || sid === null) continue;
          upsertShop({
            sid: String(sid),
            name: String(s?.name ?? ''),
            country: String(s?.country ?? s?.country_code ?? ''),
            seller_id: String(s?.seller_id ?? ''),
            store_id: String(s?.store_id ?? s?.storeId ?? ''),
            profile_id: String(s?.profile_id ?? s?.profileId ?? ''),
          });
        }
      }

      // ② ad_auth_shops — Amazon store_id (纯数字) + profile_id → 补全 get_my_sids 没带的字段
      //    这个接口返回的 store_id 是纯数字 Amazon 店铺 id（如 3894542930），
      //    和 seller_id（A1P8... token）/ sid（1911 数字）值域都不同，必须单独拉
      let shopsFromAdAuth = 0;
      try {
        const adResp = await client.callTool('action', { toolId: 'ad_auth_shops', params: {} });
        const adText = adResp?.result?.content?.find((c: any) => c?.type === 'text')?.text ?? '';
        const adPayload = JSON.parse(adText);
        // 递归找 shops 列表
        const findShops = (o: unknown, dep = 0): any[] => {
          if (dep > 4 || !o) return [];
          if (Array.isArray(o)) return o.length > 0 && typeof o[0] === 'object' ? o : [];
          if (typeof o === 'object') {
            for (const v of Object.values(o as Record<string, unknown>)) {
              const r = findShops(v, dep + 1);
              if (r.length > 0) return r;
            }
          }
          return [];
        };
        const adList = findShops(adPayload?.data ?? adPayload);
        for (const s of adList) {
          const storeId = s?.store_id ?? s?.storeId;
          const sid = s?.id ?? s?.sid;
          const profileId = s?.profile_id ?? s?.profileId;
          // ad_auth_shops 返回的店铺名字段是 alias（不是 shop_name / name）
          const shopName = String(s?.alias ?? s?.shop_name ?? s?.name ?? '');
          if (sid) {
            upsertShop({
              sid: String(sid),
              name: shopName,
              country: String(s?.country_code ?? s?.country ?? ''),
              seller_id: String(s?.seller_string_id ?? s?.seller_id ?? ''),
              store_id: String(storeId ?? ''),
              profile_id: String(profileId ?? ''),
            });
          } else if (storeId) {
            upsertShopByStoreId({
              store_id: String(storeId),
              name: shopName,
              country: String(s?.country_code ?? s?.country ?? ''),
              seller_id: String(s?.seller_string_id ?? s?.seller_id ?? ''),
              profile_id: String(profileId ?? ''),
            });
            shopsFromAdAuth++;
          }
        }
      } catch (adErr) {
        // ad_auth_shops 可能因无广告店铺权限而失败，不阻断整体 sync
        console.warn(`[shops/sync] ad_auth_shops 调用失败（可忽略）: ${String(adErr).slice(0, 200)}`);
      }

      res.json({ ok: true, count: listShops().length, sids_from_get_my_sids: mySidsList.length, extra_from_ad_auth: shopsFromAdAuth });
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
    }
  })
);

// ---------- 运营用户 ----------

function userKey(): string {
  return randomBytes(24).toString('hex');
}

apiRouter.get(
  '/users',
  requireAuth,
  wrap(async (_req, res) => {
    res.json({
      items: listUsers().map((u) => ({
        id: u.id,
        username: u.username,
        key_prefix: u.key_prefix,
        enabled: !!u.enabled,
        rate_limit: u.rate_limit,
        all_tools: !!u.all_tools,
        tool_count: u.all_tools ? null : getUserToolIds(u.id).length,
        all_shops: !!u.all_shops,
        shop_count: u.all_shops ? null : getUserShopIds(u.id).length,
        upstream: u.upstream ?? '',
        created_at: u.created_at,
        last_used_at: u.last_used_at,
      })),
    });
  })
);

apiRouter.post(
  '/users',
  requireAuth,
  wrap(async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const rateLimit = Math.max(0, parseInt(String(req.body?.rate_limit ?? '0'), 10) || 0);
    if (!/^[\w.-]{2,32}$/.test(username)) {
      res.status(400).json({ error: '用户名需为 2-32 位字母/数字/._-' });
      return;
    }
    if (getUserByUsername(username)) {
      res.status(400).json({ error: '用户名已存在' });
      return;
    }
    const key = userKey();
    // 从默认权限模板继承（若调用方直接提供则优先）
    const toolsAll = req.body?.all_tools !== undefined
      ? (req.body.all_tools ? 1 : 0)
      : (getSetting('default_tools_all') === '1' ? 1 : 0);
    const shopsAll = req.body?.all_shops !== undefined
      ? (req.body.all_shops ? 1 : 0)
      : (getSetting('default_shops_all') === '1' ? 1 : 0);

    // upstream：逗号分隔，留空 = 全部 active upstream（Agent 常用）
    const upstream = String(req.body?.upstream ?? '').trim();

    const info = db
      .prepare(
        'INSERT INTO users (username, key_hash, key_prefix, enabled, rate_limit, all_tools, all_shops, upstream, created_at, last_used_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
      )
      .run(username, sha256(key), key.slice(0, 8), rateLimit, toolsAll, shopsAll, upstream, new Date().toISOString(), '');

    const newUserId = Number(info.lastInsertRowid);
    // 非全量时设置白名单
    if (!toolsAll) {
      const toolIds = Array.isArray(req.body?.tool_ids)
        ? req.body.tool_ids.map(String)
        : getSettingJSON<string[]>('default_tools', []);
      if (toolIds.length > 0) setUserTools(newUserId, toolIds);
    }
    if (!shopsAll) {
      let shopIds = Array.isArray(req.body?.shop_ids)
        ? req.body.shop_ids.map(String)
        : getSettingJSON<string[]>('default_shops', []);
      // 安全兜底：如果 shopIds 还是空（default_shops 模板也没配），
      // 自动把 shops 表里已同步的所有店铺塞进去，避免运营账号一上来就全 deny
      if (shopIds.length === 0) {
        const allKnown = listShops().map((s) => s.sid);
        if (allKnown.length > 0) {
          shopIds = allKnown;
          console.warn(
            `[admin] 创建运营用户 ${username} 未指定店铺白名单，自动继承 shops 表 ${allKnown.length} 个店铺`
          );
        } else {
          console.warn(
            `[admin] 创建运营用户 ${username} 未指定店铺白名单，且 shops 表为空——请先跑 /api/shops/sync 再手动补充 user_shops`
          );
        }
      }
      if (shopIds.length > 0) setUserShops(newUserId, shopIds);
    }

    res.json({ ok: true, id: newUserId, downstream_key: key });
  })
);

function getUserByUsername(username: string) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
}

apiRouter.get(
  '/users/:id',
  requireAuth,
  wrap(async (req, res) => {
    const u = getUserById(parseInt(String(req.params.id), 10));
    if (!u) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json({
      id: u.id,
      username: u.username,
      enabled: !!u.enabled,
      rate_limit: u.rate_limit,
      all_tools: !!u.all_tools,
      tool_ids: getUserToolIds(u.id),
      all_shops: !!u.all_shops,
      shop_ids: getUserShopIds(u.id),
      upstream: u.upstream ?? '',
    });
  })
);

apiRouter.put(
  '/users/:id',
  requireAuth,
  wrap(async (req, res) => {
    const u = getUserById(parseInt(String(req.params.id), 10));
    if (!u) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const b = req.body ?? {};
    if (b.enabled !== undefined) {
      db.prepare('UPDATE users SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, u.id);
    }
    if (b.rate_limit !== undefined) {
      db.prepare('UPDATE users SET rate_limit = ? WHERE id = ?').run(
        Math.max(0, parseInt(String(b.rate_limit), 10) || 0),
        u.id
      );
    }
    if (b.all_tools !== undefined) {
      const newVal = b.all_tools ? 1 : 0;
      db.prepare('UPDATE users SET all_tools = ? WHERE id = ?').run(newVal, u.id);
      if (newVal === 1) {
        // 切回全量：清空白名单，避免后续再切回 0 时带出脏数据
        db.prepare('DELETE FROM user_tools WHERE user_id = ?').run(u.id);
      }
    }
    if (b.all_shops !== undefined) {
      const newVal = b.all_shops ? 1 : 0;
      db.prepare('UPDATE users SET all_shops = ? WHERE id = ?').run(newVal, u.id);
      if (newVal === 1) {
        db.prepare('DELETE FROM user_shops WHERE user_id = ?').run(u.id);
      }
    }
    if (Array.isArray(b.tool_ids)) {
      setUserTools(u.id, b.tool_ids.map(String));
    }
    if (Array.isArray(b.shop_ids)) {
      setUserShops(u.id, b.shop_ids.map(String));
    }
    if (b.upstream !== undefined) {
      const raw = String(b.upstream ?? '').trim();
      if (raw && raw !== '*') {
        const validIds = new Set((db.prepare('SELECT id FROM upstreams').all() as Array<{ id: string }>).map((r) => r.id));
        const parts = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        const invalid = parts.filter((id) => !validIds.has(id));
        if (invalid.length > 0) {
          res.status(400).json({ error: `无效的 upstream id: ${invalid.join(', ')}（可选: ${[...validIds].join(', ') || '暂无'}）` });
          return;
        }
      }
      db.prepare('UPDATE users SET upstream = ? WHERE id = ?').run(raw, u.id);
    }
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/users/:id/reset-key',
  requireAuth,
  wrap(async (req, res) => {
    const u = getUserById(parseInt(String(req.params.id), 10));
    if (!u) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const key = userKey();
    db.prepare('UPDATE users SET key_hash = ?, key_prefix = ? WHERE id = ?').run(sha256(key), key.slice(0, 8), u.id);
    res.json({ ok: true, downstream_key: key });
  })
);

apiRouter.delete(
  '/users/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const u = getUserById(id);
    if (!u) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      db.prepare('DELETE FROM user_tools WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_shops WHERE user_id = ?').run(id);
    });
    tx();
    res.json({ ok: true });
  })
);

// 调试：直接调上游元工具（help/search/action），便于排查
apiRouter.post(
  '/debug/upstream',
  requireAuth,
  wrap(async (req, res) => {
    const tool = String(req.body?.tool ?? '');
    const args = (req.body?.arguments ?? {}) as Record<string, unknown>;
    if (!META_TOOLS.has(tool)) {
      res.status(400).json({ error: '仅允许调用 help / search / action' });
      return;
    }
    if (!getSetting('upstream_key')) {
      res.status(400).json({ error: '请先配置上游密钥' });
      return;
    }
    try {
      const client = getUpstreamClient(getSetting('upstream_url'), getSetting('upstream_key'));
      const resp = await client.callTool(tool, args);
      res.json(resp ?? { error: '上游无返回' });
    } catch (e: any) {
      const status = e instanceof UpstreamError ? e.status : 500;
      res.status(status === 500 ? 502 : 200).json({ ok: false, error: String(e?.message || e).slice(0, 500) });
    }
  })
);

// ---------- 调用日志 ----------

apiRouter.get(
  '/call-logs',
  requireAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const caller = String(req.query.caller ?? '').trim();
    const tool = String(req.query.tool ?? '').trim();
    const success = req.query.success !== undefined ? String(req.query.success) as '1' | '0' : undefined;
    const since = String(req.query.since ?? '').trim() || undefined;
    const until = String(req.query.until ?? '').trim() || undefined;
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.page_size ?? '50'), 10) || 50));
    const r = listCallLogs({ q, caller, tool, success, since, until, upstream, page, pageSize });
    res.json(r);
  })
);

apiRouter.get(
  '/call-logs/stats',
  requireAuth,
  wrap(async (req, res) => {
    const since = String(req.query.since ?? '').trim() || undefined;
    const until = String(req.query.until ?? '').trim() || undefined;
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    const caller = String(req.query.caller ?? '').trim() || undefined;
    res.json(getCallLogStats({ since, until, upstream, caller }));
  })
);

apiRouter.get(
  '/call-logs/stats/trend',
  requireAuth,
  wrap(async (req, res) => {
    const since = String(req.query.since ?? '').trim() || undefined;
    const until = String(req.query.until ?? '').trim() || undefined;
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    const caller = String(req.query.caller ?? '').trim() || undefined;
    const granularity = (req.query.granularity === 'hour' ? 'hour' : 'day') as 'hour' | 'day';
    res.json(getCallLogTrend({ since, until, upstream, caller, granularity }));
  })
);

// CSV 导出 — 拉最多 5000 条，流式输出
apiRouter.get(
  '/call-logs/export.csv',
  requireAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const caller = String(req.query.caller ?? '').trim();
    const tool = String(req.query.tool ?? '').trim();
    const success = req.query.success !== undefined ? String(req.query.success) as '1' | '0' : undefined;
    const since = String(req.query.since ?? '').trim() || undefined;
    const until = String(req.query.until ?? '').trim() || undefined;
    const upstream = String(req.query.upstream ?? '').trim() || undefined;
    const MAX = 5000;
    const r = listCallLogs({ q, caller, tool, success, since, until, upstream, page: 1, pageSize: MAX });
    const headers = ['时间', '上游', '调用者', '工具', '上游tool_id', '类型', '成功', '耗时ms', 'Credits', '关联店铺', '错误'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const rows = r.items.map((row) => [
      row.ts, row.upstream || '', row.caller, row.tool_name, row.tool_id || '',
      row.tool_type || '', row.success ? '是' : '否', row.duration_ms ?? '',
      row.cost_credits != null ? row.cost_credits : '',
      row.shop_refs || '', row.error || '',
    ].map(esc).join(','));
    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n'); // BOM 让 Excel 正确识别 UTF-8
    const fname = `call_logs_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename=${fname}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  })
);

apiRouter.delete(
  '/call-logs',
  requireAuth,
  wrap(async (req, res) => {
    const days = Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30);
    const deleted = cleanupCallLogs(days);
    // 费用分摊报表以 call_logs 为数据源：提示管理员先导出财务月份再清理
    const cutoffCn = new Date(Date.now() - days * 24 * 3600 * 1000 + 8 * 3600_000).toISOString().slice(0, 10);
    res.json({
      ok: true,
      deleted,
      before_days: days,
      billing_warning: `已删除 ${cutoffCn}（含）之前的调用日志，更早月份的费用分摊报表将不再完整，请先导出需要保留的财务月份`,
    });
  })
);

// ---------- 费用分摊（月度对账） ----------

const BILLING_RATE_KEYS = ['credit_price', 'call_price', 'point_price'] as const;

/** 校验并规范化单价配置；非法输入返回错误文案，合法返回消毒后的完整配置 */
function sanitizeBillingRates(body: unknown): { ok: true; cfg: BillingRatesConfig } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求体必须是 JSON 对象' };
  const b = body as Record<string, unknown>;
  const out: BillingRatesConfig = { rates: {}, default_point_price: 0 };
  const dpp = b.default_point_price;
  if (typeof dpp !== 'number' || !Number.isFinite(dpp) || dpp < 0 || dpp > 1e6) {
    return { ok: false, error: 'default_point_price 必须是 0 ~ 1000000 之间的数字' };
  }
  out.default_point_price = Math.round(dpp * 1e6) / 1e6;
  const rawRates = b.rates;
  if (rawRates !== undefined && (rawRates === null || typeof rawRates !== 'object' || Array.isArray(rawRates))) {
    return { ok: false, error: 'rates 必须是 { upstream: { 单价 } } 形式的对象' };
  }
  for (const [upstream, r] of Object.entries((rawRates ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(upstream)) {
      return { ok: false, error: `非法的上游标识: ${upstream.slice(0, 32)}` };
    }
    if (r === undefined) continue;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, error: `上游 ${upstream} 的单价必须是对象` };
    }
    const item: BillingRate = {};
    for (const key of BILLING_RATE_KEYS) {
      const v = (r as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e6) {
        return { ok: false, error: `上游 ${upstream} 的 ${key} 必须是 0 ~ 1000000 之间的数字` };
      }
      (item as Record<string, number | undefined>)[key] = Math.round(v * 1e6) / 1e6;
    }
    if (Object.keys(item).length > 0) out.rates[upstream] = item;
  }
  return { ok: true, cfg: out };
}

apiRouter.get(
  '/billing/rates',
  requireAuth,
  wrap(async (_req, res) => {
    res.json({ rates: getBillingRates(), defaults: DEFAULT_BILLING_RATES, upstreams: listUpstreams().map((u) => u.id) });
  })
);

apiRouter.put(
  '/billing/rates',
  requireAuth,
  wrap(async (req, res) => {
    const r = sanitizeBillingRates(req.body);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    setBillingRates(r.cfg);
    res.json({ ok: true, rates: getBillingRates() });
  })
);

function parseBillingMonth(req: Request): { ok: true; month: string } | { ok: false; error: string } {
  const month = String(req.query.month ?? '').trim() || currentYearMonthCn();
  if (!isValidYearMonth(month)) return { ok: false, error: 'month 参数必须是 YYYY-MM 形式（如 2026-05）' };
  return { ok: true, month };
}

apiRouter.get(
  '/billing/report',
  requireAuth,
  wrap(async (req, res) => {
    const m = parseBillingMonth(req);
    if (!m.ok) {
      res.status(400).json({ error: m.error });
      return;
    }
    res.json(getMonthlyBillingReport(m.month));
  })
);

apiRouter.get(
  '/billing/export.csv',
  requireAuth,
  wrap(async (req, res) => {
    const m = parseBillingMonth(req);
    if (!m.ok) {
      res.status(400).json({ error: m.error });
      return;
    }
    const report = getMonthlyBillingReport(m.month);
    const headers = ['月份', '运营账号', '上游平台', '总调用数', '成功调用', '失败调用', '空壳调用', '消耗Credits', '自建分', '分摊金额(元)'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const rows = report.items.map((it) => [
      report.year_month, it.caller, it.upstream, it.total_calls,
      it.success_calls, it.failed_calls, it.empty_shell_calls,
      it.total_credits, it.total_points, it.cost_cny.toFixed(2),
    ].map(esc).join(','));
    const totalRow = [
      '总计', '', '', report.summary.total_calls, report.summary.success_calls,
      '', '', report.summary.total_credits, report.summary.total_points, report.summary.total_cny.toFixed(2),
    ].map(esc).join(',');
    const csv = '\uFEFF' + [headers.join(','), ...rows, totalRow].join('\r\n'); // BOM + CRLF，Excel 中文环境直接打开
    res.setHeader('Content-Disposition', `attachment; filename=billing_${report.year_month}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  })
);

apiRouter.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[api] 错误:', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: String(err instanceof Error ? err.message : err).slice(0, 300) });
}
