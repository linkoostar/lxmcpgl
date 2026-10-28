import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { initDb, getSetting, sha256, getUserByKeyHash, listUpstreams, type UserRow } from './db.js';
import { apiRouter, apiErrorHandler } from './web.js';
import { handleMcpRequest, identityFromUser, type McpIdentity, toolsHashOf } from './mcp.js';
import { syncAllUpstreams } from './sync.js';
import { buildHealth } from './health.js';
import type { Request, Response, NextFunction } from 'express';

// 代理环境支持（沙箱/内网出口场景），NAS 部署无代理时无副作用
async function setupProxy(): Promise<void> {
  const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyEnv) return;
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[proxy] 使用代理出口: ${proxyEnv}`);
  } catch (e) {
    console.warn('[proxy] 代理初始化失败，直连模式:', e instanceof Error ? e.message : e);
  }
}

function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-mcp-key'] ?? '').trim();
  if (!provided) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: '未授权：请携带下游访问 Key（Authorization: Bearer <key>）' },
      id: null,
    });
    return;
  }

  let identity: McpIdentity;
  const user = getUserByKeyHash(sha256(provided));
  if (user) {
    if (!user.enabled) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: '该 Key 已被停用' }, id: null });
      return;
    }
    identity = identityFromUser(user as UserRow);
  } else if (provided === getSetting('downstream_key')) {
    identity = { kind: 'admin', upstream: 'lingxing' }; // 管理员通用 Key：全部权限
  } else {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: '未授权：Key 无效' },
      id: null,
    });
    return;
  }

  (req as any).mcpIdentity = identity;
  next();
}

async function main(): Promise<void> {
  await setupProxy();
  initDb();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20mb' }));

  app.use('/api', apiRouter);
  app.use('/api', apiErrorHandler);

  app.all('/mcp', mcpAuth, (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      return;
    }
    handleMcpRequest(req, res, (req as any).mcpIdentity).catch((e) => {
      console.error('[mcp] 请求处理异常:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
  });

  // 真实健康检查 / 版本端点。
  // 以前这些路径都落到下面的 SPA 兜底，返回 200 + HTML，无法判断更新是否生效。
  app.get(['/health', '/healthz', '/readyz', '/status'], async (req, res) => {
    const probe = String(req.query.probe ?? '') === '1';
    const payload = await buildHealth({ probe });
    const healthy = payload.ok && (req.path !== '/readyz' || payload.db.ok);
    res.status(healthy ? 200 : 503).json(payload);
  });

  app.get('/livez', (_req, res) => {
    res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
  });

  app.get('/version', (_req, res) => {
    res.json({
      service: 'fangzhong-mcp-gateway',
      version: config.version,
      commit: config.commit || null,
      build_time: config.buildTime || null,
      started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
      uptime_s: Math.round(process.uptime()),
    });
  });

  // 明确告知未实现，避免被 SPA 兜底成 200 HTML 造成误判
  app.get('/metrics', (_req, res) => {
    res.status(404).json({ error: 'not_implemented', hint: '请使用 /health 或 /api/health' });
  });

  app.use(express.static(config.publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  app.listen(config.port, config.host, () => {
    console.log(`[lxmcpgl] 网关已启动: http://${config.host}:${config.port}`);
    console.log(`[lxmcpgl] MCP 端点: /mcp | 管理后台: /`);
    console.log(`[lxmcpgl] 数据目录: ${config.dataDir}`);
  });

  // ===== 定期同步 + hash 对比（建议 B） =====
  // 领星等上游不定期改工具定义，等调用失败才刷新（102 触发）为时已晚。
  // 定期全量 sync + toolsHashOf 对比，变了就自动刷新，提前到位。
  // 环境变量 PERIODIC_SYNC_INTERVAL_MS 控制间隔（毫秒），默认 0 = 关闭。
  // 例：PERIODIC_SYNC_INTERVAL_MS=600000 即每 10 分钟同步一次。
  const intervalMs = parseInt(process.env.PERIODIC_SYNC_INTERVAL_MS ?? '0', 10);
  if (intervalMs > 0) {
    setInterval(async () => {
      try {
        const activeUp = listUpstreams().filter((u) => u.active);
        if (activeUp.length === 0) return;
        const before = toolsHashOf(activeUp);
        const started = Date.now();
        const r = await syncAllUpstreams();
        const after = toolsHashOf(activeUp);
        if (before !== after) {
          console.log(
            `[gw] 定期同步发现工具定义变化：hash ${before} → ${after}，` +
            `共 ${r.synced}/${r.total_listed} 工具，耗时 ${Date.now() - started}ms`
          );
        } else {
          console.log(`[gw] 定期同步完成：${r.synced}/${r.total_listed} 工具，hash 无变化（${Date.now() - started}ms）`);
        }
      } catch (e: any) {
        console.warn(`[gw] 定期同步异常: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }, intervalMs);
    console.log(`[lxmcpgl] 定期同步已启用: 每 ${Math.round(intervalMs / 60000)} 分钟`);
  }
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
