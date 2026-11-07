// The loopback MCP endpoint that serves the room tools to harnesses running
// on this machine. It speaks the JSON-response form of streamable
// HTTP: one JSON-RPC message per POST, a JSON reply, 202 for notifications.
//
// It binds 127.0.0.1 on an OS-assigned port outside 3000-9999, which exe.dev
// forwards to anyone with access to the VM. Every request needs the bearer
// token issued to one running turn. The turn comes from the token, never from
// the request, and the token stops working when the turn ends. Tokens are
// never logged. A tool call whose caller hangs up, or cancels it with
// notifications/cancelled, has its abort signal fired, so raise_hand can
// withdraw a card nobody is waiting on.

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { callRoomTool, listTools, ordinaryTools } from "./room-tools.ts";
import type {
  AskRoom,
  RoomToolResult,
  RoomToolSet,
  RoomToolsClient,
} from "./room-tools.ts";

/** Where a turn's harness reaches its tools. The token is a secret. */
export interface RoomToolsRoute {
  url: string;
  token: string;
}

/** A turn's tools (the ordinary set if left out) and its question channel. */
interface IssueOptions {
  tools?: RoomToolSet;
  ask?: AskRoom;
}

export interface RoomToolsServer {
  /** Starts listening on first use, then issues a token that acts as `turnId`. */
  issue: (turnId: string, options?: IssueOptions) => Promise<RoomToolsRoute>;
  revoke: (token: string) => void;
  /** The bound address, once listening. */
  address: () => { address: string; port: number } | null;
  close: () => Promise<void>;
}

const HOST = "127.0.0.1";
const LISTEN_ATTEMPTS = 20;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;

/** exe.dev forwards these ports to anyone with access to the VM. */
export const isForwardedPort = (port: number) => port >= 3000 && port <= 9999;

