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
  version: '1.0.0',
};

export const DEFAULT_UPSTREAM_URL = 'https://openmcp.lingxing.com/mcp-servers/lingxing-mcp';
export const META_TOOLS = new Set(['help', 'search', 'action']);
