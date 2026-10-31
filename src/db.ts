import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { config, DEFAULT_UPSTREAM_URL, classifyByName } from './config.js';

/**
 * 店铺 ID 字段名常量 —— 全项目共用一份，避免口径漂移。
 * db.ts 的 collectShopRefs / declaredShopFieldsOf、sync.ts 的 schemaHasShopField 都用这份。
 */
export const SHOP_PARAM_KEYS = new Set<string>([
  // sid 本身及其复数
  'sid', 'sids',
  // 亚马逊 Store ID（纯数字，如 3894542930）
  'store_id', 'store_ids',
  // shop 别名（部分上游用 shop_id 代替 sid）
  'shop_id', 'shop_ids',
  // Amazon Seller ID（marketplace token，如 A1P8NM96COGRQG）
  'seller_id', 'seller_ids',
  // 广告 Profile ID（广告类工具，如 ad_campaign_report）
  'profile_id', 'profile_ids',
  // 部分上游用 account_id 等同 shop 维度
  'account_id', 'account_ids',
  // Amazon PVI ID（广告类工具的另一种 ID 形式）
  'pvi_ids',
]);

/**
 * 工具 schema 里声明的店铺字段（P0-1）
 *
 * 工具「是否需要店铺参数」由网关实时读工具自己的 input_schema 判断，
 * 不再靠人工审核的 shop_scope，也不再靠「请求里出现了某个店铺字段名」来猜。
 */
export interface DeclaredShopField {
  /** 字段名（小写，与 SHOP_PARAM_KEYS 同口径） */
  name: string;
  /** schema 里的原始字段名（注入参数时用它，避免大小写漂移） */
  key: string;
  /** 是否直接声明在 schema 顶层 properties（自动注入只认顶层） */
  topLevel: boolean;
  /** 顶层字段类型：string / array / unknown（嵌套字段无类型概念） */
  type: 'string' | 'array' | 'unknown';
}

/** 判断 schema 里某个属性节点的类型（够用即可：注入只关心 string / array） */
function shopFieldType(node: any): 'string' | 'array' | 'unknown' {
  if (!node || typeof node !== 'object') return 'unknown';
  const t = node.type;
  if (t === 'string') return 'string';
  if (t === 'array') return 'array';
  if (Array.isArray(t)) return 'unknown'; // 联合类型无法确定
  if (node.items) return 'array'; // 没写 type 但有 items → 数组
  return 'unknown';
}

/** 递归找出 schema 嵌套结构（properties / items / anyOf / oneOf / allOf）里的店铺字段 */
function collectNestedShopFields(schema: any, depth: number, map: Map<string, DeclaredShopField>): void {
  if (depth > 8 || !schema || typeof schema !== 'object') return;
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
      const key = k.toLowerCase();
      if (SHOP_PARAM_KEYS.has(key) && !map.has(key)) {
        map.set(key, { name: key, key: k, topLevel: false, type: 'unknown' });
      }
      collectNestedShopFields(v, depth + 1, map);
    }
  }
  if (schema.items) collectNestedShopFields(schema.items, depth + 1, map);
  for (const arr of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(arr)) {
      for (const sub of arr) collectNestedShopFields(sub, depth + 1, map);
    }
  }
}

function computeDeclaredShopFields(raw: string): DeclaredShopField[] {
  if (!raw.trim()) return [];
  let schema: any;
  try {
    schema = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const map = new Map<string, DeclaredShopField>();
  // 顶层 properties：自动注入的候选（带上原始字段名与类型）
  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? (schema.properties as Record<string, any>)
    : null;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      const key = k.toLowerCase();
      if (!SHOP_PARAM_KEYS.has(key)) continue;
      map.set(key, { name: key, key: k, topLevel: true, type: shopFieldType(v) });
    }
  }
  // 嵌套结构里的店铺字段（不可注入，但请求带上时同样参与校验）
  collectNestedShopFields(schema, 0, map);
  return [...map.values()];
}

/** schema 扫描结果缓存（按 schema 内容缓存，内容变则自动失效） */
const SHOP_FIELD_CACHE = new Map<string, DeclaredShopField[]>();
const SHOP_FIELD_CACHE_LIMIT = 512;

/**
 * 取出工具 schema 里声明的店铺字段。
 * 结果按 schema 内容缓存 —— 同一个 schema 不重复扫描，schema 一变缓存自然失效。
 */
export function declaredShopFieldsOf(inputSchema: string | null | undefined): DeclaredShopField[] {
  const raw = inputSchema ?? '';
  const hit = SHOP_FIELD_CACHE.get(raw);
  if (hit) return hit;
  const fields = computeDeclaredShopFields(raw);
  if (SHOP_FIELD_CACHE.size >= SHOP_FIELD_CACHE_LIMIT) {
    const oldest = SHOP_FIELD_CACHE.keys().next().value;
    if (oldest !== undefined) SHOP_FIELD_CACHE.delete(oldest);
  }
  SHOP_FIELD_CACHE.set(raw, fields);
  return fields;
}

/**
 * 请求里「带了值的」店铺字段名集合（只认 SHOP_PARAM_KEYS 里的字段名）。
 * 用于判断请求是否在指定字段上携带了店铺值。
 */
export function collectShopFieldsPresent(args: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
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
          if (typeof v === 'string') {
            if (v.split(',').map((s) => s.trim()).filter(Boolean).length > 0) out.add(key);
          } else if (Array.isArray(v)) {
            if (v.map((x) => String(x)).filter(Boolean).length > 0) out.add(key);
          } else if (typeof v === 'number' || typeof v === 'bigint') {
            out.add(key);
          }
        }
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    }
  };
  visit(args);
  return out;
}

/**
 * 递归提取请求参数里的所有店铺引用（值，不是字段名）。
 *
 * 审计复现：旧版只扫顶层 + 一层嵌套对象，不扫数组内对象
 * → {items:[{sid:"9999"}]}、{a:{b:{sid:"9999"}}} 全部漏掉 → shopRefs=0 →
 * 店铺校验判断错误 → 校验被绕过。
 *
 * 深度 6，遍历所有层级所有数组元素；与 collectShopFieldsPresent 同深度同口径。
 */