interface Reply {
  status: number;
  body?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRoomToolResult = (value: unknown): value is RoomToolResult =>
  isRecord(value) && Array.isArray(value.content);

const reply = (
  id: string | number | null,
  payload: { result: unknown } | { error: { code: number; message: string } }
): Reply => ({ body: { id, jsonrpc: "2.0", ...payload }, status: 200 });

const readBody = async (req: IncomingMessage) => {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
};

const parseJson = (text: string): unknown => JSON.parse(text);

const closeServer = async (server: Server) => {
  server.close();
  await once(server, "close");
};

const unavailable: RoomToolResult = {
  content: [
    { text: "The room tools no longer work for this turn.", type: "text" },
  ],
  isError: true,
};

type RequestId = string | number;

interface Entry {
  turnId: string;
  tools: RoomToolSet;
  ask?: AskRoom;
  /** Tool calls still running, by request id, so a cancellation can find them. */
  calls: Map<RequestId, AbortController>;
}

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === "string" || typeof value === "number";

export const createRoomToolsServer = ({
  client,
  secret,
}: {
  client: RoomToolsClient;
  secret: string;
}): RoomToolsServer => {
  const live = new Map<string, Entry>();
  let server: Server | undefined;
  let listening: Promise<string> | undefined;

  const answer = async (
    entry: Entry,
    id: RequestId | null,
    method: string,
    params: Record<string, unknown>,
    hungUp: AbortSignal
  ): Promise<Reply> => {
    switch (method) {
      case "initialize": {
        return reply(id, {
          result: {
            capabilities: { tools: {} },
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : DEFAULT_PROTOCOL_VERSION,
            serverInfo: { name: "atelier", version: "0.0.0" },
          },
        });
      }
      case "ping": {
        return reply(id, { result: {} });
      }
      case "tools/list": {
        return reply(id, { result: { tools: listTools(entry.tools) } });
      }
      case "tools/call": {
        const call = new AbortController();
        const stop = () => {
          call.abort();
        };
        hungUp.addEventListener("abort", stop, { once: true });
        // The caller may have hung up while its request body was read.
        if (hungUp.aborted) {
          stop();
        }
        if (id !== null) {
          entry.calls.set(id, call);
        }
        try {
          return reply(id, {
            result: await callRoomTool(
              client,
              secret,
              entry.turnId,
              typeof params.name === "string" ? params.name : "(none given)",
              params.arguments,
              entry.tools,
              { ask: entry.ask, signal: call.signal }
            ),
          });
        } finally {
          hungUp.removeEventListener("abort", stop);
          if (id !== null && entry.calls.get(id) === call) {
            entry.calls.delete(id);
          }
        }
      }
      default: {
        return reply(id, {
          error: {
            code: METHOD_NOT_FOUND,
            message: `Unsupported method ${method}`,
          },
        });
      }
    }
  };

  const handle = async (
    req: IncomingMessage,
    hungUp: AbortSignal
  ): Promise<Reply> => {
    const token = /^Bearer (?<token>\S+)$/u.exec(
      req.headers.authorization ?? ""
    )?.groups?.token;
    const entry = token === undefined ? undefined : live.get(token);
    if (!entry) {
      return { status: 401 };
    }
    if (req.method !== "POST") {
      return { status: 405 };
    }

    let msg: unknown;
    try {
      msg = parseJson(await readBody(req));
    } catch {
      return reply(null, {
        error: { code: PARSE_ERROR, message: "Parse error" },
      });
    }
    if (!isRecord(msg)) {
      return reply(null, {
        error: {
          code: INVALID_REQUEST,
          message: "Send one JSON-RPC message per request",
        },
      });
    }
    const { id } = msg;
    if (id === undefined) {
      const params = isRecord(msg.params) ? msg.params : {};
      if (
        msg.method === "notifications/cancelled" &&
        isRequestId(params.requestId)
      ) {
        entry.calls.get(params.requestId)?.abort();
      }
      return { status: 202 };
    }
    if (id !== null && typeof id !== "string" && typeof id !== "number") {
      return reply(null, {
        error: { code: INVALID_REQUEST, message: "Invalid request id" },
      });
    }
    return await answer(
      entry,
      id,
      typeof msg.method === "string" ? msg.method : "",
      isRecord(msg.params) ? msg.params : {},
      hungUp
    );
  };

  const respond = async (req: IncomingMessage, res: ServerResponse) => {
    const hungUp = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        hungUp.abort();
      }
    });
    try {
      const { status, body } = await handle(req, hungUp.signal);
      if (body === undefined) {
        res.writeHead(status).end();
      } else {
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      }
    } catch (error) {
      console.error("room tools request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  };

  const listenOnce = async (): Promise<string> => {
    for (let attempt = 0; attempt < LISTEN_ATTEMPTS; attempt += 1) {
      const candidate = createServer((req, res) => {
        // respond answers its own failures, so nothing is left to catch here.
        void respond(req, res);
      });
      candidate.listen(0, HOST);
      // oxlint-disable-next-line no-await-in-loop -- each attempt must finish, and free its port, before the next
      await once(candidate, "listening");
      const bound = candidate.address();
      if (bound === null || typeof bound === "string") {
        throw new Error("The room tools endpoint has no port");
      }
      if (!isForwardedPort(bound.port)) {
        server = candidate;
        return `http://${HOST}:${bound.port}/mcp`;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await closeServer(candidate);
    }
    throw new Error(`No port outside 3000-9999 after ${LISTEN_ATTEMPTS} tries`);
  };

  // A failed start is forgotten, so the next turn tries again.
  const startListening = async () => {
    try {
      return await listenOnce();
    } catch (error) {
      listening = undefined;
      throw error;
    }
  };

  return {
    address() {
      const bound = server?.address();
      return bound !== null && bound !== undefined && typeof bound === "object"
        ? { address: bound.address, port: bound.port }
        : null;
    },
    async close() {
      live.clear();
      const closing = server;
      server = undefined;
      listening = undefined;
      if (closing) {
        await closeServer(closing);
      }
    },
    async issue(turnId, { tools = ordinaryTools, ask } = {}) {
      listening ??= startListening();
      const url = await listening;
      const token = randomBytes(32).toString("base64url");
      live.set(token, {
        calls: new Map(),
        tools,
        turnId,
        ...(ask ? { ask } : {}),
      });
      return { token, url };
    },
    revoke(token) {
      live.delete(token);
    },
  };
};

/** Runs tools through the endpoint as the route's turn, for an in-process harness server. */
export const loopbackCaller = (route: RoomToolsRoute) => {
  let seq = 0;
  return async (name: string, args: unknown): Promise<RoomToolResult> => {
    seq += 1;
    const res = await fetch(route.url, {
      body: JSON.stringify({
        id: seq,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${route.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!res.ok) {
      return unavailable;
    }
    const answer: unknown = await res.json();
    return isRecord(answer) && isRoomToolResult(answer.result)
      ? answer.result
      : unavailable;
  };
};
