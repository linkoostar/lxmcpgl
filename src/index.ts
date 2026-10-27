import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { initDb, getSetting } from './db.js';
import { apiRouter, apiErrorHandler } from './web.js';
import { handleMcpRequest } from './mcp.js';
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
  const key = getSetting('downstream_key');
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-mcp-key'] ?? '').trim();
  if (!key || provided !== key) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: '未授权：请携带正确的下游访问 Key（Authorization: Bearer <key>）' },
      id: null,
    });
    return;
  }
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
    handleMcpRequest(req, res).catch((e) => {
      console.error('[mcp] 请求处理异常:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
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
