/**
 * 健康检查 / 版本信息。
 *
 * 目的：让「网关更新是否真正生效」「上游是否连通」可被外部直接验证，
 * 而不是靠逐个调用工具去对结果。
 *
 * 注意：默认不主动探测上游（/api/health 会被 Docker HEALTHCHECK 每 30s 调一次，
 * 探测上游既慢又可能消耗上游配额）。只有带 probe=1 时才探测，并缓存 60s。
 */

import { db, listUpstreams, type UpstreamRow } from './db.js';
import { config } from './config.js';
import { isSyncing } from './sync.js';

export interface UpstreamHealth {
  id: string;
  name: string;
  adapter: string;
  active: boolean;
  tools: number;
  last_synced_at: string | null;
  /** null = 未探测 */
  reachable: boolean | null;
}

export interface HealthPayload {
  ok: boolean;
  service: string;
  version: string;
  commit: string | null;
  build_time: string | null;
  now: string;
  started_at: string;
  uptime_s: number;
  mcp_endpoint: string;
  db: { ok: boolean; error?: string };
  tools: { total: number; last_synced_at: string | null };
  syncing: boolean;
  upstreams: UpstreamHealth[];
}

const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; result: Record<string, { reachable: boolean; error?: string }> } | null = null;

async function probeUpstreams(rows: UpstreamRow[]): Promise<Record<string, { reachable: boolean; error?: string }>> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.result;
  const { getAdapter } = await import('./adapter.js');
  const active = rows.filter((u) => u.active);
  const result: Record<string, { reachable: boolean; error?: string }> = {};
  await Promise.all(
    active.map(async (u) => {
      try {
        const adapter = getAdapter(u as any);
        if (!adapter.probe) {
          result[u.id] = { reachable: true, error: 'adapter 未实现探活' };
          return;
        }
        const reachable = await adapter.probe(u as any);
        result[u.id] = { reachable, error: reachable ? undefined : '连接失败' };
      } catch (e: any) {
        result[u.id] = { reachable: false, error: String(e?.message || e).slice(0, 200) };
      }
    })
  );
  probeCache = { at: Date.now(), result };
  return result;
}

export async function buildHealth(opts: { probe?: boolean } = {}): Promise<HealthPayload> {
  let dbOk = true;
  let dbError: string | undefined;
  let toolRows: Array<{ upstream: string; c: number; last: string | null }> = [];
  try {
    db.prepare('SELECT 1').get();
    toolRows = db
      .prepare(`SELECT upstream, COUNT(*) AS c, MAX(updated_at) AS last FROM tools WHERE enabled = 1 GROUP BY upstream`)
      .all() as Array<{ upstream: string; c: number; last: string | null }>;
  } catch (e: any) {
    dbOk = false;
    dbError = String(e?.message || e).slice(0, 200);
  }

  const rows = listUpstreams();
  const probes = opts.probe && dbOk ? await probeUpstreams(rows) : {};

  const byUp = new Map(toolRows.map((r) => [r.upstream, r]));
  const ups: UpstreamHealth[] = rows.map((u) => {
    const t = byUp.get(u.id);
    return {
      id: u.id,
      name: u.name,
      adapter: u.adapter,
      active: !!u.active,
      tools: t?.c ?? 0,
      last_synced_at: t?.last ?? null,
      reachable: probes[u.id]?.reachable ?? null,
    };
  });

  const total = toolRows.reduce((n, r) => n + r.c, 0);
  const lastSync = toolRows.reduce<string | null>((acc, r) => {
    if (!r.last) return acc;
    return acc === null || r.last > acc ? r.last : acc;
  }, null);

  return {
    ok: dbOk,
    service: 'fangzhong-mcp-gateway',
    version: config.version,
    commit: config.commit || null,
    build_time: config.buildTime || null,
    now: new Date().toISOString(),
    started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    uptime_s: Math.round(process.uptime()),
    mcp_endpoint: '/mcp',
    db: dbOk ? { ok: true } : { ok: false, error: dbError },
    tools: { total, last_synced_at: lastSync },
    syncing: isSyncing(),
    upstreams: ups,
  };
}
