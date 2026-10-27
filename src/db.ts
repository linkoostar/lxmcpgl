import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
  `);
  seed();
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

function seed(): void {
  const defaults: Record<string, string> = {
    upstream_url: config.upstreamUrlEnv || DEFAULT_UPSTREAM_URL,
    upstream_key: config.upstreamKeyEnv,
    downstream_key: randomHex(24),
    session_secret: randomHex(32),
    admin_username: config.adminUsername,
    admin_password_hash: hashPassword(config.adminPassword),
    last_sync_at: '',
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
}): void {
  db.prepare(
    `INSERT INTO tools (tool_id, exposed_name, name, description, input_schema, raw, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(tool_id) DO UPDATE SET
       exposed_name = excluded.exposed_name,
       name = excluded.name,
       description = excluded.description,
       input_schema = excluded.input_schema,
       raw = excluded.raw,
       updated_at = excluded.updated_at`
  ).run(t.tool_id, t.exposed_name, t.name, t.description, t.input_schema, t.raw, new Date().toISOString());
}

export function getToolByExposedName(name: string): ToolRow | undefined {
  return db.prepare('SELECT * FROM tools WHERE exposed_name = ?').get(name) as ToolRow | undefined;
}

export function getToolById(toolId: string): ToolRow | undefined {
  return db.prepare('SELECT * FROM tools WHERE tool_id = ?').get(toolId) as ToolRow | undefined;
}
