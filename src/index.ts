import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { initDb, getSetting, sha256, getUserByKeyHash, type UserRow } from './db.js';
import { apiRouter, apiErrorHandler } from './web.js';
import { handleMcpRequest, identityFromUser, type McpIdentity } from './mcp.js';
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
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
