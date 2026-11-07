import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { callRoomTool, claudeRoomToolsServer, documentTools, listTools, type RoomToolsClient } from './roomTools.ts';

// Records every query and mutation by name and answers from `replies`.
function fakeConvex(replies: Record<string, (args: any) => unknown> = {}) {
  const calls: { name: string; args: any }[] = [];
  const answer = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    return replies[name]?.(args);
  };
  return { client: { query: answer, mutation: answer } as unknown as RoomToolsClient, calls, replies };
}

const text = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join('\n');

test('read_document lists blocks with their ids, authors and revs, and the threads on them', async () => {
  const convex = fakeConvex({
    'documentTools:readDocumentForTurn': () => ({
      ok: true,
      rev: 12,
      writable: true,
      blocks: [
        { id: 'b-head', kind: 'heading', text: "What's happened", author: 'Robert', yours: false, rev: 1, humanEdited: false },
        { id: 'b-mine', kind: 'paragraph', text: 'We chose Postgres.\nMigrations next.', author: 'Claude', yours: true, rev: 3, humanEdited: true },
      ],
      threads: [{ id: 'th-1', blockId: 'b-mine', state: 'open', passage: 'Postgres', detached: false, comments: 2 }],
    }),
  });
  const result = await callRoomTool(convex.client, 's3cret', 't1', 'read_document', {});
  assert.deepEqual(convex.calls, [{ name: 'documentTools:readDocumentForTurn', args: { secret: 's3cret', turnId: 't1' } }]);
  assert.equal(result.isError, undefined);
  assert.equal(text(result), [
    'Room document at rev 12. You can add blocks, change and delete your own, and comment on any block.',
    '',
    'Blocks, in order:',
    '- block b-head | heading | by Robert | rev 1',
    "  What's happened",
    '- block b-mine | paragraph | by you | rev 3 | a person has edited it: keep their changes',
    '  We chose Postgres.',
    '  Migrations next.',
    '',
    'Comment threads:',
    '- thread th-1 | open | on block b-mine | 2 comments',
    '  "Postgres"',
  ].join('\n'));
});

test('read_thread shows the passage and every comment with its author', async () => {
  const convex = fakeConvex({
    'documentTools:readThreadForTurn': () => ({
      ok: true, id: 'th-1', blockId: 'b-mine', state: 'open', passage: 'Postgres', detached: false,
      comments: [{ author: 'Robert', body: 'Why not SQLite?', at: Date.UTC(2026, 10, 7, 9, 30) }],
    }),
  });
  const result = await callRoomTool(convex.client, 's3cret', 't1', 'read_thread', { threadId: 'th-1' });
  assert.deepEqual(convex.calls[0]!.args, { secret: 's3cret', turnId: 't1', threadId: 'th-1' });
  assert.match(text(result), /^Thread th-1 \| open \| on block b-mine\nPassage: "Postgres"\n\nComments:\n- Robert, 2026-11-07T09:30:00.000Z:\n {2}Why not SQLite\?$/);
});

test('each write tool sends its arguments with the secret and turn, and reports what happened', async () => {
  const convex = fakeConvex({
    'documentTools:addBlockForTurn': () => ({ ok: true, blockId: 'b-new', rev: 1 }),
    'documentTools:updateBlockForTurn': () => ({ ok: true, rev: 4 }),
    'documentTools:deleteBlockForTurn': () => ({ ok: true }),
    'documentTools:commentForTurn': () => ({ ok: true, threadId: 'th-2', commentId: 'c-1' }),
  });
  const run = async (name: string, args: unknown) => text(await callRoomTool(convex.client, 's3cret', 't1', name, args));

  assert.equal(await run('add_block', { kind: 'listItem', text: 'Ship Friday', endOfSectionId: 'b-head' }), 'Added block b-new at rev 1. Pass that rev as baseRev to change it later.');
  assert.equal(await run('update_block', { blockId: 'b-new', baseRev: 1, text: 'Ship Monday' }), 'Updated block b-new. It is now at rev 4.');
  assert.equal(await run('delete_block', { blockId: 'b-new', baseRev: 4 }), 'Deleted block b-new.');
  assert.equal(await run('comment', { blockId: 'b-head', quote: 'happened', body: 'Add the launch date?' }), 'Started comment thread th-2 on block b-head.');

  assert.deepEqual(convex.calls, [
    { name: 'documentTools:addBlockForTurn', args: { secret: 's3cret', turnId: 't1', kind: 'listItem', text: 'Ship Friday', endOfSectionId: 'b-head' } },
    { name: 'documentTools:updateBlockForTurn', args: { secret: 's3cret', turnId: 't1', blockId: 'b-new', baseRev: 1, text: 'Ship Monday' } },
    { name: 'documentTools:deleteBlockForTurn', args: { secret: 's3cret', turnId: 't1', blockId: 'b-new', baseRev: 4 } },
    { name: 'documentTools:commentForTurn', args: { secret: 's3cret', turnId: 't1', blockId: 'b-head', quote: 'happened', body: 'Add the launch date?' } },
  ]);
});

