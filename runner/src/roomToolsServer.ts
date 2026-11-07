// The loopback MCP endpoint that serves the room document tools to harnesses
// running on this machine. It speaks the JSON-response form of streamable
// HTTP: one JSON-RPC message per POST, a JSON reply, 202 for notifications.
//
// It binds 127.0.0.1 on an OS-assigned port outside 3000-9999, which exe.dev
// forwards to anyone with access to the VM. Every request needs the bearer
// token issued to one running turn. The turn comes from the token, never from
// the request, and the token stops working when the turn ends. Tokens are
// never logged.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { callRoomTool, documentTools, listTools, type RoomToolResult, type RoomToolSet, type RoomToolsClient } from './roomTools.ts';

/** Where a turn's harness reaches its tools. The token is a secret. */
export interface RoomToolsRoute {
  url: string;
  token: string;
}

export interface RoomToolsServer {
  /** Starts listening on first use, then issues a token that acts as `turnId`. */
  issue(turnId: string, tools?: RoomToolSet): Promise<RoomToolsRoute>;
  revoke(token: string): void;
  /** The bound address, once listening. */
  address(): { address: string; port: number } | null;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const LISTEN_ATTEMPTS = 20;

/** exe.dev forwards these ports to anyone with access to the VM. */
export function isForwardedPort(port: number) {
  return port >= 3000 && port <= 9999;
}

export function createRoomToolsServer({ client, secret }: { client: RoomToolsClient; secret: string }): RoomToolsServer {
  const live = new Map<string, { turnId: string; tools: RoomToolSet }>();
  let server: Server | undefined;
  let listening: Promise<string> | undefined;

  async function handle(req: IncomingMessage) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const entry = token ? live.get(token) : undefined;
    if (!entry) return { status: 401 };
    if (req.method !== 'POST') return { status: 405 };

    let msg: { id?: string | number | null; method?: string; params?: any };
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return reply(null, { error: { code: -32700, message: 'Parse error' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reply(null, { error: { code: -32600, message: 'Send one JSON-RPC message per request' } });
    if (msg.id === undefined) return { status: 202 };

    switch (msg.method) {
      case 'initialize':
        return reply(msg.id, {
          result: {
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'atelier', version: '0.0.0' },
          },
        });
      case 'ping':
        return reply(msg.id, { result: {} });
      case 'tools/list':
        return reply(msg.id, { result: { tools: listTools(entry.tools) } });
      case 'tools/call':
        return reply(msg.id, { result: await callRoomTool(client, secret, entry.turnId, String(msg.params?.name), msg.params?.arguments, entry.tools) });
      default:
        return reply(msg.id, { error: { code: -32601, message: `Unsupported method ${msg.method}` } });
    }
  }

  async function listenOnce(): Promise<string> {
    for (let attempt = 0; attempt < LISTEN_ATTEMPTS; attempt++) {
      const candidate = createServer((req, res) => {
        handle(req).then(
          ({ status, body }: { status: number; body?: unknown }) => {
            if (body === undefined) res.writeHead(status).end();
            else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
          },
          (e) => {
            console.error('room tools request failed:', e);
            if (!res.headersSent) res.writeHead(500);
            res.end();
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(0, HOST, resolve);
      });
      const { port } = candidate.address() as { port: number };
      if (!isForwardedPort(port)) {
        server = candidate;
        return `http://${HOST}:${port}/mcp`;
      }
      await new Promise((resolve) => candidate.close(resolve));
    }
    throw new Error(`No port outside 3000-9999 after ${LISTEN_ATTEMPTS} tries`);
  }

  return {
    async issue(turnId, tools = documentTools) {
      listening ??= listenOnce().catch((e) => {
        listening = undefined;
        throw e;
      });
      const url = await listening;
      const token = randomBytes(32).toString('base64url');
      live.set(token, { turnId, tools });
      return { url, token };
    },
    revoke(token) {
      live.delete(token);
    },
    address() {
      const bound = server?.address();
      return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null;
    },
    async close() {
      live.clear();
      const closing = server;
      server = undefined;
      listening = undefined;
      if (closing) await new Promise((resolve) => closing.close(resolve));
    },
  };
}

/** Runs tools through the endpoint as the route's turn, for an in-process harness server. */
export function loopbackCaller(route: RoomToolsRoute) {
  let seq = 0;
  return async (name: string, args: unknown): Promise<RoomToolResult> => {
    const res = await fetch(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${route.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) return { content: [{ type: 'text', text: 'The document tools no longer work for this turn.' }], isError: true };
    return ((await res.json()) as { result: RoomToolResult }).result;
  };
}

function reply(id: string | number | null, payload: { result: unknown } | { error: { code: number; message: string } }) {
  return { status: 200, body: { jsonrpc: '2.0', id, ...payload } };
}

async function readBody(req: IncomingMessage) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}
