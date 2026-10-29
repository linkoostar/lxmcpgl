/**
 * 领星 MCP 上游客户端。
 * 上游是「元工具」模式（help / search / action），本客户端负责：
 *  - initialize 握手并维持会话（mcp-session-id）
 *  - JSON 与 SSE 两种响应格式解析
 *  - 会话失效自动重建
 */

export class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface JsonRpcResponse {
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * 组合超时 signal 与外部取消 signal（cancelled 通知 → abort 上游 fetch）。
 * 不直接用 AbortSignal.any：engines 是 node>=20，20.3 以下没有该 API，手动桥接最稳。
 */
export function withExternalSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  if (external.aborted) return external;
  const ctrl = new AbortController();
  if (timeoutSignal.aborted) {
    ctrl.abort(timeoutSignal.reason);
    return ctrl.signal;
  }
  timeoutSignal.addEventListener('abort', () => ctrl.abort(timeoutSignal.reason), { once: true });
  external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  return ctrl.signal;
}

export class UpstreamClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  private initPromise: Promise<unknown> | null = null;

  constructor(private url: string, private key: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Mcp-Key': this.key,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async post(body: unknown, timeoutMs = 60000, externalSignal?: AbortSignal): Promise<{ res: Response; text: string }> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: withExternalSignal(timeoutMs, externalSignal),
    });
    const text = await res.text();
    return { res, text };
  }

  private parseSse(text: string): any[] {
    const out: any[] = [];
    for (const block of text.split(/\n\n+/)) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        /* 忽略无法解析的块 */
      }
    }
    return out;
  }

  private async readResponse(res: Response, text: string, id: number): Promise<JsonRpcResponse | null> {
    if (!res.ok) throw new UpstreamError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    const ct = res.headers.get('content-type') || '';
    try {
      console.log('[gw-diag] upstream HTTP ct=' + (ct || '(empty)') + ' text.length=' + text.length + ' id=' + id);
    } catch { /* ignore */ }

    if (ct.includes('text/event-stream')) {
      const msgs = this.parseSse(text);
      try {
        const ids = msgs.map((m) => String(m?.id ?? 'null'));
        console.log('[gw-diag] upstream SSE events=' + msgs.length + ' ids=[' + ids.join(',') + '] 找匹配 id=' + id);
      } catch { /* ignore */ }
      const matched = msgs.find((m) => m && m.id === id);
      if (!matched && msgs.length > 0) {
        try {
          msgs.forEach((m, i) => {
            const head = JSON.stringify(m).slice(0, 200);
            console.log('[gw-diag] SSE[' + i + '] head=' + head);
          });
        } catch { /* ignore */ }
      }
      return matched ?? null;
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError(res.status, `响应解析失败: ${text.slice(0, 300)}`);
    }
  }

  private async sendRpc(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    const id = this.nextId++;
    const { res, text } = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal);
    return this.readResponse(res, text, id);
  }

  private async notify(method: string, params: unknown = {}): Promise<void> {
    try {
      await this.post({ jsonrpc: '2.0', method, params }, 15000);
    } catch {
      /* 通知失败不阻塞 */
    }
  }

  async initialize(): Promise<any> {
    const id = this.nextId++;
    const { res, text } = await this.post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lxmcpgl-gateway', version: '1.0.0' },
        },
      },
      30000
    );
    const sid = res.headers.get('mcp-session-id');
    this.sessionId = sid && sid.trim() ? sid.trim() : null;
    const msg = await this.readResponse(res, text, id);
    if (msg?.error) {
      throw new UpstreamError(res.status, `initialize 失败: ${JSON.stringify(msg.error).slice(0, 300)}`);
    }
    if (this.sessionId) await this.notify('notifications/initialized');
    this.initialized = true;
    return msg?.result ?? null;
  }

  /** 确保 initialize 完成（并发安全） */
  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initPromise ??= this.initialize().catch((e) => {
      this.initialized = false;
      throw e;
    });
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private isSessionError(resp: JsonRpcResponse | null, err?: unknown): boolean {
    const msg = String(resp?.error?.message ?? '') + (err instanceof Error ? ' ' + err.message : '');
    const code = resp?.error?.code;
    return /session/i.test(msg) || code === -32001 || (err instanceof UpstreamError && err.status === 404);
  }

  /** 带 session 失效自动重试的 RPC */
  async rpc(method: string, params?: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    await this.ensureInit();
    let resp = await this.sendRpc(method, params, timeoutMs, signal);
    if (resp?.error && this.isSessionError(resp)) {
      this.initialized = false;
      this.sessionId = null;
      await this.ensureInit();
      resp = await this.sendRpc(method, params, timeoutMs, signal);
    }
    return resp;
  }

  /** 上游元工具调用（tools/call）；signal 用于客户端 cancelled 时中断上游等待 */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 120000, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    return this.rpc('tools/call', { name, arguments: args }, timeoutMs, signal);
  }

  /** 上游 tools/list（元工具清单） */
  async listUpstreamTools(): Promise<any[]> {
    const resp = await this.rpc('tools/list');
    return resp?.result?.tools ?? [];
  }
}

/** 按 (url, key) 缓存共享客户端，配置变更自动重建 */
let cached: { url: string; key: string; client: UpstreamClient } | null = null;

export function getUpstreamClient(url: string, key: string): UpstreamClient {
  if (cached && cached.url === url && cached.key === key) return cached.client;
  cached = { url, key, client: new UpstreamClient(url, key) };
  return cached.client;
}

export function resetUpstreamClient(): void {
  cached = null;
}
