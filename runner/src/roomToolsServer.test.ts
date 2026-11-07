import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import type { RoomToolsClient } from './roomTools.ts';
import { createRoomToolsServer, isForwardedPort, loopbackCaller } from './roomToolsServer.ts';

// Records every query and mutation by name and answers from `replies`.
function fakeConvex(replies: Record<string, (args: any) => unknown>) {
  const calls: { name: string; args: any }[] = [];
  const answer = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    return replies[name]?.(args);
  };
  return { client: { query: answer, mutation: answer } as unknown as RoomToolsClient, calls };
}

const convex = fakeConvex({
  'documentTools:deleteBlockForTurn': () => ({ ok: true }),
  'documentTools:commentForTurn': () => ({ ok: false, reason: 'cap_reached', message: 'Turn cap reached: at most 10 comments per turn.' }),
});
const server = createRoomToolsServer({ client: convex.client, secret: 's3cret' });
after(() => server.close());

function post(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('the endpoint binds 127.0.0.1 on a port outside 3000-9999, only once a turn needs it', async () => {
  assert.equal(server.address(), null);
  const { url } = await server.issue('t-bind');
  const bound = server.address()!;
  assert.equal(bound.address, '127.0.0.1');
  assert.ok(!isForwardedPort(bound.port), `port ${bound.port} is forwarded`);
  assert.equal(url, `http://127.0.0.1:${bound.port}/mcp`);
  assert.equal((await server.issue('t-bind-2')).url, url, 'one endpoint serves every turn');
});

test('only ports 3000 to 9999 count as forwarded', () => {
  assert.deepEqual([2999, 3000, 8000, 9999, 10000].map(isForwardedPort), [false, true, true, true, false]);
});

test('a request with no token, an unknown token or a finished turn\'s token is rejected', async () => {
  const { url, token } = await server.issue('t-done');
  const before = convex.calls.length;
  assert.equal((await post(url, call('read_document', {}))).status, 401);
  assert.equal((await post(url, call('read_document', {}), 'not-a-token')).status, 401);
  server.revoke(token);
  assert.equal((await post(url, call('read_document', {}), token)).status, 401);
  assert.equal(convex.calls.length, before, 'nothing reached Convex');
});

test("another turn's token acts only as that other turn, whatever the request says", async () => {
  const mine = await server.issue('t-mine');
  const theirs = await server.issue('t-theirs');
  const res = await post(mine.url, call('delete_block', { blockId: 'b-1', baseRev: 1, turnId: 't-mine' }), theirs.token);
  assert.equal(res.status, 200);
  assert.deepEqual(convex.calls.at(-1), { name: 'documentTools:deleteBlockForTurn', args: { secret: 's3cret', turnId: 't-theirs', blockId: 'b-1', baseRev: 1 } });
});

test('the endpoint speaks MCP: initialize, notifications, ping and the tool list', async () => {
  const { url, token } = await server.issue('t-mcp');
  const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, token);
  assert.deepEqual(await init.json(), {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'atelier', version: '0.0.0' } },
  });
  assert.equal((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
  assert.deepEqual(await (await post(url, { jsonrpc: '2.0', id: 2, method: 'ping' }, token)).json(), { jsonrpc: '2.0', id: 2, result: {} });
  const list = (await (await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, token)).json()) as any;
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['read_document', 'read_thread', 'add_block', 'update_block', 'delete_block', 'comment']);
  const unknown = (await (await post(url, { jsonrpc: '2.0', id: 4, method: 'resources/list' }, token)).json()) as any;
  assert.equal(unknown.error.code, -32601);
});

test('a refusal comes back through the endpoint as tool text, and the token stops working once revoked', async () => {
  const route = await server.issue('t-loop');
  const run = loopbackCaller(route);
  assert.deepEqual(await run('comment', { blockId: 'b-1', quote: 'x', body: 'y' }), {
    content: [{ type: 'text', text: 'Not done (cap_reached): Turn cap reached: at most 10 comments per turn.' }],
    isError: true,
  });
  server.revoke(route.token);
  assert.deepEqual(await run('comment', { blockId: 'b-1', quote: 'x', body: 'y' }), {
    content: [{ type: 'text', text: 'The document tools no longer work for this turn.' }],
    isError: true,
  });
});
