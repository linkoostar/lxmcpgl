import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  db,
  getSetting,
  setSetting,
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
} from './db.js';
import { config, META_TOOLS } from './config.js';
import { getUpstreamClient, resetUpstreamClient, UpstreamError } from './upstream.js';
import { syncTools, isSyncing, listTools, batchSetEnabled } from './sync.js';

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

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, version: config.version });
});

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
    res.json({
      upstream_url: getSetting('upstream_url'),
      upstream_key_set: !!upstreamKey,
      upstream_key_masked: maskKey(upstreamKey),
      downstream_key: getSetting('downstream_key'),
      last_sync_at: getSetting('last_sync_at'),
      tool_count: toolCount,
      syncing: isSyncing(),
      block_write: getSetting('block_write') === '1',
      shop_count: listShops().length,
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
  wrap(async (_req, res) => {
    if (isSyncing()) {
      res.status(409).json({ error: '已有同步任务在进行中' });
      return;
    }
    if (!getSetting('upstream_key')) {
      res.status(400).json({ error: '请先配置上游密钥' });
      return;
    }
    const result = await syncTools();
    res.json(result);
  })
);

apiRouter.get(
  '/tools',
  requireAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(String(req.query.page_size ?? '50'), 10) || 50));
    res.json(listTools(q, page, pageSize));
  })
);

apiRouter.get(
  '/tools/:toolId',
  requireAuth,
  wrap(async (req, res) => {
    const tool = getToolById(String(req.params.toolId));
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
    const enabled = req.body?.enabled ? 1 : 0;
    const info = db.prepare('UPDATE tools SET enabled = ? WHERE tool_id = ?').run(enabled, String(req.params.toolId));
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
    const { tool_ids, all, q } = req.body ?? {};
    const enabled = !!req.body?.enabled;
    if (!Array.isArray(tool_ids) && all !== true) {
      res.status(400).json({ error: '请提供 tool_ids 或 all=true' });
      return;
    }
    const changed = batchSetEnabled(
      { tool_ids: Array.isArray(tool_ids) ? tool_ids.map(String) : undefined, all: all === true, q: String(q ?? '') },
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
    const info = db
      .prepare(
        'INSERT INTO users (username, key_hash, key_prefix, enabled, rate_limit, all_tools, all_shops, created_at, last_used_at) VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?)'
      )
      .run(username, sha256(key), key.slice(0, 8), rateLimit, new Date().toISOString(), '');
    res.json({ ok: true, id: info.lastInsertRowid, downstream_key: key });
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
      db.prepare('UPDATE users SET all_tools = ? WHERE id = ?').run(b.all_tools ? 1 : 0, u.id);
    }
    if (b.all_shops !== undefined) {
      db.prepare('UPDATE users SET all_shops = ? WHERE id = ?').run(b.all_shops ? 1 : 0, u.id);
    }
    if (Array.isArray(b.tool_ids)) {
      setUserTools(u.id, b.tool_ids.map(String));
    }
    if (Array.isArray(b.shop_ids)) {
      setUserShops(u.id, b.shop_ids.map(String));
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

apiRouter.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[api] 错误:', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: String(err instanceof Error ? err.message : err).slice(0, 300) });
}
