import path from 'node:path';

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  publicDir: process.env.PUBLIC_DIR || path.resolve('public'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  upstreamUrlEnv: process.env.LINGXING_MCP_URL || '',
  upstreamKeyEnv: process.env.LINGXING_MCP_KEY || '',
  version: '1.1.0',
  // 构建信息：由 CI/Docker build-arg 注入，用于确认「更新是否真正生效」
  commit: process.env.GIT_SHA || '',
  buildTime: process.env.BUILD_TIME || '',
};

export const DEFAULT_UPSTREAM_URL = 'https://openmcp.lingxing.com/mcp-servers/lingxing-mcp';
export const META_TOOLS = new Set(['help', 'search', 'action']);