export function collectShopRefs(args: Record<string, unknown>): string[] {
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
      tool_id      TEXT NOT NULL,
      upstream     TEXT NOT NULL DEFAULT 'lingxing',
      exposed_name TEXT,
      name         TEXT DEFAULT '',
      description  TEXT DEFAULT '',
      input_schema TEXT,
      raw          TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT DEFAULT '',
      PRIMARY KEY (upstream, tool_id)
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
      store_id  TEXT DEFAULT '',
      profile_id TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_shops (
      user_id INTEGER NOT NULL,
      sid     TEXT NOT NULL,
      PRIMARY KEY (user_id, sid)
    );
    CREATE TABLE IF NOT EXISTS call_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      caller       TEXT NOT NULL,
      user_id      INTEGER,
      tool_name    TEXT NOT NULL,
      tool_id      TEXT,
      tool_type    TEXT,
      shop_refs    TEXT,
      success      INTEGER NOT NULL,
      is_error     INTEGER NOT NULL,
      duration_ms  INTEGER,
      error        TEXT,
      cost_credits REAL,
      effective_rows INTEGER,
      is_admin     INTEGER DEFAULT 0,
      is_empty_shell INTEGER DEFAULT 0
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
      created_at    TEXT DEFAULT '',
      is_admin      INTEGER DEFAULT 0,
      is_empty_shell INTEGER DEFAULT 0
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
    { name: 'users',      defaultVal: '' }, // '' 解锁全部 active upstream
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
  // 数据兜底：任何 upstream 为 NULL 的老记录补 'lingxing'
  // （call_logs 不处理空串：拒绝类调用的 upstream 可能确实为空，不能篡改成 lingxing）
  db.exec(`UPDATE tools      SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE shops      SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE user_tools SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE user_shops SET upstream = 'lingxing' WHERE upstream IS NULL OR upstream = ''`);
  db.exec(`UPDATE call_logs  SET upstream = 'lingxing' WHERE upstream IS NULL`);

  // ===== call_logs 加 cost_credits 列 =====
  // 调用记录里直接带上本次 credits 消耗，前端表格和 CSV 导出都能直接用，
  // 不用再 JOIN cost_logs（同一调用 cost_logs 也会写，保持双写方便做历史对账）。
  const clCols = (db.prepare(`PRAGMA table_info(call_logs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!clCols.includes('cost_credits')) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN cost_credits REAL`);
    console.log('[db] call_logs 已补 cost_credits 列');
  }
  if (!clCols.includes('effective_rows')) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN effective_rows INTEGER`);
    console.log('[db] call_logs 已补 effective_rows 列');
  }
  if (!clCols.includes('is_admin')) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN is_admin INTEGER DEFAULT 0`);
    console.log('[db] call_logs 已补 is_admin 列');
  }
  if (!clCols.includes('is_empty_shell')) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN is_empty_shell INTEGER DEFAULT 0`);
    console.log('[db] call_logs 已补 is_empty_shell 列');
  }

  // ===== cost_logs 也补 is_admin / is_empty_shell =====
  const coCols = (db.prepare(`PRAGMA table_info(cost_logs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!coCols.includes('is_admin')) {
    db.exec(`ALTER TABLE cost_logs ADD COLUMN is_admin INTEGER DEFAULT 0`);
    console.log('[db] cost_logs 已补 is_admin 列');
  }
  if (!coCols.includes('is_empty_shell')) {
    db.exec(`ALTER TABLE cost_logs ADD COLUMN is_empty_shell INTEGER DEFAULT 0`);
    console.log('[db] cost_logs 已补 is_empty_shell 列');
  }

  // ===== shops 表扩 store_id + profile_id =====
  // 领星 ad_campaign_report / FBA 等行内的 store_id 是 Amazon 店铺纯数字 id（如 3894542930），
  // 跟 seller_id（A1P8NM96COGRQG marketplace token）和 sid（1911 数字）值域都不相同。
  // 必须从 ad_auth_shops 接口拉完整映射才能正确桥接。
  const shopCols = (db.prepare(`PRAGMA table_info(shops)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!shopCols.includes('store_id')) {
    db.exec(`ALTER TABLE shops ADD COLUMN store_id TEXT DEFAULT ''`);
    console.log('[db] shops 已补 store_id 列');
  }
  if (!shopCols.includes('profile_id')) {
    db.exec(`ALTER TABLE shops ADD COLUMN profile_id TEXT DEFAULT ''`);
    console.log('[db] shops 已补 profile_id 列');
  }

  // ===== P0-2：tools 主键从 (tool_id) 迁移为 (upstream, tool_id) =====
  // 旧库 tool_id 是全局主键，多上游同名工具会互相覆盖（导致错上游、错 credits、错权限）。
  migrateToolsCompositePk();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tools_upstream ON tools(upstream)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tools_exposed ON tools(exposed_name)`);

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
  if (!upCols.includes('headers')) db.exec(`ALTER TABLE upstreams ADD COLUMN headers TEXT DEFAULT '{}'`);

  // ===== shop_scope：工具店铺隔离分类 =====
  // unreviewed（默认）= 未审核，受限运营不可调用
  // shop_scoped = 管理员确认按店铺参数隔离（需要店铺参数）
  // global_safe = 管理员确认全 ERP 级，不返回跨店数据
  const toolCols = (db.prepare(`PRAGMA table_info(tools)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!toolCols.includes('shop_scope')) {
    db.exec(`ALTER TABLE tools ADD COLUMN shop_scope TEXT DEFAULT 'unreviewed'`);
    console.log('[db] tools 已补 shop_scope 列（默认 unreviewed）');
  }
  // shop_scope_suggest = 同步时自动生成的建议值，不自动生效，需管理员确认
  if (!toolCols.includes('shop_scope_suggest')) {
    db.exec(`ALTER TABLE tools ADD COLUMN shop_scope_suggest TEXT DEFAULT ''`);
    console.log('[db] tools 已补 shop_scope_suggest 列');
  }
  // schema_hash = 上次 sync 时 input_schema 的 SHA256。
  // 上游改了 schema → hash 变化 → shop_scope 自动退回 unreviewed（人工审核过时了）
  if (!toolCols.includes('schema_hash')) {
    db.exec(`ALTER TABLE tools ADD COLUMN schema_hash TEXT DEFAULT ''`);
    console.log('[db] tools 已补 schema_hash 列');
  }

  // ===== gateway_points：网关自建消耗分 =====
  // tools.gateway_points = 每个工具默认消耗分（默认 1，可管理员 per-tool 调整）
  // call_logs.gateway_points = 本次调用实际计的分（成功 && 非空壳才给）
  // cost_logs.gateway_points = 聚合维度也带一份，方便费用分摊对账
  if (!toolCols.includes('gateway_points')) {
    db.exec(`ALTER TABLE tools ADD COLUMN gateway_points REAL DEFAULT 1`);
    console.log('[db] tools 已补 gateway_points 列（默认 1）');
  }
  const clCols2 = (db.prepare(`PRAGMA table_info(call_logs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!clCols2.includes('gateway_points')) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN gateway_points REAL DEFAULT 0`);
    console.log('[db] call_logs 已补 gateway_points 列');
  }
  const coCols2 = (db.prepare(`PRAGMA table_info(cost_logs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!coCols2.includes('gateway_points')) {
    db.exec(`ALTER TABLE cost_logs ADD COLUMN gateway_points REAL DEFAULT 0`);
    console.log('[db] cost_logs 已补 gateway_points 列');
  }

  // 工具分类兜底
  backfillToolTypes();
}

/**
 * 把旧版 tools(tool_id PRIMARY KEY) 重建为 (upstream, tool_id) 复合主键。
 * 幂等：已经是复合主键则直接返回。
 */
function migrateToolsCompositePk(): void {
  const info = db.prepare('PRAGMA table_info(tools)').all() as Array<{ name: string; pk: number }>;
  const pkCols = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (pkCols.length === 2 && pkCols[0] === 'upstream' && pkCols[1] === 'tool_id') return;

  console.log('[db] 迁移 tools 表主键 -> (upstream, tool_id)');
  const tx = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS tools_legacy_p0`);
    db.exec(`ALTER TABLE tools RENAME TO tools_legacy_p0`);
    db.exec(`
      CREATE TABLE tools (
        tool_id       TEXT NOT NULL,
        upstream      TEXT NOT NULL DEFAULT 'lingxing',
        exposed_name  TEXT,
        name          TEXT DEFAULT '',
        description   TEXT DEFAULT '',
        input_schema  TEXT,
        raw           TEXT,
        tool_type     TEXT DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT DEFAULT '',
        gateway_points REAL DEFAULT 1,
        PRIMARY KEY (upstream, tool_id)
      )
    `);
    // 历史数据同一 tool_id 只会有一条，upstream 已在上面的兜底 UPDATE 中补齐
    db.exec(`
      INSERT OR IGNORE INTO tools
        (tool_id, upstream, exposed_name, name, description, input_schema, raw, tool_type, enabled, updated_at)
      SELECT tool_id,
             COALESCE(NULLIF(upstream, ''), 'lingxing'),
             exposed_name, name, description, input_schema, raw,
             COALESCE(tool_type, ''), enabled, updated_at
      FROM tools_legacy_p0
    `);
    db.exec(`DROP TABLE tools_legacy_p0`);
  });
  tx();
}

/** 老数据兜底：按工具名中的动词分词判断读写类型（分类实现见 config.ts） */
function backfillToolTypes(): void {
  const rows = (db.prepare("SELECT upstream, tool_id FROM tools WHERE tool_type IS NULL OR tool_type = ''").all() as Array<{ upstream: string; tool_id: string }>);
  if (rows.length === 0) return;
  const stmt = db.prepare('UPDATE tools SET tool_type = ? WHERE upstream = ? AND tool_id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(classifyByName(r.tool_id), r.upstream, r.tool_id);
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

/**
 * 对 JSON 字符串先 canonicalize（key 排序）再 hash。
 * 评审指出：直接对原始 JSON string 哈希，上游只调整了字段顺序也会触发 schema_hash 变化 → 误退回 unreviewed。
 * canonicalize 后字段顺序不影响 hash，只有真正的内容变化才触发。
 */
function hashSchema(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr);
    const canonical = canonicalize(parsed);
    return sha256(canonical).slice(0, 16);
  } catch {
    return sha256(jsonStr).slice(0, 16); // parse 失败就 hash 原始字符串
  }
}

function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  return '{' + sortedKeys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
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
    // 安全起步：先 all_tools=0 + all_shops=0（锁死工具和店铺，白名单逐步开放）。
    // 之前是 default_shops_all=1（全店铺），sync 后运营静默拿到所有店铺数据，严重越权。
    default_tools_all: '0',
    default_shops_all: '0',
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
  shop_scope?: string; // unreviewed / shop_scoped / global_safe
  shop_scope_suggest?: string; // 自动生成的建议值
  schema_hash?: string; // 上次 sync 时的 input_schema hash
  gateway_points?: number; // 网关自建消耗分（默认 1，可 per-tool 调整）
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
  // 计算 input_schema 的 hash，用于检测上游 schema 变更
  const upstream = t.upstream ?? 'lingxing';
  const existing = db.prepare('SELECT shop_scope, schema_hash FROM tools WHERE upstream=? AND tool_id=?').get(upstream, t.tool_id) as { shop_scope: string; schema_hash: string } | undefined;

  let shopScope = existing?.shop_scope ?? 'unreviewed';
  let newHash: string;
  if (t.input_schema) {
    newHash = hashSchema(t.input_schema);
    // 上游改了 schema → 人工审核过时，自动退回 unreviewed
    if (existing?.shop_scope && existing.shop_scope !== 'unreviewed' && existing.schema_hash && existing.schema_hash !== newHash) {
      // 区分两种 hash 不一致：
      //   ① 算法切换：旧版用原始字符串哈希，新版用 canonicalize 后哈希
      //      → 用旧算法再算一次，如果和 existing 匹配，说明只是算法变了，不退回
      //   ② 上游 schema 真变了 → 用旧算法也算不出来，退回
      const oldAlgorithmHash = sha256(t.input_schema).slice(0, 16);
      if (oldAlgorithmHash === existing.schema_hash) {
        console.log(`[db] tool ${upstream}.${t.tool_id} hash 算法切换（旧原始→新规范化），shop_scope=${existing.shop_scope} 保持不变`);
      } else if (existing.shop_scope === 'global_safe') {
        // global_safe = 管理员确认的全局例外（例外清单）→ 不因上游 schema 变更被静默撤销
        console.log(`[db] tool ${upstream}.${t.tool_id} schema 变更 (${existing.schema_hash.slice(0,6)}→${newHash.slice(0,6)})，shop_scope=global_safe 例外清单保持不变`);
      } else {
        console.log(`[db] tool ${upstream}.${t.tool_id} schema 变更 (${existing.schema_hash.slice(0,6)}→${newHash.slice(0,6)})，shop_scope=${existing.shop_scope} 退回 unreviewed`);
        shopScope = 'unreviewed';
      }
    }
  } else {
    // sync 拉不到 schema（search 超时/上游抖动）→ 保留旧 hash + 旧 shop_scope
    // 因为 input_schema 本身会被 COALESCE 保留旧值，hash 也不应该被空值覆盖
    newHash = existing?.schema_hash ?? '';
    console.warn(`[db] tool ${upstream}.${t.tool_id} input_schema 为空，保留旧 hash=${newHash.slice(0,6) || '(空)'}`);
  }

  db.prepare(
    `INSERT INTO tools (tool_id, upstream, exposed_name, name, description, input_schema, raw, tool_type, enabled, updated_at, shop_scope, schema_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(upstream, tool_id) DO UPDATE SET
       exposed_name = excluded.exposed_name,
       name = excluded.name,
       description = excluded.description,
       input_schema = COALESCE(excluded.input_schema, input_schema),
       raw = excluded.raw,
       tool_type = excluded.tool_type,
       updated_at = excluded.updated_at,
       shop_scope = excluded.shop_scope,
       schema_hash = excluded.schema_hash`
  ).run(t.tool_id, upstream, t.exposed_name, t.name, t.description, t.input_schema, t.raw ?? null, t.tool_type, new Date().toISOString(), shopScope, newHash);
}

/**
 * 管理员手动设置 shop_scope —— 写入生效值，清空建议值（管理员确认了就不需要建议了）。
 * 同时更新 schema_hash 以当前最新值，避免后续 sync 把已审核的工具又退回 unreviewed。
 */
export function setToolShopScope(upstream: string, toolId: string, scope: 'unreviewed' | 'shop_scoped' | 'global_safe'): boolean {
  const tool = db.prepare('SELECT input_schema FROM tools WHERE upstream=? AND tool_id=?').get(upstream, toolId) as { input_schema: string | null } | undefined;
  const hash = tool?.input_schema ? hashSchema(tool.input_schema) : '';
  const result = db.prepare('UPDATE tools SET shop_scope=?, shop_scope_suggest=?, schema_hash=? WHERE upstream=? AND tool_id=?').run(scope, '', hash, upstream, toolId);
  return result.changes > 0;
}

/**
 * 按下游暴露名解析工具，且只在 allowedUpstreams 范围内查找（fail-closed）。
 * 多上游存在同名工具时，tools/list 会暴露 `upstream__name` 限定名，这里两种都支持。
 */
export function getToolByExposedName(name: string, allowedUpstreams: string[]): ToolRow | undefined {
  if (!allowedUpstreams.length) return undefined;
  const ph = allowedUpstreams.map(() => '?').join(',');
  const exact = db
    .prepare(`SELECT * FROM tools WHERE exposed_name = ? AND enabled = 1 AND upstream IN (${ph})`)
    .all(name, ...allowedUpstreams) as ToolRow[];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined; // 同名跨上游，必须用限定名
  for (const up of allowedUpstreams) {
    const prefix = `${up}__`;
    if (!name.startsWith(prefix)) continue;
    const row = db
      .prepare('SELECT * FROM tools WHERE upstream = ? AND exposed_name = ? AND enabled = 1')
      .get(up, name.slice(prefix.length)) as ToolRow | undefined;
    if (row) return row;
  }
  return undefined;
}

/** 按 (upstream, tool_id) 精确查询；upstream 缺省时返回任意一条（仅兼容旧调用） */
export function getToolById(toolId: string, upstream?: string): ToolRow | undefined {
  const row = upstream
    ? db.prepare('SELECT * FROM tools WHERE upstream = ? AND tool_id = ?').get(upstream, toolId)
    : db.prepare('SELECT * FROM tools WHERE tool_id = ? ORDER BY upstream LIMIT 1').get(toolId);
  return row as ToolRow | undefined;
}

// ---------- shops ----------

export function upsertShop(s: { sid: string; name: string; country: string; seller_id: string; store_id?: string; profile_id?: string }): void {
  db.prepare(
    `INSERT INTO shops (sid, name, country, seller_id, store_id, profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET name = excluded.name, country = excluded.country,
       seller_id = excluded.seller_id, store_id = excluded.store_id, profile_id = excluded.profile_id,
       updated_at = excluded.updated_at`
  ).run(s.sid, s.name, s.country, s.seller_id ?? '', s.store_id ?? '', s.profile_id ?? '', new Date().toISOString());
}

export function upsertShopByStoreId(s: { store_id: string; name: string; country: string; seller_id?: string; profile_id?: string }): void {
  // ad_auth_shops 里不一定带 sid，用 store_id 做主键兜底
  db.prepare(
    `INSERT INTO shops (sid, name, country, seller_id, store_id, profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET name = excluded.name, country = excluded.country,
       seller_id = excluded.seller_id, store_id = excluded.store_id, profile_id = excluded.profile_id,
       updated_at = excluded.updated_at`
  ).run(`store:${s.store_id}`, s.name, s.country, s.seller_id ?? '', s.store_id, s.profile_id ?? '', new Date().toISOString());
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
  return (db.prepare('SELECT DISTINCT tool_id FROM tools WHERE tool_type = ?').all('read') as Array<{ tool_id: string }>).map(
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
  cost_credits: number | null;
  effective_rows: number | null;
  is_admin: number;
  is_empty_shell: number;
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
  cost_credits?: number | null;
  effective_rows?: number | null;
  is_admin?: boolean;
  is_empty_shell?: boolean;
  gateway_points?: number | null;
}): void {
  const err = l.error ? String(l.error).slice(0, 500) : '';
  const shops = l.shop_refs ? JSON.stringify(l.shop_refs.slice(0, 50)) : '';
  db.prepare(
    `INSERT INTO call_logs (ts, caller, user_id, tool_name, tool_id, tool_type, upstream, shop_refs, success, is_error, duration_ms, error, cost_credits, effective_rows, is_admin, is_empty_shell, gateway_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    l.caller,
    l.user_id,
    l.tool_name,
    l.tool_id,
    l.tool_type,
    l.upstream ?? '',
    shops,
    l.success ? 1 : 0,
    l.is_error ? 1 : 0,
    l.duration_ms,
    err,
    l.cost_credits ?? null,
    l.effective_rows ?? null,
    l.is_admin ? 1 : 0,
    l.is_empty_shell ? 1 : 0,
    l.gateway_points ?? 0
  );
}

export function listCallLogs(opts: {
  q?: string;
  caller?: string;
  tool?: string;
  success?: '1' | '0';
  since?: string;
  until?: string;
  upstream?: string;
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
  if (opts.until) { conds.push('ts <= ?'); args.push(opts.until); }
  if (opts.upstream) { conds.push('upstream = ?'); args.push(opts.upstream); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM call_logs ${where}`).all(...args) as { c: number }[])[0].c;
  const rows = db
    .prepare(
      `SELECT * FROM call_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, opts.pageSize, (opts.page - 1) * opts.pageSize) as CallLog[];
  return { total, items: rows };
}

export interface CallLogStatsOpts {
  since?: string;
  until?: string;
  upstream?: string;
  caller?: string;
}

/** 抽 WHERE 拼装——getCallLogStats 和 trend endpoint 共用 */
export function buildCallLogsWhere(opts: CallLogStatsOpts = {}): { where: string; args: unknown[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.since) { conds.push('ts >= ?'); args.push(opts.since); }
  if (opts.until) { conds.push('ts <= ?'); args.push(opts.until); }
  if (opts.upstream) { conds.push('upstream = ?'); args.push(opts.upstream); }
  if (opts.caller) { conds.push('caller = ?'); args.push(opts.caller); }
  return { where: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', args };
}

export function getCallLogStats(opts: CallLogStatsOpts = {}): {
  total: number;
  success: number;
  failed: number;
  unique_callers: number;
  unique_tools: number;
  avg_ms: number | null;
  total_credits: number;
  total_gateway_points: number;
  upstream_stats: Array<{ upstream: string; count: number; credits: number; gateway_points: number; avg_ms: number }>;
  top_tools: Array<{ tool_name: string; upstream: string; count: number; credits: number; gateway_points: number }>;
  top_callers: Array<{ caller: string; count: number; credits: number; gateway_points: number; upstream_breakdown: Array<{ upstream: string; count: number; credits: number; gateway_points: number }> }>;
} {
  // call_logs where（ts 字段）
  const { where: clWhere, args: clArgs } = buildCallLogsWhere(opts);

  // cost_logs where（created_at），时间条件复用 opts.since/opts.until，其他用 upstream/caller 映射
  // 注意：cost_logs 的 WHERE 可能被拼进 LEFT JOIN users 的 SQL（callersCredits），所以所有列必须加 c. 前缀防歧义
  // uidRows 提前到 if 外声明，两个版本共用
  const uidRows = opts.caller
    ? (db.prepare("SELECT id FROM users WHERE username = ?").all(opts.caller) as Array<{ id: number }>)
    : [];

  const coConds: string[] = [];
  const coArgs: unknown[] = [];
  if (opts.since) { coConds.push('c.created_at >= ?'); coArgs.push(opts.since); }
  if (opts.until) { coConds.push('c.created_at <= ?'); coArgs.push(opts.until); }
  if (opts.upstream) { coConds.push('c.upstream = ?'); coArgs.push(opts.upstream); }
  if (opts.caller) {
    if (uidRows.length > 0) {
      const ph = uidRows.map(() => '?').join(',');
      coConds.push(`(c.user_id IN (${ph}) OR c.user_id IS NULL)`);
      coArgs.push(...uidRows.map((r) => r.id));
    } else {
      coConds.push('c.user_id IS NULL');
    }
  }
  const coWhere = coConds.length > 0 ? `WHERE ${coConds.join(' AND ')}` : '';

  // 无前缀版本（单表 FROM cost_logs 的查询用，避免多余的 c. 别名）
  const coCondsPlain: string[] = [];
  const coArgsPlain: unknown[] = [];
  if (opts.since) { coCondsPlain.push('created_at >= ?'); coArgsPlain.push(opts.since); }
  if (opts.until) { coCondsPlain.push('created_at <= ?'); coArgsPlain.push(opts.until); }
  if (opts.upstream) { coCondsPlain.push('upstream = ?'); coArgsPlain.push(opts.upstream); }
  if (opts.caller) {
    if (uidRows.length > 0) {
      const ph = uidRows.map(() => '?').join(',');
      coCondsPlain.push(`(user_id IN (${ph}) OR user_id IS NULL)`);
      coArgsPlain.push(...uidRows.map((r: { id: number }) => r.id));
    } else {
      coCondsPlain.push('user_id IS NULL');
    }
  }
  const coWherePlain = coCondsPlain.length > 0 ? `WHERE ${coCondsPlain.join(' AND ')}` : '';

  const summary = db
    .prepare(`SELECT COUNT(*) AS total, SUM(success) AS success, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed,
                     AVG(duration_ms) AS avg_ms, COUNT(DISTINCT caller) AS unique_callers, COUNT(DISTINCT tool_name) AS unique_tools,
                     COALESCE(SUM(gateway_points), 0) AS total_gateway_points
              FROM call_logs ${clWhere}`)
    .all(...clArgs)[0] as any;

  // upstream 维度汇总 —— call_logs 单独算 count/avg/gateway_points，cost_logs 单独算 credits，最后 JOIN 回来
  // 避免 COUNT(*) 在多对多 JOIN 时被放大
  const upstreamCount = db
    .prepare(`SELECT upstream, COUNT(*) AS count, AVG(duration_ms) AS avg_ms, COALESCE(SUM(gateway_points), 0) AS gateway_points
              FROM call_logs ${clWhere} GROUP BY upstream`)
    .all(...clArgs) as Array<{ upstream: string; count: number; avg_ms: number | null; gateway_points: number }>;

  const upstreamCredits = db
    .prepare(`SELECT upstream, COALESCE(SUM(cost_credits), 0) AS credits
              FROM cost_logs ${coWherePlain} GROUP BY upstream`)
    .all(...coArgsPlain) as Array<{ upstream: string; credits: number }>;

  const creditsMap = new Map(upstreamCredits.map((r) => [r.upstream, Number(r.credits)]));
  const upstreamStats = upstreamCount
    .map((u) => ({
      upstream: u.upstream,
      count: u.count,
      credits: creditsMap.get(u.upstream) ?? 0,
      gateway_points: Number(u.gateway_points),
      avg_ms: u.avg_ms != null ? Math.round(Number(u.avg_ms)) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // 全局总 credits（独立 SUM，不跟 call_logs JOIN）
  const totalCreditsRow = db
    .prepare(`SELECT COALESCE(SUM(cost_credits), 0) AS total FROM cost_logs ${coWherePlain}`)
    .all(...coArgsPlain)[0] as { total: number };

  // top_tools — call_logs 算 count/success/failed/gateway_points，cost_logs 单独算 credits，JOIN 回来避免多对多放大
  const topToolsCount = db
    .prepare(`SELECT upstream, tool_name, COUNT(*) AS count,
                     SUM(success) AS success_count,
                     SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed_count,
                     COALESCE(SUM(gateway_points), 0) AS gateway_points
              FROM call_logs ${clWhere} GROUP BY upstream, tool_name ORDER BY count DESC LIMIT 8`)
    .all(...clArgs) as Array<{ upstream: string; tool_name: string; count: number; success_count: number; failed_count: number; gateway_points: number }>;

  // 只算成功调用的 credits（SIF: "只有成功返回有效数据才扣除点数"；空壳已归零，cost_logs 里是 0）
  // JOIN cost_logs 时用 upstream + tool_name + 时间区间匹配，避免跨天/跨用户重复计数
  const topToolsCredits = db
    .prepare(`SELECT upstream, tool_name, COALESCE(SUM(cost_credits), 0) AS credits,
                     SUM(CASE WHEN cost_credits > 0 THEN 1 ELSE 0 END) AS charged_count
              FROM cost_logs ${coWherePlain} GROUP BY upstream, tool_name`)
    .all(...coArgsPlain) as Array<{ upstream: string; tool_name: string; credits: number; charged_count: number }>;

  const toolCreditsMap = new Map(topToolsCredits.map((r) => [`${r.upstream}\u0000${r.tool_name}`, { credits: Number(r.credits), charged: r.charged_count }]));
  const topTools = topToolsCount.map((t) => {
    const creditInfo = toolCreditsMap.get(`${t.upstream}\u0000${t.tool_name}`) ?? { credits: 0, charged: 0 };
    return {
      tool_name: t.tool_name,
      upstream: t.upstream,
      count: t.count,
      success_count: t.success_count ?? 0,
      failed_count: t.failed_count ?? 0,
      credits: creditInfo.credits,
      gateway_points: Number(t.gateway_points),
      charged_count: creditInfo.charged,
    };
  });
  // top_callers — call_logs 算 count + gateway_points，cost_logs 算 credits。cost_logs 里 user_id 指向 users.id（运营用户），
  // admin 调用 user_id=NULL；call_logs 里 caller 存的是 username（admin/运营用户名）
  // 所以需要通过 users 表 JOIN：call_logs.caller = users.username 对应 cost_logs.user_id = users.id
  const callersRaw = db
    .prepare(`SELECT caller, COUNT(*) AS count, COALESCE(SUM(gateway_points), 0) AS gateway_points
              FROM call_logs ${clWhere} GROUP BY caller ORDER BY count DESC LIMIT 6`)
    .all(...clArgs) as Array<{ caller: string; count: number; gateway_points: number }>;

  const callersCredits = db
    .prepare(`SELECT COALESCE(u.username, 'admin') AS caller, c.upstream,
                     COUNT(*) AS count, COALESCE(SUM(c.cost_credits), 0) AS credits
              FROM cost_logs c LEFT JOIN users u ON c.user_id = u.id
              ${coWhere}
              GROUP BY caller, c.upstream`)
    .all(...coArgs) as Array<{ caller: string; upstream: string; count: number; credits: number }>;

  // callers 的 gateway_points 也按 upstream 拆开（从 call_logs 来）
  const callersGwPerUp = db
    .prepare(`SELECT caller, upstream, COALESCE(SUM(gateway_points), 0) AS gateway_points
              FROM call_logs ${clWhere} GROUP BY caller, upstream`)
    .all(...clArgs) as Array<{ caller: string; upstream: string; gateway_points: number }>;
  const gwMap = new Map<string, Map<string, number>>();
  for (const r of callersGwPerUp) {
    if (!gwMap.has(r.caller)) gwMap.set(r.caller, new Map());
    gwMap.get(r.caller)!.set(r.upstream, Number(r.gateway_points));
  }

  // 聚合：先按 caller 汇总总 credits，再构建 per-upstream breakdown
  const callerCreditsMap = new Map<string, { total: number; upstreams: Map<string, number> }>();
  for (const row of callersCredits) {
    if (!callerCreditsMap.has(row.caller)) callerCreditsMap.set(row.caller, { total: 0, upstreams: new Map() });
    const entry = callerCreditsMap.get(row.caller)!;
    entry.total += Number(row.credits);
    entry.upstreams.set(row.upstream, Number(row.credits));
  }

  const topCallers = callersRaw.map((c) => {
    const creditInfo = callerCreditsMap.get(c.caller);
    const gwByUp = gwMap.get(c.caller);
    const breakdown: Array<{ upstream: string; count: number; credits: number; gateway_points: number }> = [];
    // 上游调用次数从 call_logs 来（cost_logs 没 count，JOIN 一下）
    const perUpCountSql = `SELECT upstream, COUNT(*) AS count FROM call_logs ${clWhere}${clWhere ? ' AND' : ' WHERE'} caller = ? GROUP BY upstream`;
    const perUpCount = db
      .prepare(perUpCountSql)
      .all(...clArgs, c.caller) as Array<{ upstream: string; count: number }>;
    for (const u of perUpCount) {
      breakdown.push({
        upstream: u.upstream,
        count: u.count,
        credits: creditInfo?.upstreams.get(u.upstream) ?? 0,
        gateway_points: gwByUp?.get(u.upstream) ?? 0,
      });
    }
    return {
      caller: c.caller,
      count: c.count,
      credits: creditInfo?.total ?? 0,
      gateway_points: Number(c.gateway_points),
      upstream_breakdown: breakdown.sort((a, b) => b.count - a.count),
    };
  });

  return {
    total: summary.total ?? 0,
    success: summary.success ?? 0,
    failed: summary.failed ?? 0,
    unique_callers: summary.unique_callers ?? 0,
    unique_tools: summary.unique_tools ?? 0,
    avg_ms: summary.avg_ms != null ? Math.round(Number(summary.avg_ms)) : null,
    total_credits: Number(totalCreditsRow?.total ?? 0),
    total_gateway_points: Number(summary.total_gateway_points ?? 0),
    upstream_stats: upstreamStats,
    top_tools: topTools,
    top_callers: topCallers,
  };
}

export function cleanupCallLogs(beforeDays: number): number {
  const cutoff = new Date(Date.now() - beforeDays * 24 * 3600 * 1000).toISOString();
  const info = db.prepare('DELETE FROM call_logs WHERE ts < ?').run(cutoff);
  return info.changes;
}

/** 时间序列趋势 —— 按小时或天 bucket 聚合 */
export function getCallLogTrend(
  opts: CallLogStatsOpts & { granularity?: 'hour' | 'day' } = {}
): Array<{ bucket: string; calls: number; success: number; failed: number; gateway_points: number; upstream_credits: number }> {
  const MAX_BUCKETS = 720; // 防爆炸：小时粒度 30 天 = 720，超过自动降级
  let granularity = opts.granularity ?? 'day';

  // 默认时间范围：没传就拉最近 30 天
  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const until = opts.until ?? new Date().toISOString();
  const ms = new Date(until).getTime() - new Date(since).getTime();

  // bucket 数量超了就降级
  let fmt = granularity === 'hour' ? '%Y-%m-%d %H' : '%Y-%m-%d';
  let bucketMs = granularity === 'hour' ? 3600_000 : 86400_000;
  if (ms / bucketMs > MAX_BUCKETS && granularity === 'hour') {
    granularity = 'day';
    fmt = '%Y-%m-%d';
    bucketMs = 86400_000;
  }

  const { where: clWhere, args: clArgs } = buildCallLogsWhere({ ...opts, since, until });

  // call_logs 直接算 calls/success/failed/gateway_points
  const rows = db
    .prepare(`SELECT strftime('${fmt}', ts) AS bucket,
                     COUNT(*) AS calls,
                     SUM(success) AS success,
                     SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed,
                     COALESCE(SUM(gateway_points), 0) AS gateway_points
              FROM call_logs ${clWhere} GROUP BY bucket ORDER BY bucket ASC`)
    .all(...clArgs) as Array<{ bucket: string; calls: number; success: number; failed: number; gateway_points: number }>;

  // upstream_credits 从 cost_logs 查（相同 bucket 分组）
  const coConds: string[] = [];
  const coArgs: unknown[] = [];
  coConds.push('created_at >= ?'); coArgs.push(since);
  coConds.push('created_at <= ?'); coArgs.push(until);
  if (opts.upstream) { coConds.push('upstream = ?'); coArgs.push(opts.upstream); }
  if (opts.caller) {
    const uidRows = db.prepare("SELECT id FROM users WHERE username = ?").all(opts.caller) as Array<{ id: number }>;
    if (uidRows.length > 0) {
      const ph = uidRows.map(() => '?').join(',');
      coConds.push(`(user_id IN (${ph}) OR user_id IS NULL)`);
      coArgs.push(...uidRows.map((r) => r.id));
    } else {
      coConds.push('user_id IS NULL');
    }
  }
  const coWhere = coConds.length > 0 ? `WHERE ${coConds.join(' AND ')}` : '';

  const creditRows = db
    .prepare(`SELECT strftime('${fmt}', created_at) AS bucket, COALESCE(SUM(cost_credits), 0) AS upstream_credits
              FROM cost_logs ${coWhere} GROUP BY bucket`)
    .all(...coArgs) as Array<{ bucket: string; upstream_credits: number }>;
  const creditMap = new Map(creditRows.map((r) => [r.bucket, Number(r.upstream_credits)]));

  // 合并——以 call_logs 的 bucket 为主，补 cost_logs 的 credits
  return rows.map((r) => ({
    bucket: r.bucket,
    calls: r.calls,
    success: r.success ?? 0,
    failed: r.failed ?? 0,
    gateway_points: Number(r.gateway_points),
    upstream_credits: creditMap.get(r.bucket) ?? 0,
  }));
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
  headers: string; // JSON string, e.g. '{"x-api-key":"xxx"}'
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
  headers?: string | Record<string, string>;
}): UpstreamRow {
  const now = new Date().toISOString();
  const existing = getUpstream(row.id);
  // 新 key 为空则保留旧 key
  const finalKey = (row.api_key && row.api_key.trim() !== '') ? row.api_key.trim() : (existing?.api_key ?? '');
  // headers: null/undefined 保留旧，对象或字符串都转成 JSON 字符串
  let finalHeaders = existing?.headers ?? '{}';
  if (row.headers !== undefined && row.headers !== null) {
    if (typeof row.headers === 'string') finalHeaders = row.headers.trim() || '{}';
    else finalHeaders = JSON.stringify(row.headers);
  }
  db.prepare(
    `INSERT INTO upstreams (id, name, url, api_key, adapter, active, sync_strategy, shop_field, notes, headers, created_at, updated_at)
     VALUES (@id, @name, @url, @api_key, @adapter, @active, @sync_strategy, @shop_field, @notes, @headers, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       api_key = excluded.api_key,
       adapter = excluded.adapter,
       active = excluded.active,
       sync_strategy = excluded.sync_strategy,
       shop_field = excluded.shop_field,
       notes = excluded.notes,
       headers = excluded.headers,
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
    headers: finalHeaders,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return getUpstream(row.id)!;
}

/** 把 UpstreamRow.headers JSON 字符串安全解析成对象（调用方用） */
export function parseUpstreamHeaders(row: UpstreamRow | undefined): Record<string, string> {
  if (!row?.headers) return {};
  try {
    const obj = JSON.parse(row.headers);
    if (typeof obj === 'object' && obj !== null) return obj as Record<string, string>;
    return {};
  } catch {
    return {};
  }
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

// ---------- 费用分摊（月度对账） ----------
// 纯聚合层：只在 call_logs 上做月度 GROUP BY，不改表结构、不写新表。
// 计费口径（三处一致：报表 / CSV / 前端展示都由这里算出）：
//   金额 = 成功Credits × credit_price + 有效调用 × call_price + 自建分 × point_price
//   - Credits 只计成功调用（上游失败是否扣费无法透传得知，默认拒绝计费）
//   - 有效调用 = success=1 且非空壳（空壳行没有真实数据产出，不收按次费）
//   - point_price：上游显式配置了 point_price 用之；否则只要该上游配置了
//     任一非零 credit_price / call_price 就不再叠加分价（防双重计费）；
//     都没配置才用 default_point_price（领星免费自建 → 只算自建分的口径）。
// 账期口径：Asia/Shanghai 自然月（财务），换算成 UTC 区间后与 ts（UTC ISO）比较。

export interface BillingRate {
  credit_price?: number; // 元 / 上游 Credit
  call_price?: number; // 元 / 次有效调用
  point_price?: number; // 元 / 网关自建分（缺省时按回退规则取值）
}

export interface BillingRatesConfig {
  rates: Record<string, BillingRate>; // key = upstream id
  default_point_price: number; // 未配置单价的上游按此价计自建分
}

export const DEFAULT_BILLING_RATES: BillingRatesConfig = {
  rates: {},
  default_point_price: 0.01,
};

/** 单行分摊明细（caller × upstream） */
export interface BillingReportItem {
  caller: string;
  user_id: number | null;
  upstream: string;
  total_calls: number;
  success_calls: number; // success=1 且非空壳（计 call_price 的口径）
  failed_calls: number; // success=0
  empty_shell_calls: number; // success=1 但空壳（不收按次费）
  total_credits: number; // 仅成功调用
  total_points: number;
  cost_cny: number; // 保留 2 位
  rate_usage: { credit_price: number; call_price: number; point_price: number };
}

export interface MonthlyBillingPayload {
  year_month: string;
  since: string; // UTC ISO，上海自然月起点
  until: string;
  rates: BillingRatesConfig;
  summary: {
    total_calls: number;
    success_calls: number;
    total_credits: number;
    total_points: number;
    total_cny: number;
  };
  by_caller: Array<{
    caller: string;
    total_calls: number;
    total_credits: number;
    total_points: number;
    total_cny: number;
    items: BillingReportItem[];
  }>;
  items: BillingReportItem[];
}

export function isValidYearMonth(s: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
}

/** 上海时间自然月 → UTC 区间 [since, until)，与 ts（UTC ISO）做字符串比较 */
function monthRangeCn(yearMonth: string): { since: string; until: string } {
  const y = Number(yearMonth.slice(0, 4));
  const mo = Number(yearMonth.slice(5, 7));
  const nextY = mo === 12 ? y + 1 : y;
  const nextM = mo === 12 ? 1 : mo + 1;
  return {
    since: new Date(`${yearMonth}-01T00:00:00+08:00`).toISOString(),
    until: new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00+08:00`).toISOString(),
  };
}

/** 当前月份（上海时间），报表默认值 */
export function currentYearMonthCn(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
}

function clampRate(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6) / 1e6;
}

/** 读取并消毒单价配置（历史脏数据不影响报表，非法字段按未配置处理） */
export function getBillingRates(): BillingRatesConfig {
  const raw = getSettingJSON<Partial<BillingRatesConfig> | null>('billing_rates', null);
  const rates: Record<string, BillingRate> = {};
  if (raw && typeof raw === 'object' && raw.rates && typeof raw.rates === 'object') {
    for (const [k, r] of Object.entries(raw.rates)) {
      if (!r || typeof r !== 'object') continue;
      const item: BillingRate = {};
      const cp = clampRate((r as BillingRate).credit_price);
      const kp = clampRate((r as BillingRate).call_price);
      const pp = clampRate((r as BillingRate).point_price);
      if (cp !== undefined) item.credit_price = cp;
      if (kp !== undefined) item.call_price = kp;
      if (pp !== undefined) item.point_price = pp;
      if (Object.keys(item).length > 0) rates[String(k).trim().slice(0, 64)] = item;
    }
  }
  const dpp = clampRate(raw?.default_point_price);
  return { rates, default_point_price: dpp ?? DEFAULT_BILLING_RATES.default_point_price };
}

/** 写入单价配置（校验在 web 层做，这里只负责落库） */
export function setBillingRates(cfg: BillingRatesConfig): void {
  setSettingJSON('billing_rates', cfg);
}

/** 该上游生效的自建分单价（防双重计费回退规则，见区块头注释） */
function pointPriceOf(rate: BillingRate | undefined, defaultPointPrice: number): number {
  if (rate?.point_price !== undefined) return rate.point_price;
  if (rate && ((rate.credit_price ?? 0) > 0 || (rate.call_price ?? 0) > 0)) return 0;
  return defaultPointPrice;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 月度费用分摊报表（fail-soft：无数据月份返回全 0，不报错） */
export function getMonthlyBillingReport(yearMonth: string): MonthlyBillingPayload {
  if (!isValidYearMonth(yearMonth)) throw new Error(`非法月份参数: ${yearMonth}`);
  const rates = getBillingRates();
  const { since, until } = monthRangeCn(yearMonth);

  const rows = db
    .prepare(
      `SELECT l.caller,
              u.id AS user_id,
              COALESCE(NULLIF(l.upstream, ''), 'unknown') AS upstream,
              COUNT(*) AS total_calls,
              SUM(CASE WHEN l.success = 1 AND COALESCE(l.is_empty_shell, 0) = 0 THEN 1 ELSE 0 END) AS success_calls,
              SUM(CASE WHEN l.success = 0 THEN 1 ELSE 0 END) AS failed_calls,
              SUM(CASE WHEN l.success = 1 AND COALESCE(l.is_empty_shell, 0) = 1 THEN 1 ELSE 0 END) AS empty_shell_calls,
              COALESCE(SUM(CASE WHEN l.success = 1 THEN l.cost_credits ELSE 0 END), 0) AS total_credits,
              COALESCE(SUM(COALESCE(l.gateway_points, 0)), 0) AS total_points
       FROM call_logs l
       LEFT JOIN users u ON u.username = l.caller
       WHERE l.ts >= ? AND l.ts < ?
       GROUP BY l.caller, COALESCE(NULLIF(l.upstream, ''), 'unknown')
       ORDER BY l.caller ASC, total_calls DESC, upstream ASC`
    )
    .all(since, until) as Array<{
    caller: string;
    user_id: number | null;
    upstream: string;
    total_calls: number;
    success_calls: number;
    failed_calls: number;
    empty_shell_calls: number;
    total_credits: number;
    total_points: number;
  }>;

  const items: BillingReportItem[] = rows.map((r) => {
    const rate = rates.rates[r.upstream];
    const creditPrice = rate?.credit_price ?? 0;
    const callPrice = rate?.call_price ?? 0;
    const pointPrice = pointPriceOf(rate, rates.default_point_price);
    const cost =
      (r.total_credits ?? 0) * creditPrice + (r.success_calls ?? 0) * callPrice + (r.total_points ?? 0) * pointPrice;
    return {
      caller: r.caller,
      user_id: r.user_id ?? null,
      upstream: r.upstream,
      total_calls: r.total_calls ?? 0,
      success_calls: r.success_calls ?? 0,
      failed_calls: r.failed_calls ?? 0,
      empty_shell_calls: r.empty_shell_calls ?? 0,
      total_credits: Math.round((r.total_credits ?? 0) * 1e4) / 1e4,
      total_points: Math.round((r.total_points ?? 0) * 1e4) / 1e4,
      cost_cny: round2(cost),
      rate_usage: { credit_price: creditPrice, call_price: callPrice, point_price: pointPrice },
    };
  });

  const byCaller = new Map<string, MonthlyBillingPayload['by_caller'][number]>();
  for (const it of items) {
    let g = byCaller.get(it.caller);
    if (!g) {
      g = { caller: it.caller, total_calls: 0, total_credits: 0, total_points: 0, total_cny: 0, items: [] };
      byCaller.set(it.caller, g);
    }
    g.total_calls += it.total_calls;
    g.total_credits += it.total_credits;
    g.total_points += it.total_points;
    g.total_cny += it.cost_cny;
    g.items.push(it);
  }
  const by_caller = [...byCaller.values()].map((g) => ({ ...g, total_cny: round2(g.total_cny) }));

  const summary = {
    total_calls: items.reduce((a, b) => a + b.total_calls, 0),
    success_calls: items.reduce((a, b) => a + b.success_calls, 0),
    total_credits: Math.round(items.reduce((a, b) => a + b.total_credits, 0) * 1e4) / 1e4,
    total_points: Math.round(items.reduce((a, b) => a + b.total_points, 0) * 1e4) / 1e4,
    total_cny: round2(items.reduce((a, b) => a + b.cost_cny, 0)),
  };

  return { year_month: yearMonth, since, until, rates, summary, by_caller, items };
}
