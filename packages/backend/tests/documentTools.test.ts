/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { MODEL_LIMITS } from '../convex/documentTools';
import { insertBlock, openChangeSet, orderBetween } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

const SECRET = 'test-secret';
const HARNESSES = [{ id: 'claude' as const, version: 'test' }, { id: 'codex' as const, version: 'test' }, { id: 'pi' as const, version: 'test' }];

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = SECRET;
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: SECRET, name: 'test', machine: 'test', harnesses: HARNESSES });
  const roomId = await owner.mutation(api.rooms.create, { name: 'Planning', runnerId, cwd: '/tmp/planning' });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: 'codex' });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: 'pi' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'user_1' }])));
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: invite.url.split('/invite/')[1]! });
  vi.unstubAllGlobals();
  const participants = (await owner.query(api.rooms.get, { roomId }))!.participants;
  const find = (name: string) => participants.find(p => p.displayName === name)!;
  const doc = (await owner.query(api.documents.get, { roomId }))!;
  const [happened, ideas] = doc.blocks;
  return { t, owner, dana, runnerId, roomId, documentId: doc.documentId, happened: happened!, ideas: ideas!, robert: find('Robert'), danaP: find('Dana'), claude: find('Claude'), codex: find('Codex'), pi: find('Pi') };
}

// Sends the agent a message and runs its turn as far as the runner has started it.
async function runningTurn(t: T, caller: { mutation: Function }, roomId: Id<'rooms'>, participantId: Id<'participants'>, body = 'Go on') {
  const turnId = (await caller.mutation(api.messages.send, { roomId, body, toParticipantId: participantId })) as Id<'turns'>;
  const command = (await t.run(ctx => ctx.db.query('commands').collect())).find(c => c.turnId === turnId && c.type === 'run_turn')!;
  const job = await t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
  await t.mutation(api.runner.start, { secret: SECRET, turnId, harnessVersion: 'test' });
  return { turnId, commandId: command._id, job: job! };
}

function tools(t: T, turnId: Id<'turns'>) {
  const s = { secret: SECRET, turnId };
  return {
    read: () => t.query(api.documentTools.readDocumentForTurn, s),
    readThread: (threadId: string) => t.query(api.documentTools.readThreadForTurn, { ...s, threadId }),
    add: (text: string, place: { afterBlockId?: string; endOfSectionId?: string } = {}) =>
      t.mutation(api.documentTools.addBlockForTurn, { ...s, ...place, kind: 'paragraph', text }),
    update: (blockId: string, baseRev: number, text: string) => t.mutation(api.documentTools.updateBlockForTurn, { ...s, blockId, baseRev, text }),
    remove: (blockId: string, baseRev: number) => t.mutation(api.documentTools.deleteBlockForTurn, { ...s, blockId, baseRev }),
    comment: (blockId: string, quote: string, body: string) => t.mutation(api.documentTools.commentForTurn, { ...s, blockId, quote, body }),
  };
}

async function block(t: T, blockId: string) {
  return (await t.run(ctx => ctx.db.get(blockId as Id<'blocks'>)))!;
}

async function editBlock(caller: { mutation: Function }, blockId: Id<'blocks'>, text: string) {
  await caller.mutation(api.blocks.startEdit, { blockId });
  await caller.mutation(api.blocks.save, { blockId, text });
  await caller.mutation(api.blocks.stopEdit, { blockId });
}

async function addedBlock(result: { ok: boolean }) {
  expect(result.ok).toBe(true);
  return result as { ok: true; blockId: Id<'blocks'>; rev: number };
}

test('a model adds, updates and deletes its own blocks as one change set, under its own name, without taking a lease', async () => {
  const { t, owner, roomId, documentId, happened, ideas, claude } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const tool = tools(t, turnId);

  const first = await addedBlock(await tool.add('The cache is warmed on boot.', { endOfSectionId: happened._id }));
  const second = await addedBlock(await tool.add('A second finding.', { afterBlockId: first.blockId }));
  const order = (await owner.query(api.documents.get, { roomId }))!.blocks.map(b => b._id);
  expect(order.indexOf(first.blockId)).toBe(order.indexOf(happened._id) + 1);
  expect(order.indexOf(second.blockId)).toBe(order.indexOf(first.blockId) + 1);
  expect(order.indexOf(second.blockId)).toBeLessThan(order.indexOf(ideas._id));

  expect(await tool.update(first.blockId, first.rev, 'The cache is warmed on boot, slowly.')).toMatchObject({ ok: true });
  expect(await tool.remove(second.blockId, second.rev)).toEqual({ ok: true });

  const written = await block(t, first.blockId);
  expect(written).toMatchObject({ text: 'The cache is warmed on boot, slowly.', author: { kind: 'participant', participantId: claude._id } });
  expect(written.leaseHolderParticipantId).toBeUndefined();
  expect((await block(t, second.blockId)).deletedAt).toBeDefined();
  await t.run(async ctx => {
    const changeSets = (await ctx.db.query('changeSets').collect()).filter(c => c.documentId === documentId && c.kind === 'model_turn');
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0]).toMatchObject({ turnId, actorParticipantId: claude._id, revisionCount: 4 });
    const changed = (await ctx.db.query('ledger').collect()).filter(e => e.type === 'document.changed' && e.subjectId === changeSets[0]!._id);
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed)).not.toContain('cache');
  });
});

