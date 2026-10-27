import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { db, getSetting, getToolByExposedName } from './db.js';
import { getUpstreamClient } from './upstream.js';

/**
 * 下游 MCP 端点（无状态 streamableHttp）：
 *  - tools/list：从本地缓存摊平暴露业务工具
 *  - tools/call：转发为上游 action(toolId, params)
 */

function safeParseSchema(s: string | null): Record<string, unknown> {
  if (s) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
  }
  return { type: 'object', properties: {} };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = new Server(
    { name: 'lxmcpgl-gateway', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rows = db
      .prepare('SELECT exposed_name, name, description, input_schema FROM tools WHERE enabled = 1 ORDER BY tool_id')
      .all() as Array<{ exposed_name: string; name: string; description: string; input_schema: string | null }>;
    return {
      tools: rows.map((r) => ({
        name: r.exposed_name,
        description: r.description || r.name || r.exposed_name,
        inputSchema: safeParseSchema(r.input_schema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params.name ?? '');
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const tool = getToolByExposedName(name);
    if (!tool || !tool.enabled) return errorResult(`工具不存在或未启用: ${name}`);
    if (!getSetting('upstream_key')) return errorResult('网关未配置上游密钥，请管理员在 Web 后台完成配置');

    const started = Date.now();
    try {
      const client = getUpstreamClient(getSetting('upstream_url'), getSetting('upstream_key'));
      // 上游是元工具模式：业务工具统一经 action(toolId, params) 执行
      const resp = await client.callTool('action', { toolId: tool.tool_id, params: args });
      const duration = Date.now() - started;
      if (resp?.error) {
        console.error(`[mcp] ${name} 上游错误 (${duration}ms): ${JSON.stringify(resp.error).slice(0, 200)}`);
        return errorResult(`上游错误: ${JSON.stringify(resp.error).slice(0, 500)}`);
      }
      const content = resp?.result?.content;
      console.log(`[mcp] ${name} ok ${duration}ms`);
      if (Array.isArray(content)) return { content };
      return errorResult('上游返回为空');
    } catch (e: any) {
      console.error(`[mcp] ${name} 调用失败: ${String(e?.message || e).slice(0, 300)}`);
      return errorResult(`调用失败: ${String(e?.message || e).slice(0, 300)}`);
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
