import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { config, DEFAULT_UPSTREAM_URL } from './config.js';

export let db: Database.Database;

export function initDb(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(path.join(config.dataDir, 'gateway.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS tools (
      tool_id      TEXT PRIMARY KEY,
      exposed_name TEXT,
      name         TEXT DEFAULT '',
      description  TEXT DEFAULT '',
      input_schema TEXT,
      raw          TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL,
      key_hash    TEXT UNIQUE NOT NULL,
      key_prefix  TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      rate_limit  INTEGER NOT NULL DEFAULT 0,
      all_tools   INTEGER NOT NULL DEFAULT 1,
      all_shops   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT '',
      last_used_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_tools (
      user_id INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      PRIMARY KEY (user_id, tool_id)
    );
    CREATE TABLE IF NOT EXISTS shops (
      sid       TEXT PRIMARY KEY,
      name      TEXT DEFAULT '',
      country   TEXT DEFAULT '',
      seller_id TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_shops (
      user_id INTEGER NOT NULL,
      sid     TEXT NOT NULL,
      PRIMARY KEY (user_id, sid)
    );
    CREATE TABLE IF NOT EXISTS call_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      caller      TEXT NOT NULL,
      user_id     INTEGER,
      tool_name   TEXT NOT NULL,
      tool_id     TEXT,
      tool_type   TEXT,
      shop_refs   TEXT,
      success     INTEGER NOT NULL,
      is_error    INTEGER NOT NULL,
      duration_ms INTEGER,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_logs_ts     ON call_logs(ts);
    CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller);
    CREATE INDEX IF NOT EXISTS idx_call_logs_tool   ON call_logs(tool_name);

    -- ===== 多上游 M1 =====
    CREATE TABLE IF NOT EXISTS upstreams (
      id            TEXT PRIMARY KEY,            -- 'lingxing', 'xiyou-sif', 'sellermagic', 'nocodb'
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      api_key       TEXT,
      adapter       TEXT NOT NULL,              -- 'lingxing-meta', 'flat-mcp', 'nocodb'
      active        INTEGER DEFAULT 1,
      sync_strategy TEXT DEFAULT 'pull',
      shop_field    TEXT DEFAULT 'sid',
      notes         TEXT DEFAULT '',
      created_at    TEXT DEFAULT '',
      updated_at    TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS cost_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      upstream      TEXT NOT NULL,
      user_id       INTEGER,
      tool_name     TEXT NOT NULL,
      tool_id       TEXT,
      cost_credits  REAL DEFAULT 0,
      duration_ms   INTEGER,
      created_at    TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cost_logs_user     ON cost_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_cost_logs_upstream ON cost_logs(upstream);
  `);
  migrate();
  seed();
}

function migrate(): void {
  // ===== 原有迁移 =====
  const cols = (db.prepare(`PRAGMA table_info(tools)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('tool_type')) {
    db.exec(`ALTER TABLE tools ADD COLUMN tool_type TEXT DEFAULT ''`);
  }
  // ===== M1：多上游 — 给现有表加 upstream 归属 =====
  const tables: Array<{ name: string; defaultVal?: string; extraIdx?: string }> = [
    { name: 'tools',      defaultVal: 'lingxing', extraIdx: 'idx_tools_upstream' },
    { name: 'shops',      defaultVal: 'lingxing', extraIdx: 'idx_shops_upstream' },
    { name: 'users',      defaultVal: 'lingxing' },
    { name: 'user_tools', defaultVal: 'lingxing' },
    { name: 'user_shops', defaultVal: 'lingxing' },
    { name: 'call_logs',  defaultVal: 'lingxing', extraIdx: 'idx_call_logs_upstream' },
  ];
  for (const t of tables) {
    const cs = (db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cs.includes('upstream')) {
      db.exec(`ALTER TABLE ${t.name} ADD COLUMN upstream TEXT DEFAULT '${t.defaultVal}'`);
    }
    if (t.extraIdx) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${t.extraIdx} ON ${t.name}(upstream)`);
    }
  }
  // 数据兜底：任何 upstream 为 NULL/空的老记录补 'lingxing'
  db.exec(`UPDATE tools      SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE shops      SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE users      SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE user_tools SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE user_shops SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE call_logs  SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);

  // upstreams 表初始化领星记录（从现有 settings 取）
  const hasLingxing = db.prepare("SELECT 1 FROM upstreams WHERE id = 'lingxing'").get();
  if (!hasLingxing) {
    const url = getSetting('upstream_url') || DEFAULT_UPSTREAM_URL;
    const apiKey = getSetting('upstream_key'); // 可能为空，但先占位
    db.prepare(
      `INSERT INTO upstreams (id, name, url, api_key, adapter, active, sync_strategy, shop_field, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'poll', 'sid', '领星 ERP + 广告 + 财务 + 仓储 全平台数据源', ?, ?)`
    ).run('lingxing', '领星', url, apiKey, 'lingxing-meta', new Date().toISOString(), new Date().toISOString());
    console.log('[db] 已初始化 upstream: lingxing');
  }
  // upstreams 表补齐新列（ALTER 不会因为 CREATE TABLE IF NOT EXISTS 自动加）
  const upCols = (db.prepare(`PRAGMA table_info(upstreams)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!upCols.includes('shop_field')) db.exec(`ALTER TABLE upstreams ADD COLUMN shop_field TEXT DEFAULT 'sid'`);
  if (!upCols.includes('sync_strategy')) db.exec(`ALTER TABLE upstreams ADD COLUMN sync_strategy TEXT DEFAULT 'poll'`);
  if (!upCols.includes('notes')) db.exec(`ALTER TABLE upstreams ADD COLUMN notes TEXT DEFAULT ''`);
  if (!upCols.includes('created_at')) db.exec(`ALTER TABLE upstreams ADD COLUMN created_at TEXT DEFAULT ''`);
  if (!upCols.includes('updated_at')) db.exec(`ALTER TABLE upstreams ADD COLUMN updated_at TEXT DEFAULT ''`);

  // 工具分类兜底
  backfillToolTypes();
}

/** 老数据兜底：按工具名中的动词分词判断读写类型 */
const WRITE_TOKENS = new Set([
  'put', 'add', 'create', 'update', 'delete', 'del', 'set', 'modify', 'cancel',
  'edit', 'remove', 'save', 'import', 'send', 'archive', 'push', 'upload',
  'pause', 'enable', 'disable', 'adjust', 'audit', 'approve', 'reject',
  'mark', 'reset', 'bind', 'unbind', 'apply',
]);
function classifyByName(name: string): string {
  const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => WRITE_TOKENS.has(t)) ? 'write' : 'read';
}
function backfillToolTypes(): void {
  const rows = (db.prepare("SELECT tool_id FROM tools WHERE tool_type IS NULL OR tool_type = ''").all() as Array<{ tool_id: string }>);
  if (rows.length === 0) return;
  const stmt = db.prepare('UPDATE tools SET tool_type = ? WHERE tool_id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(classifyByName(r.tool_id), r.tool_id);
  });
  tx();
  console.log(`[db] 已为 ${rows.length} 个工具补算 tool_type 分类`);
}

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getSettingJSON<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function setSettingJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

function randomHex(n: number): string {
  return randomBytes(n).toString('hex');
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const calc = scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && timingSafeEqual(calc, expected);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function seed(): void {
  const defaults: Record<string, string> = {
    upstream_url: config.upstreamUrlEnv || DEFAULT_UPSTREAM_URL,
    upstream_key: config.upstreamKeyEnv,
    downstream_key: randomHex(24),
    session_secret: randomHex(32),
    admin_username: config.adminUsername,
    admin_password_hash: hashPassword(config.adminPassword),
    last_sync_at: '',
    block_write: '0',
    // 默认权限模板 —— 新增运营用户时自动继承
    // 安全起步：先 all_tools=0 + all_shops=1。工具白名单在 syncTools 首次完成后自动填 read 类。
    // 管理员随时可以在「系统设置」页改模板。
    default_tools_all: '0',
    default_shops_all: '1',
    default_tools: '[]',
    default_shops: '[]',
  };
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
}

// ---------- tools ----------

export interface ToolRow {
  tool_id: string;
  exposed_name: string | null;
  name: string;
  description: string;
  input_schema: string | null;
  raw: string | null;
  tool_type: string | null;
  upstream?: string;
  enabled: number;
  updated_at: string;
}

export function upsertTool(t: {
  tool_id: string;
  exposed_name: string;
  name: string;
  description: string;
  input_schema: string | null;
  raw?: string | null;
  tool_type: string;
  upstream?: string;
}): void {
  db.prepare(
    `INSERT INTO tools (tool_id, exposed_name, name, description, input_schema, raw, tool_type, upstream, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(tool_id) DO UPDATE SET
       exposed_name = excluded.exposed_name,
       name = excluded.name,
       description = excluded.description,
       input_schema = excluded.input_schema,
       raw = excluded.raw,
       tool_type = excluded.tool_type,
       upstream = COALESCE(excluded.upstream, tools.upstream),
       updated_at = excluded.updated_at`
  ).run(t.tool_id, t.exposed_name, t.name, t.description, t.input_schema, t.raw ?? null, t.tool_type, t.upstream ?? 'lingxing', new Date().toISOString());
}

export function getToolByExposedName(name: string): ToolRow | undefined {
  return db.prepare('SELECT * FROM tools WHERE exposed_name = ?').get(name) as ToolRow | undefined;
}

export function getToolById(toolId: string): ToolRow | undefined {
  return db.prepare('SELECT * FROM tools WHERE tool_id = ?').get(toolId) as ToolRow | undefined;
}

// ---------- shops ----------

export function upsertShop(s: { sid: string; name: string; country: string; seller_id: string }): void {
  db.prepare(
    `INSERT INTO shops (sid, name, country, seller_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET name = excluded.name, country = excluded.country,
       seller_id = excluded.seller_id, updated_at = excluded.updated_at`
  ).run(s.sid, s.name, s.country, s.seller_id, new Date().toISOString());
}

export function listShops(): Array<{ sid: string; name: string; country: string; seller_id: string }> {
  return db
    .prepare('SELECT sid, name, country, seller_id FROM shops ORDER BY sid')
    .all() as Array<{ sid: string; name: string; country: string; seller_id: string }>;
}

// ---------- users ----------

export interface UserRow {
  id: number;
  username: string;
  key_hash: string;
  key_prefix: string;
  enabled: number;
  rate_limit: number;
  all_tools: number;
  all_shops: number;
  upstream?: string;
  created_at: string;
  last_used_at: string;
}

export function getUserByKeyHash(hash: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE key_hash = ?').get(hash) as UserRow | undefined;
}

export function getUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
}

export function getUserToolIds(userId: number): string[] {
  return (db.prepare('SELECT tool_id FROM user_tools WHERE user_id = ?').all(userId) as Array<{ tool_id: string }>).map(
    (r) => r.tool_id
  );
}

export function getUserShopIds(userId: number): string[] {
  return (db.prepare('SELECT sid FROM user_shops WHERE user_id = ?').all(userId) as Array<{ sid: string }>).map(
    (r) => r.sid
  );
}

export function setUserTools(userId: number, toolIds: string[]): void {
  const del = db.prepare('DELETE FROM user_tools WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_tools (user_id, tool_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    del.run(userId);
    for (const t of toolIds) ins.run(userId, t);
  });
  tx();
}

export function setUserShops(userId: number, sids: string[]): void {
  const del = db.prepare('DELETE FROM user_shops WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_shops (user_id, sid) VALUES (?, ?)');
  const tx = db.transaction(() => {
    del.run(userId);
    for (const s of sids) ins.run(userId, s);
  });
  tx();
}

export function touchUser(userId: number): void {
  db.prepare('UPDATE users SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
}

// ---------- 工具查询辅助 ----------

export function getReadToolIds(): string[] {
  return (db.prepare('SELECT tool_id FROM tools WHERE tool_type = ?').all('read') as Array<{ tool_id: string }>).map(
    (r) => r.tool_id
  );
}

export function getToolCountByType(): { read: number; write: number; other: number } {
  const rows = db
    .prepare("SELECT tool_type, COUNT(*) AS c FROM tools GROUP BY tool_type")
    .all() as Array<{ tool_type: string; c: number }>;
  const result = { read: 0, write: 0, other: 0 };
  for (const r of rows) {
    if (r.tool_type === 'read') result.read = r.c;
    else if (r.tool_type === 'write') result.write = r.c;
    else result.other += r.c;
  }
  return result;
}

// ---------- call_logs ----------

export interface CallLog {
  id: number;
  ts: string;
  caller: string;
  user_id: number | null;
  tool_name: string;
  tool_id: string | null;
  tool_type: string | null;
  upstream?: string;
  shop_refs: string;
  success: number;
  is_error: number;
  duration_ms: number | null;
  error: string;
}

export function insertCallLog(l: {
  caller: string;
  user_id: number | null;
  tool_name: string;
  tool_id: string | null;
  tool_type: string | null;
  upstream?: string;
  shop_refs: string[] | null;
  success: boolean;
  is_error: boolean;
  duration_ms: number | null;
  error: string | null;
}): void {
  const err = l.error ? String(l.error).slice(0, 500) : '';
  const shops = l.shop_refs ? JSON.stringify(l.shop_refs.slice(0, 50)) : '';
  db.prepare(
    `INSERT INTO call_logs (ts, caller, user_id, tool_name, tool_id, tool_type, shop_refs, success, is_error, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    l.caller,
    l.user_id,
    l.tool_name,
    l.tool_id,
    l.tool_type,
    shops,
    l.success ? 1 : 0,
    l.is_error ? 1 : 0,
    l.duration_ms,
    err
  );
}

export function listCallLogs(opts: {
  q?: string;
  caller?: string;
  tool?: string;
  success?: '1' | '0';
  since?: string;
  page: number;
  pageSize: number;
}): { total: number; items: CallLog[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.q) {
    conds.push('(tool_name LIKE ? OR tool_id LIKE ? OR caller LIKE ? OR error LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like);
  }
  if (opts.caller) { conds.push('caller = ?'); args.push(opts.caller); }
  if (opts.tool) { conds.push('tool_name = ?'); args.push(opts.tool); }
  if (opts.success !== undefined) { conds.push('success = ?'); args.push(opts.success); }
  if (opts.since) { conds.push('ts >= ?'); args.push(opts.since); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM call_logs ${where}`).all(...args) as { c: number }[])[0].c;
  const rows = db
    .prepare(
      `SELECT * FROM call_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, opts.pageSize, (opts.page - 1) * opts.pageSize) as CallLog[];
  return { total, items: rows };
}

export function getCallLogStats(since?: string): {
  total: number;
  success: number;
  failed: number;
  unique_callers: number;
  unique_tools: number;
  avg_ms: number | null;
  top_tools: Array<{ tool_name: string; count: number }>;
  top_callers: Array<{ caller: string; count: number }>;
} {
  const w = since ? 'WHERE ts >= ?' : '';
  const a = since ? [since] : [];
  const summary = db
    .prepare(`SELECT COUNT(*) AS total, SUM(success) AS success, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed,
                     AVG(duration_ms) AS avg_ms, COUNT(DISTINCT caller) AS unique_callers, COUNT(DISTINCT tool_name) AS unique_tools
              FROM call_logs ${w}`)
    .all(...a)[0] as any;
  const topTools = db
    .prepare(`SELECT tool_name, COUNT(*) AS count FROM call_logs ${w} GROUP BY tool_name ORDER BY count DESC LIMIT 8`)
    .all(...a) as Array<{ tool_name: string; count: number }>;
  const topCallers = db
    .prepare(`SELECT caller, COUNT(*) AS count FROM call_logs ${w} GROUP BY caller ORDER BY count DESC LIMIT 6`)
    .all(...a) as Array<{ caller: string; count: number }>;
  return {
    total: summary.total ?? 0,
    success: summary.success ?? 0,
    failed: summary.failed ?? 0,
    unique_callers: summary.unique_callers ?? 0,
    unique_tools: summary.unique_tools ?? 0,
    avg_ms: summary.avg_ms != null ? Math.round(Number(summary.avg_ms)) : null,
    top_tools: topTools,
    top_callers: topCallers,
  };
}

export function cleanupCallLogs(beforeDays: number): number {
  const cutoff = new Date(Date.now() - beforeDays * 24 * 3600 * 1000).toISOString();
  const info = db.prepare('DELETE FROM call_logs WHERE ts < ?').run(cutoff);
  return info.changes;
}

// ===== M1.7：upstreams CRUD helper =====

export interface UpstreamRow {
  id: string;
  name: string;
  url: string;
  api_key: string;
  adapter: string;
  active: number;
  sync_strategy: string;
  shop_field: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export function listUpstreams(): UpstreamRow[] {
  return db.prepare('SELECT * FROM upstreams ORDER BY id').all() as UpstreamRow[];
}

export function getUpstream(id: string): UpstreamRow | undefined {
  return db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id) as UpstreamRow | undefined;
}

export function getUpstreamActive(id: string): UpstreamRow | undefined {
  return db.prepare('SELECT * FROM upstreams WHERE id = ? AND active = 1').get(id) as UpstreamRow | undefined;
}

export function listActiveUpstreams(): UpstreamRow[] {
  return db.prepare('SELECT * FROM upstreams WHERE active = 1 ORDER BY id').all() as UpstreamRow[];
}

export function upsertUpstream(row: {
  id: string;
  name: string;
  url: string;
  api_key?: string;
  adapter: string;
  active?: number;
  sync_strategy?: string;
  shop_field?: string;
  notes?: string;
}): UpstreamRow {
  const now = new Date().toISOString();
  const existing = getUpstream(row.id);
  // 新 key 为空则保留旧 key
  const finalKey = (row.api_key && row.api_key.trim() !== '') ? row.api_key.trim() : (existing?.api_key ?? '');
  db.prepare(
    `INSERT INTO upstreams (id, name, url, api_key, adapter, active, sync_strategy, shop_field, notes, created_at, updated_at)
     VALUES (@id, @name, @url, @api_key, @adapter, @active, @sync_strategy, @shop_field, @notes, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       api_key = excluded.api_key,
       adapter = excluded.adapter,
       active = excluded.active,
       sync_strategy = excluded.sync_strategy,
       shop_field = excluded.shop_field,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).run({
    id: row.id,
    name: row.name,
    url: row.url,
    api_key: finalKey,
    adapter: row.adapter,
    active: row.active ?? 1,
    sync_strategy: row.sync_strategy ?? 'pull',
    shop_field: row.shop_field ?? 'sid',
    notes: row.notes ?? '',
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return getUpstream(row.id)!;
}

export function deleteUpstream(id: string): number {
  // 级联：停用该 upstream 的所有 tools（但不删除，保留历史记录）
  db.prepare('UPDATE tools SET enabled = 0 WHERE upstream = ?').run(id);
  const info = db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);
  return info.changes;
}

/** 获取每个 upstream 的工具数量（给前端展示用） */
export function getUpstreamToolCounts(): Record<string, number> {
  const rows = db.prepare('SELECT upstream, COUNT(*) AS c FROM tools GROUP BY upstream').all() as Array<{ upstream: string; c: number }>;
  const r: Record<string, number> = {};
  for (const row of rows) r[row.upstream] = row.c;
  return r;
}

/** 给 API 用的脱敏版本（不返回 api_key 原文） */
export function maskUpstreamKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