test('Claude cannot edit a block Codex wrote, and can comment on its passage instead', async () => {
  const { t, owner, roomId, claude, codex } = await setup();
  const codexTurn = await runningTurn(t, owner, roomId, codex._id);
  const codexBlock = await addedBlock(await tools(t, codexTurn.turnId).add('Ship the pricing page on Friday.'));

  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const tool = tools(t, turnId);
  const refused = await tool.update(codexBlock.blockId, codexBlock.rev, 'Ship it on Monday.');
  expect(refused).toMatchObject({ ok: false, reason: 'not_your_block' });
  expect((refused as { message: string }).message).toMatch(/Codex/);
  expect((refused as { message: string }).message).toMatch(/comment/i);
  expect(await tool.remove(codexBlock.blockId, codexBlock.rev)).toMatchObject({ ok: false, reason: 'not_your_block' });
  expect((await block(t, codexBlock.blockId)).text).toBe('Ship the pricing page on Friday.');

  const commented = await tool.comment(codexBlock.blockId, 'on Friday', 'Friday clashes with the freeze. @Pi what do you think?');
  expect(commented).toMatchObject({ ok: true });
  const { threadId } = commented as { threadId: Id<'threads'> };
  const { open } = await owner.query(api.threads.list, { roomId });
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ _id: threadId, blockId: codexBlock.blockId, exact: 'on Friday' });
  expect(open[0]!.comments.map((c: any) => [c.authorParticipantId, c.body, c.mentions])).toEqual([
    [claude._id, 'Friday clashes with the freeze. @Pi what do you think?', []],
  ]);
  // A model's comment summons no one.
  expect((await t.run(ctx => ctx.db.query('messages').collect())).filter(m => m.threadId)).toHaveLength(0);
});

test('a comment whose quote is not in the block is refused, so the model can quote it again', async () => {
  const { t, owner, roomId, happened, claude } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  expect(await tools(t, turnId).comment(happened._id, 'not there', 'Hm')).toMatchObject({ ok: false, reason: 'quote_not_found' });
  expect((await owner.query(api.threads.list, { roomId })).open).toHaveLength(0);
});

test('an update with a stale base rev is refused and returns the current text and who changed it', async () => {
  const { t, owner, dana, roomId, claude } = await setup();
  const first = await runningTurn(t, owner, roomId, claude._id);
  const added = await addedBlock(await tools(t, first.turnId).add('Use the smaller plan.'));
  await t.mutation(api.runner.finish, { secret: SECRET, turnId: first.turnId, commandId: first.commandId, finalText: 'ok', sessionId: 's', transcriptRef: '/t' });
  await editBlock(dana, added.blockId, 'Use the smaller plan, but keep annual billing.');

  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const refused = await tools(t, turnId).update(added.blockId, added.rev, 'Use the bigger plan.');
  const current = await block(t, added.blockId);
  expect(refused).toMatchObject({
    ok: false,
    reason: 'stale',
    current: { text: 'Use the smaller plan, but keep annual billing.', rev: current.rev, changedBy: 'Dana' },
  });
  expect(current.text).toBe('Use the smaller plan, but keep annual billing.');

  // With the current rev the model can build on the teammate's fix; the block stays its own.
  expect(await tools(t, turnId).update(added.blockId, current.rev, 'Use the smaller plan, but keep annual billing. Revisit in March.')).toMatchObject({ ok: true });
  expect((await block(t, added.blockId)).author).toEqual({ kind: 'participant', participantId: claude._id });
});

