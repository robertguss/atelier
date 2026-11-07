import { afterAll, describe, expect, it } from "vitest";

import { FakeRoomConvex } from "./fake-room-convex.ts";
import {
  createRoomToolsServer,
  isForwardedPort,
  loopbackCaller,
} from "./room-tools-server.ts";
import type { RoomToolsClient } from "./room-tools.ts";

const convex = new FakeRoomConvex({
  "documentTools:commentForTurn": () => ({
    message: "Turn cap reached: at most 10 comments per turn.",
    ok: false,
    reason: "cap_reached",
  }),
  "documentTools:deleteBlockForTurn": () => ({ ok: true }),
});
const client: RoomToolsClient = convex;
const server = createRoomToolsServer({ client, secret: "s3cret" });

// Posts one JSON-RPC message and reads the reply.
const post = async (url: string, body: unknown, token?: string) => {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    method: "POST",
  });
  const raw = await res.text();
  const reply: unknown = raw === "" ? undefined : JSON.parse(raw);
  return { reply, status: res.status };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The value at `keys` inside parsed JSON, or undefined where the path breaks.
const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

const call = (name: string, args: unknown) => ({
  id: 1,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: args, name },
});

describe(createRoomToolsServer, () => {
  afterAll(async () => {
    await server.close();
  });

  it("the endpoint binds 127.0.0.1 on a port outside 3000-9999, only once a turn needs it", async () => {
    const before = server.address();
    const { url } = await server.issue("t-bind");
    const bound = server.address();
    const again = await server.issue("t-bind-2");
    expect({
      address: bound?.address,
      againUrl: again.url,
      beforeTurn: before,
      forwarded: bound === null ? undefined : isForwardedPort(bound.port),
      url,
    }).toStrictEqual({
      address: "127.0.0.1",
      againUrl: url,
      beforeTurn: null,
      forwarded: false,
      url: `http://127.0.0.1:${bound?.port}/mcp`,
    });
  });

  it("only ports 3000 to 9999 count as forwarded", () => {
    expect([2999, 3000, 8000, 9999, 10_000].map(isForwardedPort)).toStrictEqual(
      [false, true, true, true, false]
    );
  });

  it("a request with no token, an unknown token or a finished turn's token is rejected", async () => {
    const { url, token } = await server.issue("t-done");
    const before = convex.calls.length;
    const noToken = await post(url, call("read_document", {}));
    const unknownToken = await post(
      url,
      call("read_document", {}),
      "not-a-token"
    );
    server.revoke(token);
    const revoked = await post(url, call("read_document", {}), token);
    expect({
      reachedConvex: convex.calls.length - before,
      statuses: [noToken.status, unknownToken.status, revoked.status],
    }).toStrictEqual({ reachedConvex: 0, statuses: [401, 401, 401] });
  });

  it("another turn's token acts only as that other turn, whatever the request says", async () => {
    const mine = await server.issue("t-mine");
    const theirs = await server.issue("t-theirs");
    const res = await post(
      mine.url,
      call("delete_block", { baseRev: 1, blockId: "b-1", turnId: "t-mine" }),
      theirs.token
    );
    expect(res.status).toBe(200);
    expect(convex.calls.at(-1)).toStrictEqual({
      args: {
        baseRev: 1,
        blockId: "b-1",
        secret: "s3cret",
        turnId: "t-theirs",
      },
      name: "documentTools:deleteBlockForTurn",
    });
  });

  it("the endpoint speaks MCP: initialize, notifications, ping and the tool list", async () => {
    const { url, token } = await server.issue("t-mcp");
    const init = await post(
      url,
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      token
    );
    const notified = await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      token
    );
    const ping = await post(
      url,
      { id: 2, jsonrpc: "2.0", method: "ping" },
      token
    );
    const list = await post(
      url,
      { id: 3, jsonrpc: "2.0", method: "tools/list" },
      token
    );
    const unknown = await post(
      url,
      { id: 4, jsonrpc: "2.0", method: "resources/list" },
      token
    );
    const listed = at(list.reply, "result", "tools");
    expect({
      init: init.reply,
      notifiedStatus: notified.status,
      ping: ping.reply,
      toolNames: Array.isArray(listed) ? listed.map((t) => at(t, "name")) : [],
      unknownCode: at(unknown.reply, "error", "code"),
    }).toStrictEqual({
      init: {
        id: 1,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "atelier", version: "0.0.0" },
        },
      },
      notifiedStatus: 202,
      ping: { id: 2, jsonrpc: "2.0", result: {} },
      toolNames: [
        "read_document",
        "read_thread",
        "add_block",
        "update_block",
        "delete_block",
        "comment",
      ],
      unknownCode: -32_601,
    });
  });

  it("a refusal comes back through the endpoint as tool text, and the token stops working once revoked", async () => {
    const route = await server.issue("t-loop");
    const run = loopbackCaller(route);
    await expect(
      run("comment", { blockId: "b-1", body: "y", quote: "x" })
    ).resolves.toStrictEqual({
      content: [
        {
          text: "Not done (cap_reached): Turn cap reached: at most 10 comments per turn.",
          type: "text",
        },
      ],
      isError: true,
    });
    server.revoke(route.token);
    await expect(
      run("comment", { blockId: "b-1", body: "y", quote: "x" })
    ).resolves.toStrictEqual({
      content: [
        {
          text: "The document tools no longer work for this turn.",
          type: "text",
        },
      ],
      isError: true,
    });
  });
});
