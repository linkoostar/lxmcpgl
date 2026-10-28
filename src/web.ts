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
  cleanupCallLogs,
  listUpstreams,
  getUpstream,
  upsertUpstream,
  deleteUpstream,
  getUpstreamToolCounts,
  maskUpstreamKey,
} from './db.js';
import { config, META_TOOLS } from './config.js';
import { getUpstreamClient, resetUpstreamClient, UpstreamError } from './upstream.js';
import { syncTools, syncUpstreamById, isSyncing, listTools, batchSetEnabled, syncAllUpstreams } from './sync.js';
import { getAdapter } from './adapter.js';
import { buildHealth } from './health.js';

const COOKIE_NAME = 'lx_session';
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
      `${COOKIE_NAME}=${encodeURIComponent(signSession(String(username)))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    res.json({ ok: true });
  })
);

apiRouter.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
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
      downstream_key: getSetting('downstream_key'),
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
      res.json({ [upstreamId]: r, totalSynced: r.synced });
    } else {
      const r = await syncAllUpstreams();
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
    res.json({ upstream_id: sid, ...r });
  })
);

apiRouter.post(
  '/upstreams/sync-all',
  requireAuth,
  wrap(async (_req, res) => {
    if (isSyncing()) { res.status(409).json({ error: '已有同步任务在进行中' }); return; }
    const r = await syncAllUpstreams();
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
    res.json(listTools(q, page, pageSize, toolType, enabled, upstream));
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
    res.json({ ok: true });
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
    const { items, tool_ids, all, q, upstream } = req.body ?? {};
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
      },
      enabled
    );
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
      const resp = await client.callTool('action', { toolId: 'get_my_sids', params: {} });
      if (resp?.error) throw new Error(JSON.stringify(resp.error).slice(0, 300));
      const text = resp?.result?.content?.find((c: any) => c?.type === 'text')?.text ?? '';
      const payload = JSON.parse(text);
      const list = payload?.data?.list ?? payload?.data ?? [];
      if (!Array.isArray(list)) throw new Error('get_my_sids 返回结构异常');
      for (const s of list) {
        const sid = s?.id ?? s?.sid;
        if (sid === undefined || sid === null) continue;
        upsertShop({
          sid: String(sid),
          name: String(s?.name ?? ''),
          country: String(s?.country ?? s?.country_code ?? ''),
          seller_id: String(s?.seller_id ?? ''),
        });
      }
      res.json({ ok: true, count: listShops().length });
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
      const shopIds = Array.isArray(req.body?.shop_ids)
        ? req.body.shop_ids.map(String)
        : getSettingJSON<string[]>('default_shops', []);
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
    res.json({ ok: true, deleted, before_days: days });
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