test('a model cannot delete a block the teammate edited, even with a fresh base rev', async () => {
  const { t, owner, dana, roomId, claude } = await setup();
  const first = await runningTurn(t, owner, roomId, claude._id);
  const added = await addedBlock(await tools(t, first.turnId).add('Draft finding.'));
  await t.mutation(api.runner.finish, { secret: SECRET, turnId: first.turnId, commandId: first.commandId, finalText: 'ok', sessionId: 's', transcriptRef: '/t' });
  await editBlock(dana, added.blockId, 'Draft finding, corrected by Dana.');

  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const refused = await tools(t, turnId).remove(added.blockId, (await block(t, added.blockId)).rev);
  expect(refused).toMatchObject({ ok: false, reason: 'human_edited' });
  expect((refused as { message: string }).message).toMatch(/comment/i);
  expect((await block(t, added.blockId)).deletedAt).toBeUndefined();
});

test('a write to a block someone is editing is refused and names the editor', async () => {
  const { t, owner, dana, roomId, claude } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const added = await addedBlock(await tools(t, turnId).add('Open question.'));
  await dana.mutation(api.blocks.startEdit, { blockId: added.blockId });

  const refused = await tools(t, turnId).update(added.blockId, added.rev, 'Answered.');
  expect(refused).toMatchObject({ ok: false, reason: 'being_edited', message: expect.stringContaining('Dana is editing this block') });
  expect(await tools(t, turnId).remove(added.blockId, added.rev)).toMatchObject({ ok: false, reason: 'being_edited' });

  // Once her lease lapses, the model's write goes through.
  vi.advanceTimersByTime(3 * 60_000);
  expect(await tools(t, turnId).update(added.blockId, added.rev, 'Answered.')).toMatchObject({ ok: true });
});

test('while the scribe works, block writes are refused with a notice and comments still work', async () => {
  const { t, owner, roomId, documentId, happened, claude, robert } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  await t.run(async ctx => {
    const scribeRunId = await ctx.db.insert('scribeRuns', { documentId, roomId, participantId: claude._id, startedByParticipantId: robert._id, status: 'running', startedAt: Date.now() });
    await ctx.db.patch(documentId, { scribeRunId, scribeLockExpiresAt: Date.now() + 35 * 60_000 });
  });
  const refused = await tools(t, turnId).add('A finding.');
  expect(refused).toMatchObject({ ok: false, reason: 'scribe_working', message: expect.stringMatching(/scribe is working/) });
  expect(await tools(t, turnId).comment(happened._id, 'happened', 'A note')).toMatchObject({ ok: true });
});

test('the 21st block write and the 11th comment in one turn are refused with the cap message', async () => {
  const { t, owner, roomId, happened, claude, codex } = await setup();
  expect(MODEL_LIMITS).toEqual({ blockWritesPerTurn: 20, commentsPerTurn: 10, blockChars: 4_000, documentBlocks: 600 });
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const tool = tools(t, turnId);
  for (let i = 0; i < 20; i++) expect(await tool.add(`Finding ${i}`)).toMatchObject({ ok: true });
  const refused = await tool.add('Finding 21');
  expect(refused).toMatchObject({ ok: false, reason: 'cap_reached', message: expect.stringContaining('20 block writes') });

  for (let i = 0; i < 10; i++) expect(await tool.comment(happened._id, 'happened', `Note ${i}`)).toMatchObject({ ok: true });
  expect(await tool.comment(happened._id, 'happened', 'Note 11')).toMatchObject({ ok: false, reason: 'cap_reached', message: expect.stringContaining('10 comments') });

  // Another turn has its own allowance.
  const next = await runningTurn(t, owner, roomId, codex._id, 'Next');
  expect(await tools(t, next.turnId).add('Finding 22')).toMatchObject({ ok: true });
});

test('a block over 4,000 characters and a block past the document\'s 600 are refused', async () => {
  const { t, owner, roomId, documentId, claude } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  expect(await tools(t, turnId).add('x'.repeat(4_001))).toMatchObject({ ok: false, reason: 'too_long' });
  expect(await tools(t, turnId).add('x'.repeat(4_000))).toMatchObject({ ok: true });

  await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'human_edit' });
    const blocks = await ctx.db.query('blocks').collect();
    let order = blocks.map(b => b.order).sort().at(-1)!;
    for (let i = blocks.length; i < 600; i++) {
      order = orderBetween(order, null);
      await insertBlock(ctx, changeSetId, { order, kind: 'paragraph', text: `filler ${i}`, author: { kind: 'participant', participantId: claude._id } });
    }
  });
  expect(await tools(t, turnId).add('One too many')).toMatchObject({ ok: false, reason: 'document_full' });
});

