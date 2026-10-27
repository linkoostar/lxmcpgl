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
  `);
  migrate();
  seed();
}

function migrate(): void {
  // 老库补充列（新增列不会由 CREATE TABLE IF NOT EXISTS 处理）
  const cols = (db.prepare(`PRAGMA table_info(tools)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('tool_type')) {
    db.exec(`ALTER TABLE tools ADD COLUMN tool_type TEXT DEFAULT ''`);
  }
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
  enabled: number;
  updated_at: string;
}

export function upsertTool(t: {
  tool_id: string;
  exposed_name: string;
  name: string;
  description: string;
  input_schema: string | null;
  raw: string | null;
  tool_type: string;
}): void {
  db.prepare(
    `INSERT INTO tools (tool_id, exposed_name, name, description, input_schema, raw, tool_type, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(tool_id) DO UPDATE SET
       exposed_name = excluded.exposed_name,
       name = excluded.name,
       description = excluded.description,
       input_schema = excluded.input_schema,
       raw = excluded.raw,
       tool_type = excluded.tool_type,
       updated_at = excluded.updated_at`
  ).run(t.tool_id, t.exposed_name, t.name, t.description, t.input_schema, t.raw, t.tool_type, new Date().toISOString());
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
