import path from 'node:path';
import { readFileSync } from 'node:fs';

/** 版本号单一来源：package.json。避免 config/README/tag 三处手抄漂移 */
function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  publicDir: process.env.PUBLIC_DIR || path.resolve('public'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  upstreamUrlEnv: process.env.LINGXING_MCP_URL || '',
  upstreamKeyEnv: process.env.LINGXING_MCP_KEY || '',
  version: readPkgVersion(),
  // 构建信息：由 CI/Docker build-arg 注入，用于确认「更新是否真正生效」
  commit: process.env.GIT_SHA || '',
  buildTime: process.env.BUILD_TIME || '',
};

export const DEFAULT_UPSTREAM_URL = 'https://openmcp.lingxing.com/mcp-servers/lingxing-mcp';
export const META_TOOLS = new Set(['help', 'search', 'action']);

// ---------- 工具读写分类（单一实现） ----------

/** 写操作动词词表：工具名里出现这些词 → 判为写操作 */
const WRITE_TOKENS = new Set([
  'put', 'add', 'create', 'update', 'delete', 'del', 'set', 'modify', 'cancel',
  'edit', 'remove', 'save', 'import', 'send', 'archive', 'push', 'upload',
  'pause', 'enable', 'disable', 'adjust', 'audit', 'approve', 'reject',
  'mark', 'reset', 'bind', 'unbind', 'apply',
]);

/**
 * 工具名分词：先按驼峰边界切分，再转小写按非字母数字切分。
 * updateListing → ["update", "listing"]（不切驼峰的话 "updatelisting"
 * 匹配不到任何动词 → 漏判为 read，写工具被当成只读放行）。
 */
function splitNameTokens(name: string): string[] {
  const camelSplit = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return camelSplit.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 按工具名兜底判断读写类型（上游没给 toolType 时用） */
export function classifyByName(name: string): 'read' | 'write' {
  const tokens = splitNameTokens(name);
  return tokens.some((t) => WRITE_TOKENS.has(t)) ? 'write' : 'read';
}