test('a write from a turn that is no longer running, or was never claimed, is refused', async () => {
  const { t, owner, roomId, claude, codex } = await setup();
  const { turnId, commandId } = await runningTurn(t, owner, roomId, claude._id);
  const added = await addedBlock(await tools(t, turnId).add('Before the end.'));
  await t.mutation(api.runner.finish, { secret: SECRET, turnId, commandId, finalText: 'ok', sessionId: 's', transcriptRef: '/t' });
  expect(await tools(t, turnId).add('After the end.')).toMatchObject({ ok: false, reason: 'turn_ended' });
  expect(await tools(t, turnId).update(added.blockId, added.rev, 'After the end.')).toMatchObject({ ok: false, reason: 'turn_ended' });
  expect(await tools(t, turnId).read()).toMatchObject({ ok: false, reason: 'turn_ended' });

  const queued = (await owner.mutation(api.messages.send, { roomId, body: 'Wait', toParticipantId: codex._id })) as Id<'turns'>;
  expect(await tools(t, queued).add('Too early.')).toMatchObject({ ok: false, reason: 'turn_ended' });
  await expect(t.mutation(api.documentTools.addBlockForTurn, { secret: 'wrong', turnId, kind: 'paragraph', text: 'x' })).rejects.toThrow();
});

test('a block from another room, or an id that is not a block, is not found', async () => {
  const { t, owner, runnerId, roomId, claude } = await setup();
  const otherRoom = await owner.mutation(api.rooms.create, { name: 'Elsewhere', runnerId, cwd: '/tmp/elsewhere' });
  const foreign = (await owner.query(api.documents.get, { roomId: otherRoom }))!.blocks[0]!;
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  expect(await tools(t, turnId).update(foreign._id, foreign.rev, 'Mine now')).toMatchObject({ ok: false, reason: 'not_found' });
  expect(await tools(t, turnId).comment(foreign._id, foreign.text, 'Hi')).toMatchObject({ ok: false, reason: 'not_found' });
  expect(await tools(t, turnId).add('Here', { afterBlockId: 'not-an-id' })).toMatchObject({ ok: false, reason: 'not_found' });
});

test('reading the document returns every block with its id, author and rev, and its threads', async () => {
  const { t, owner, dana, roomId, happened, claude } = await setup();
  const { turnId } = await runningTurn(t, owner, roomId, claude._id);
  const added = await addedBlock(await tools(t, turnId).add('My finding.'));
  const threadId = await dana.mutation(api.threads.create, { blockId: happened._id, start: 0, end: 4, body: 'Settle this later' });
  await owner.mutation(api.threads.settle, { threadId });

  const read = await tools(t, turnId).read();
  expect(read).toMatchObject({ ok: true });
  const { blocks, threads } = read as { blocks: any[]; threads: any[] };
  expect(blocks.find(b => b.id === happened._id)).toMatchObject({ kind: 'heading', text: "What's happened", author: 'Robert', yours: false });
  expect(blocks.find(b => b.id === added.blockId)).toMatchObject({ text: 'My finding.', author: 'Claude', yours: true, rev: added.rev });
  expect(threads).toEqual([expect.objectContaining({ id: threadId, blockId: happened._id, state: 'settled', passage: 'What', comments: 1 })]);

  const thread = await tools(t, turnId).readThread(threadId);
  expect(thread).toMatchObject({ ok: true, state: 'settled', passage: 'What', comments: [{ author: 'Dana', body: 'Settle this later' }] });
});

test('a phrase from team chat never reaches a digest, a tool result or a claim payload', async () => {
  const { t, owner, dana, roomId, happened, claude } = await setup();
  await owner.mutation(api.team.post, { roomId, body: 'TEAM-ONLY-PHRASE: between us, drop the pricing page' });
  await dana.mutation(api.team.post, { roomId, body: 'agreed, TEAM-ONLY-PHRASE' });

  const { turnId, job } = await runningTurn(t, owner, roomId, claude._id, 'Write down what we agreed');
  const tool = tools(t, turnId);
  const added = await addedBlock(await tool.add('We agreed to ship on Friday.'));
  const commented = await tool.comment(happened._id, 'happened', 'Noted.');
  const results = [
    job,
    added,
    commented,
    await tool.update(added.blockId, added.rev, 'We agreed to ship on Friday, after review.'),
    await tool.read(),
    await tool.readThread((commented as { threadId: string }).threadId),
  ];
  expect(JSON.stringify(results)).not.toContain('TEAM-ONLY-PHRASE');
  expect(job.type === 'run_turn' && job.turn.prompt).toContain('<room_document');
  await t.run(async ctx => {
    for (const table of ['blocks', 'blockRevisions', 'comments', 'turns'] as const) {
      expect(JSON.stringify(await ctx.db.query(table).collect())).not.toContain('TEAM-ONLY-PHRASE');
    }
  });
});