test('a refusal from Convex comes back as tool text with the current block, not as a throw', async () => {
  const convex = fakeConvex({
    'documentTools:updateBlockForTurn': () => ({
      ok: false,
      reason: 'stale',
      message: 'Robert changed this block after the version you sent (it is now rev 5).',
      current: { text: 'Ship Monday, after QA', rev: 5, changedBy: 'Robert' },
    }),
  });
  const result = await callRoomTool(convex.client, 's3cret', 't1', 'update_block', { blockId: 'b-1', baseRev: 4, text: 'Ship Friday' });
  assert.equal(result.isError, true);
  assert.equal(text(result), [
    'Not done (stale): Robert changed this block after the version you sent (it is now rev 5).',
    '',
    'Current text, rev 5, last changed by Robert:',
    'Ship Monday, after QA',
  ].join('\n'));
});

test('a turnId in the arguments is ignored: the call acts as the turn it was made for', async () => {
  const convex = fakeConvex({ 'documentTools:deleteBlockForTurn': () => ({ ok: true }) });
  await callRoomTool(convex.client, 's3cret', 't1', 'delete_block', { blockId: 'b-1', baseRev: 2, turnId: 't-other', secret: 'forged' });
  assert.deepEqual(convex.calls[0]!.args, { secret: 's3cret', turnId: 't1', blockId: 'b-1', baseRev: 2 });
});

test('bad arguments and unknown tools are explained to the model without calling Convex', async () => {
  const convex = fakeConvex();
  const missing = await callRoomTool(convex.client, 's3cret', 't1', 'update_block', { blockId: 'b-1', text: 'x' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /^Those arguments don't fit update_block: .*baseRev/s);
  const unknown = await callRoomTool(convex.client, 's3cret', 't1', 'settle_thread', {});
  assert.equal(text(unknown), 'There is no tool named settle_thread. The tools are read_document, read_thread, add_block, update_block, delete_block, comment.');
  assert.equal(convex.calls.length, 0);
});

test('a Convex error becomes tool text and does not reach the model as a crash', async () => {
  const convex = fakeConvex({ 'documentTools:readDocumentForTurn': () => { throw new Error('connection lost'); } });
  const original = console.error;
  console.error = () => {};
  try {
    const result = await callRoomTool(convex.client, 's3cret', 't1', 'read_document', {});
    assert.equal(result.isError, true);
    assert.equal(text(result), 'read_document failed before reaching the document. Try again, or carry on without it.');
  } finally {
    console.error = original;
  }
});

test('the tool list gives every document tool a JSON schema for its arguments', () => {
  const tools = listTools();
  assert.deepEqual(tools.map((t) => t.name), ['read_document', 'read_thread', 'add_block', 'update_block', 'delete_block', 'comment']);
  const update = tools.find((t) => t.name === 'update_block')!;
  assert.equal(update.inputSchema.type, 'object');
  assert.deepEqual(update.inputSchema.required, ['blockId', 'baseRev', 'text']);
  assert.equal('$schema' in update.inputSchema, false);
  assert.deepEqual((tools.find((t) => t.name === 'add_block')!.inputSchema.properties as any).kind.enum, ['heading', 'paragraph', 'listItem']);
});

test("Claude's in-process server is named atelier, always loads, and forwards each tool by name", async () => {
  const forwarded: [string, unknown][] = [];
  const server = claudeRoomToolsServer(async (name, args) => {
    forwarded.push([name, args]);
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'atelier');
  const registered = (server.instance as any)._registeredTools as Record<string, { description: string; _meta?: Record<string, unknown>; handler(args: unknown, extra: unknown): Promise<unknown> }>;
  assert.deepEqual(Object.keys(registered), documentTools.map((t) => t.name));
  assert.equal(registered.comment!.description, documentTools.find((t) => t.name === 'comment')!.description);
  assert.equal(registered.comment!._meta?.['anthropic/alwaysLoad'], true);
  assert.deepEqual(await registered.comment!.handler({ blockId: 'b-1', quote: 'x', body: 'y' }, {}), { content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual(forwarded, [['comment', { blockId: 'b-1', quote: 'x', body: 'y' }]]);
});
