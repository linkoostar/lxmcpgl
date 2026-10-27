import { db, getSetting, setSetting, setSettingJSON, getReadToolIds, upsertTool, type ToolRow } from './db.js';
import { META_TOOLS } from './config.js';
import { getUpstreamClient, type UpstreamClient } from './upstream.js';

/**
 * 工具同步：
 *  1. 调上游 help 分页拉全业务工具清单
 *  2. 并发调 search 拉每个工具的入参 JSON Schema
 *  3. 入库（tools 表），供下游 tools/list 摊平暴露
 */

export interface SyncResult {
  total_listed: number;
  synced: number;
  schema_missing: number;
  failed: number;
  errors: string[];
  duration_ms: number;
}

let syncing = false;
export function isSyncing(): boolean {
  return syncing;
}

// ---------- 响应结构自适应解析 ----------

function unwrapCallResult(resp: any): any {
  const result = resp?.result;
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c: any) => c?.type === 'text')?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function collectArrays(obj: any, out: any[] = [], depth = 0): any[] {
  if (depth > 5 || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    out.push(obj);
    for (const v of obj) collectArrays(v, out, depth + 1);
    return out;
  }
  for (const v of Object.values(obj)) collectArrays(v, out, depth + 1);
  return out;
}

function pick(obj: any, keys: string[]): any {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function findNumber(obj: any, keys: string[], depth = 0): number | undefined {
  if (depth > 3 || obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findNumber(v, keys, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

// 上游 help 不提供 toolType 时，按工具名中的动词分词兜底判断读写类型
const WRITE_TOKENS = new Set([
  'put', 'add', 'create', 'update', 'delete', 'del', 'set', 'modify', 'cancel',
  'edit', 'remove', 'save', 'import', 'send', 'archive', 'push', 'upload',
  'pause', 'enable', 'disable', 'adjust', 'audit', 'approve', 'reject',
  'mark', 'reset', 'bind', 'unbind', 'apply',
]);

function classifyByName(name: string): string {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => WRITE_TOKENS.has(t)) ? 'write' : 'read';
}

function normalizeTool(raw: any): { tool_id: string; name: string; description: string; tool_type: string; raw: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const toolId = String(pick(raw, ['toolId', 'tool_id', 'id', 'toolName', 'name']) ?? '').trim();
  if (!toolId || /^[0-9]+$/.test(toolId)) return null;
  const name = String(pick(raw, ['name', 'displayName', 'title', 'tool_name', 'label']) ?? toolId);
  const description = String(pick(raw, ['description', 'desc', 'summary', 'tool_desc']) ?? '');
  const toolTypeRaw = String(pick(raw, ['toolType', 'tool_type']) ?? '').toLowerCase();
  const tool_type = toolTypeRaw === 'read' || toolTypeRaw === 'write' ? toolTypeRaw : classifyByName(toolId);
  let rawJson: string = '';
  try {
    rawJson = JSON.stringify(raw);
  } catch {
    rawJson = '';
  }
  return { tool_id: toolId, name, description, tool_type, raw: rawJson };
}

function extractToolPage(payload: any): { items: Array<{ tool_id: string; name: string; description: string; tool_type: string; raw: string }>; total?: number } {
  const arrays = collectArrays(payload).filter((a) => a.length > 0);
  let best: any[] = [];
  for (const a of arrays) {
    if (a.every((x: any) => x && typeof x === 'object' && !Array.isArray(x))) {
      if (a.length > best.length) best = a;
    }
  }
  const items = best
    .map(normalizeTool)
    .filter((t): t is { tool_id: string; name: string; description: string; tool_type: string; raw: string } => !!t);
  const total = findNumber(payload, ['total', 'totalCount', 'total_count', 'count', 'sum']);
  return { items, total };
}

function extractSchema(payload: any): Record<string, unknown> | null {
  const found = (function dig(o: any, depth: number): Record<string, unknown> | null {
    if (depth > 4 || o === null || typeof o !== 'object') return null;
    for (const k of ['inputSchema', 'input_schema', 'parameters', 'schema', 'paramsSchema', 'toolSchema']) {
      const v = o?.[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    }
    for (const v of Object.values(o)) {
      const r = dig(v, depth + 1);
      if (r) return r;
    }
    return null;
  })(payload, 0);
  return found && (found as any).type === 'object' ? found : null;
}

function sanitizeToolName(name: string): string {
  let n = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!/^[a-zA-Z0-9_-]+$/.test(n) || !n) n = `tool_${n.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return n.slice(0, 64);
}

// ---------- 并发池 ----------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- 主流程 ----------

async function fetchAllListedTools(client: UpstreamClient): Promise<{ tools: Map<string, { tool_id: string; name: string; description: string; tool_type: string; raw: string }>; listed: number }> {
  const tools = new Map<string, { tool_id: string; name: string; description: string; tool_type: string; raw: string }>();
  const limit = 100;
  let offset = 0;
  let total: number | undefined;

  // 上游 help 实测分页参数为 offset/limit（page/page_size 会被忽略）
  for (let i = 0; i < 50; i++) {
    const resp = await client.callTool('help', { offset, limit });
    if (resp?.error) throw new Error(`help 调用失败: ${JSON.stringify(resp.error).slice(0, 300)}`);
    const payload = unwrapCallResult(resp);
    const { items, total: t } = extractToolPage(payload);
    if (t !== undefined) total = t;
    if (items.length === 0) break;
    let fresh = 0;
    for (const it of items) {
      if (!tools.has(it.tool_id)) {
        tools.set(it.tool_id, it);
        fresh++;
      }
    }
    offset += items.length;
    if (fresh === 0) break; // 与上一页重复，说明分页到底或参数失效
    if (total !== undefined && tools.size >= total) break;
    if (items.length < limit) break;
  }
  return { tools, listed: total ?? tools.size };
}

export async function syncTools(): Promise<SyncResult> {
  if (syncing) throw new Error('已有同步任务在进行中');
  syncing = true;
  const started = Date.now();
  const errors: string[] = [];
  try {
    const client = getUpstreamClient(getSetting('upstream_url'), getSetting('upstream_key'));
    const { tools, listed } = await fetchAllListedTools(client);

    for (const id of META_TOOLS) tools.delete(id);

    let schemaMissing = 0;
    let failed = 0;

    const entries = [...tools.values()];
    await mapLimit(entries, 6, async (t) => {
      try {
        const resp = await client.callTool('search', { toolId: t.tool_id });
        if (resp?.error) {
          errors.push(`search ${t.tool_id}: ${String(resp.error.message ?? '').slice(0, 120)}`);
          failed++;
          return;
        }
        const schema = extractSchema(unwrapCallResult(resp));
        if (!schema) schemaMissing++;
        upsertTool({
          tool_id: t.tool_id,
          exposed_name: sanitizeToolName(t.tool_id),
          name: t.name,
          description: t.description,
          input_schema: schema ? JSON.stringify(schema) : null,
          raw: t.raw,
          tool_type: t.tool_type,
        });
      } catch (e: any) {
        errors.push(`search ${t.tool_id}: ${String(e?.message || e).slice(0, 120)}`);
        failed++;
      }
    });

    const result: SyncResult = {
      total_listed: listed,
      synced: tools.size - failed,
      schema_missing: schemaMissing,
      failed,
      errors: errors.slice(0, 20),
      duration_ms: Date.now() - started,
    };
    setSetting('last_sync_at', new Date().toISOString());

    // 自动初始化默认权限模板：如果管理员还没配过（default_tools_all=0 且 default_tools 空），
    // 把当前所有 read 类工具 id 填进去，让新建运营自动继承只读模板。
    if (getSetting('default_tools_all') === '0') {
      const cur = getSetting('default_tools');
      if (!cur || cur === '[]') {
        const readIds = getReadToolIds();
        if (readIds.length > 0) {
          setSettingJSON('default_tools', readIds);
          console.log(`[sync] 自动填充默认权限模板：${readIds.length} 个 read 工具`);
        }
      }
    }

    return result;
  } finally {
    syncing = false;
  }
}

export function listTools(q: string, page: number, pageSize: number, toolType?: string, enabled?: number): { total: number; items: Array<Record<string, unknown>> } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    conds.push('(tool_id LIKE ? OR exposed_name LIKE ? OR name LIKE ? OR description LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (toolType) { conds.push('tool_type = ?'); params.push(toolType); }
  if (enabled !== undefined && enabled !== null) { conds.push('enabled = ?'); params.push(enabled); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM tools ${where}`).all(...params) as { c: number }[])[0].c;
  const rows = db
    .prepare(
      `SELECT tool_id, exposed_name, name, description, input_schema, tool_type, enabled, updated_at
       FROM tools ${where} ORDER BY tool_id LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<ToolRow & { input_schema: string | null }>;
  return {
    total,
    items: rows.map((r) => ({
      tool_id: r.tool_id,
      exposed_name: r.exposed_name,
      name: r.name,
      description: r.description,
      tool_type: r.tool_type || '',
      has_schema: !!r.input_schema,
      enabled: !!r.enabled,
      updated_at: r.updated_at,
    })),
  };
}

/** 批量启停：按 id 列表或按搜索条件（all=true 时 q 为空表示全部） */
export function batchSetEnabled(opts: { tool_ids?: string[]; all?: boolean; q?: string }, enabled: boolean): number {
  const flag = enabled ? 1 : 0;
  if (opts.tool_ids && opts.tool_ids.length > 0) {
    const stmt = db.prepare('UPDATE tools SET enabled = ? WHERE tool_id = ?');
    const tx = db.transaction(() => {
      for (const id of opts.tool_ids!) stmt.run(flag, id);
    });
    tx();
    return opts.tool_ids.length;
  }
  if (opts.all) {
    const q = String(opts.q ?? '').trim();
    const info = q
      ? db
          .prepare('UPDATE tools SET enabled = ? WHERE tool_id LIKE ? OR name LIKE ? OR description LIKE ?')
          .run(flag, `%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare('UPDATE tools SET enabled = ?').run(flag);
    return info.changes;
  }
  return 0;
}

/** 上游提示"工具参数定义已更新"时，重新拉取该工具 Schema 并入库 */
export async function refreshToolSchema(client: UpstreamClient, toolId: string): Promise<void> {
  try {
    const resp = await client.callTool('search', { toolId });
    if (resp?.error) return;
    const schema = extractSchema(unwrapCallResult(resp));
    if (schema) {
      db.prepare('UPDATE tools SET input_schema = ?, updated_at = ? WHERE tool_id = ?').run(
        JSON.stringify(schema),
        new Date().toISOString(),
        toolId
      );
      console.log(`[sync] 已刷新工具 Schema: ${toolId}`);
    }
  } catch (e: any) {
    console.warn(`[sync] 刷新 Schema 失败 ${toolId}: ${String(e?.message || e).slice(0, 150)}`);
  }
}
