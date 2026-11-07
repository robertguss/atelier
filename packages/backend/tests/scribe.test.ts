/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { insertBlock, liveBlocks, openChangeSet, orderBetween } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

const SECRET = 'test-secret';
const MINUTE = 60_000;
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
type Caller = { mutation: Function; query: Function };

async function heartbeat(t: T) {
  return await t.mutation(api.runners.heartbeat, { secret: SECRET, name: 'test', machine: 'test', harnesses: HARNESSES });
}

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await heartbeat(t);
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
  const [happened, ideas, questions] = doc.blocks;
  return {
    t, owner, dana, runnerId, roomId, documentId: doc.documentId as Id<'documents'>,
    happened: happened!, ideas: ideas!, questions: questions!,
    robert: find('Robert'), danaP: find('Dana'), claude: find('Claude'), codex: find('Codex'), pi: find('Pi'),
  };
}

// A paragraph by `participantId` at the end of the document, as its own model turn's change set.
async function paragraph(t: T, documentId: Id<'documents'>, participantId: Id<'participants'>, text: string) {
  return await t.run(async ctx => {
    const blocks = await liveBlocks(ctx, documentId);
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: participantId });
    return await insertBlock(ctx, changeSetId, { order: orderBetween(blocks.at(-1)?.order ?? null, null), kind: 'paragraph', text, author: { kind: 'participant', participantId } });
  });
}

// Many paragraphs by one author at the end of the document, in one change set.
async function paragraphs(t: T, documentId: Id<'documents'>, participantId: Id<'participants'>, texts: string[]) {
  return await t.run(async ctx => {
    let last = (await liveBlocks(ctx, documentId)).at(-1)?.order ?? null;
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: participantId });
    const ids = [];
    for (const text of texts) {
      last = orderBetween(last, null);
      ids.push(await insertBlock(ctx, changeSetId, { order: last, kind: 'paragraph', text, author: { kind: 'participant', participantId } }));
    }
    return ids;
  });
}

async function runTurnCommand(t: T, turnId: Id<'turns'>) {
  return (await t.run(ctx => ctx.db.query('commands').withIndex('by_turn', q => q.eq('turnId', turnId)).collect())).find(c => c.type === 'run_turn')!;
}

// Calls in the scribe; with `start`, claims and starts its turn as the runner would.
async function beginScribe(t: T, caller: Caller, roomId: Id<'rooms'>, participantId: Id<'participants'>, { start = true } = {}) {
  const scribeRunId = (await caller.mutation(api.scribe.begin, { roomId, participantId })) as Id<'scribeRuns'>;
  const turnId = (await t.run(ctx => ctx.db.get(scribeRunId)))!.turnId!;
  const command = await runTurnCommand(t, turnId);
  let job = null;
  if (start) {
    job = await t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
    await t.mutation(api.runner.start, { secret: SECRET, turnId, harnessVersion: 'test' });
  }
  return { scribeRunId, turnId, commandId: command._id, job };
}

async function draft(t: T, turnId: Id<'turns'>, op: Record<string, unknown>) {
  return (await t.mutation(api.documentTools.scribeDraftForTurn, { secret: SECRET, turnId, op: op as never })) as any;
}

async function finish(t: T, turnId: Id<'turns'>, commandId: Id<'commands'>, sessionId?: string) {
  await t.mutation(api.runner.finish, { secret: SECRET, turnId, commandId, finalText: 'Tidied the document.', transcriptRef: '/tmp/t.ndjson', ...(sessionId ? { sessionId } : {}) });
}

// Ordinary turn running for a participant, started from a person's message.
async function ordinaryTurn(t: T, caller: Caller, roomId: Id<'rooms'>, participantId: Id<'participants'>) {
  const turnId = (await caller.mutation(api.messages.send, { roomId, body: 'Go on', toParticipantId: participantId })) as Id<'turns'>;
  const command = await runTurnCommand(t, turnId);
  await t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
  await t.mutation(api.runner.start, { secret: SECRET, turnId, harnessVersion: 'test' });
  return { turnId, commandId: command._id };
}

const state = (b: { order: string; kind: string; text: string; author: unknown }) => ({ order: b.order, kind: b.kind, text: b.text, author: b.author });

async function currentDocument(t: T, documentId: Id<'documents'>) {
  return await t.run(async ctx => (await liveBlocks(ctx, documentId)).map(b => ({ blockId: b._id, ...state(b) })));
}

async function checkpointBlocks(t: T, documentId: Id<'documents'>, reason: Doc<'documentCheckpoints'>['reason']) {
  return await t.run(async ctx => {
    const checkpoint = (await ctx.db.query('documentCheckpoints').withIndex('by_document_rev', q => q.eq('documentId', documentId)).collect()).filter(c => c.reason === reason).at(-1);
    if (!checkpoint) return null;
    const rows = await ctx.db.query('checkpointBlocks').withIndex('by_checkpoint', q => q.eq('checkpointId', checkpoint._id)).collect();
    return rows.map(r => ({ blockId: r.blockId, ...state(r) })).sort((a, b) => (a.order < b.order ? -1 : 1));
  });
}

async function document(t: T, documentId: Id<'documents'>) {
  return (await t.run(ctx => ctx.db.get(documentId)))!;
}

async function runOf(t: T, scribeRunId: Id<'scribeRuns'>) {
  return (await t.run(ctx => ctx.db.get(scribeRunId)))!;
}

async function draftRows(t: T, scribeRunId: Id<'scribeRuns'>) {
  return (await t.run(ctx => ctx.db.query('scribeDraftOps').collect())).filter(o => o.scribeRunId === scribeRunId);
}

async function scribeChangeSets(t: T, documentId: Id<'documents'>) {
  return (await t.run(ctx => ctx.db.query('changeSets').collect())).filter(c => c.documentId === documentId && c.kind === 'scribe_run');
}

// A run with a draft that rewrites, removes and adds, so a release that kept
// any of it would show.
async function runWithDraft(s: Awaited<ReturnType<typeof setup>>) {
  const a = await paragraph(s.t, s.documentId, s.codex._id, 'Codex: the cache warms on boot.');
  const b = await paragraph(s.t, s.documentId, s.pi._id, 'Pi: boot warms the cache.');
  const run = await beginScribe(s.t, s.dana, s.roomId, s.claude._id);
  expect(await draft(s.t, run.turnId, { op: 'replace', blockId: a, text: 'The cache warms on boot.', sourceBlockIds: [b] })).toMatchObject({ ok: true });
  expect(await draft(s.t, run.turnId, { op: 'remove', blockId: b })).toMatchObject({ ok: true });
  expect(await draft(s.t, run.turnId, { op: 'add', kind: 'heading', text: 'Summary', sourceBlockIds: [], afterBlockId: 'start' })).toMatchObject({ ok: true });
  return { ...run, a, b };
}

async function expectReleased(t: T, documentId: Id<'documents'>, scribeRunId: Id<'scribeRuns'>) {
  expect(await currentDocument(t, documentId)).toEqual(await checkpointBlocks(t, documentId, 'before_scribe'));
  const doc = await document(t, documentId);
  expect(doc.scribeRunId).toBeUndefined();
  expect(doc.scribeLockExpiresAt).toBeUndefined();
  expect(await runOf(t, scribeRunId)).toMatchObject({ status: 'released' });
  expect(await draftRows(t, scribeRunId)).toEqual([]);
  expect(await scribeChangeSets(t, documentId)).toEqual([]);
}

test('a scribe run merges two blocks and deletes a commented passage: one change set by the scribe, both authors credited, the thread kept open with a link to the version before', async () => {
  const s = await setup();
  const { t, owner, dana, roomId, documentId } = s;
  const codexNote = await paragraph(t, documentId, s.codex._id, 'Use Postgres for the queue.');
  const piNote = await paragraph(t, documentId, s.pi._id, 'Postgres is fine for the queue at our size.');
  const stale = await paragraph(t, documentId, s.robert._id, 'Ask Sam about the Friday freeze.');
  const before = await currentDocument(t, documentId);

  // Threads on the block that gets merged away and on the passage that gets deleted.
  const onPi = await owner.mutation(api.threads.create, { blockId: piNote, start: 0, end: 'Postgres is fine'.length, body: 'Agreed.' });
  const onStale = await owner.mutation(api.threads.create, { blockId: stale, start: 0, end: 'Ask Sam'.length, body: 'Did anyone?' });

  const run = await beginScribe(t, dana, roomId, s.claude._id);
  expect(await checkpointBlocks(t, documentId, 'before_scribe')).toEqual(before);
  const merged = await draft(t, run.turnId, { op: 'replace', blockId: codexNote, text: 'Postgres is fine for the queue at our size (Codex, Pi).', sourceBlockIds: [piNote] });
  expect(merged.ok).toBe(true);
  const mergedAway = await draft(t, run.turnId, { op: 'remove', blockId: piNote });
  expect(mergedAway.report.threads.moving).toEqual([{ threadId: onPi, passage: 'Postgres is fine', toBlockId: codexNote }]);
  const removed = await draft(t, run.turnId, { op: 'remove', blockId: stale });
  expect(removed.report.threads.detaching).toEqual([{ threadId: onStale, passage: 'Ask Sam', blockId: stale }]);
  expect(removed.report.removedUndrawn).toEqual([stale]);
  await finish(t, run.turnId, run.commandId);

  const after = await currentDocument(t, documentId);
  expect(after.map(b => b.blockId)).not.toContain(piNote);
  expect(after.map(b => b.blockId)).not.toContain(stale);
  const mergedBlock = (await t.run(ctx => ctx.db.get(codexNote)))!;
  expect(mergedBlock).toMatchObject({
    text: 'Postgres is fine for the queue at our size (Codex, Pi).',
    author: { kind: 'scribe', participantId: s.claude._id, credits: [s.codex._id, s.pi._id] },
    sourceBlockIds: [codexNote, piNote],
  });

  const [changeSet, ...others] = await scribeChangeSets(t, documentId);
  expect(others).toEqual([]);
  expect(changeSet).toMatchObject({ actorParticipantId: s.claude._id, scribeRunId: run.scribeRunId, revisionCount: 3 });
  const history = await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 10, cursor: null } });
  expect(history.page[0]).toMatchObject({ _id: changeSet!._id, kind: 'scribe_run', actorParticipantId: s.claude._id, scribeParticipantId: s.claude._id, scribeStartedByParticipantId: s.danaP._id });

  const threads = await t.run(ctx => ctx.db.query('threads').collect());
  const piThread = threads.find(th => th.exact === 'Postgres is fine')!;
  expect(piThread).toMatchObject({ state: 'open', blockId: codexNote });
  expect(piThread.detachedBeforeChangeSetId).toBeUndefined();
  const staleThread = threads.find(th => th.exact === 'Ask Sam')!;
  expect(staleThread).toMatchObject({ state: 'open', blockId: stale, detachedBeforeChangeSetId: changeSet!._id });
  const original = await owner.query(api.history.versionBefore, { changeSetId: changeSet!._id });
  expect(original.blocks.find((b: { blockId: string }) => b.blockId === stale)?.text).toBe('Ask Sam about the Friday freeze.');

  expect(await checkpointBlocks(t, documentId, 'after_scribe')).toEqual(after);
  expect(await document(t, documentId)).not.toHaveProperty('scribeRunId');
  expect(await document(t, documentId)).not.toHaveProperty('scribeLockExpiresAt');
  expect(await runOf(t, run.scribeRunId)).toMatchObject({ status: 'committed' });
  expect(await draftRows(t, run.scribeRunId)).toEqual([]);

  const started = (await t.run(ctx => ctx.db.query('ledger').collect())).filter(e => e.type === 'document.scribe_started');
  expect(started).toEqual([expect.objectContaining({ actorParticipantId: s.danaP._id, subjectId: run.scribeRunId, payload: { documentId, scribeRunId: run.scribeRunId, turnId: run.turnId, participantId: s.claude._id } })]);
});

test('the scribe turn is claimed with the scribe document mode, the full document with block ids, no session, edits off and the scribe instructions', async () => {
  const s = await setup();
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  await s.t.run(ctx => ctx.db.patch(s.claude._id, { harnessSessionId: 'ordinary-session', documentRevSeen: 1 }));
  const note = await paragraph(s.t, s.documentId, s.codex._id, 'Use Postgres for the queue.');
  const { job, turnId } = await beginScribe(s.t, s.dana, s.roomId, s.claude._id);
  expect(job).toMatchObject({ type: 'run_turn', documentMode: 'scribe', participant: { id: s.claude._id }, room: { editsEnabled: false } });
  expect((job as { participant: { sessionId?: string } }).participant.sessionId).toBeUndefined();
  const prompt = (job as { turn: { prompt: string } }).turn.prompt;
  expect(prompt).toContain('<room_document');
  expect(prompt).toContain(`[${note}]`);
  expect(prompt).toContain('Dana has called you in as the scribe');
  expect(prompt).toMatch(/does not mention is kept exactly as it is/);
  expect(prompt).toMatch(/sourceBlockIds/);
  expect(prompt).toMatch(/keep each view and say whose it is/);
  expect(prompt).toMatch(/Do not drop open questions/);
  expect(prompt).toContain('File edits: off.');
  expect((await s.t.run(ctx => ctx.db.get(turnId)))!.editsEnabled).toBe(false);
});

test('a scribe turn cannot use the ordinary write tools, and only the scribe turn can use the draft tools', async () => {
  const s = await setup();
  const note = await paragraph(s.t, s.documentId, s.claude._id, 'Claude wrote this.');
  const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
  const run = await beginScribe(s.t, s.dana, s.roomId, s.claude._id);
  const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, { secret: SECRET, turnId: run.turnId, blockId: note, baseRev: 1, text: 'Changed' });
  expect(refused).toMatchObject({ ok: false, reason: 'read_only', message: expect.stringMatching(/draft tools/) });
  expect(await s.t.mutation(api.documentTools.addBlockForTurn, { secret: SECRET, turnId: run.turnId, kind: 'paragraph', text: 'More' })).toMatchObject({ ok: false, reason: 'read_only' });
  expect(await draft(s.t, codexTurn.turnId, { op: 'keep', blockId: note })).toMatchObject({ ok: false, reason: 'not_scribe' });
  const read = await s.t.query(api.documentTools.readDocumentForTurn, { secret: SECRET, turnId: run.turnId });
  expect(read).toMatchObject({ ok: true, writable: false, scribe: true });
});

test('while the scribe works, the teammate\'s edit and a Codex update_block are refused with the scribe notice', async () => {
  const s = await setup();
  const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
  const added = (await s.t.mutation(api.documentTools.addBlockForTurn, { secret: SECRET, turnId: codexTurn.turnId, kind: 'paragraph', text: 'Ship on Friday.' })) as { ok: true; blockId: Id<'blocks'>; rev: number };
  await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await expect(s.dana.mutation(api.blocks.startEdit, { blockId: s.happened._id })).rejects.toThrow('The scribe is working on the document');
  const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, { secret: SECRET, turnId: codexTurn.turnId, blockId: added.blockId, baseRev: added.rev, text: 'Ship on Monday.' });
  expect(refused).toMatchObject({ ok: false, reason: 'scribe_working', message: expect.stringMatching(/scribe is working/) });
});

test('calling in the scribe while the teammate edits a block is refused, naming her', async () => {
  const s = await setup();
  await s.dana.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
  await expect(s.owner.mutation(api.scribe.begin, { roomId: s.roomId, participantId: s.claude._id })).rejects.toThrow('Dana is editing a block');
  expect((await document(s.t, s.documentId)).scribeRunId).toBeUndefined();
  expect(await s.t.run(ctx => ctx.db.query('scribeRuns').collect())).toEqual([]);
});

test('calling in the scribe is refused while that model is answering, and allowed once its turn ends', async () => {
  const s = await setup();
  const busy = await ordinaryTurn(s.t, s.owner, s.roomId, s.claude._id);
  await expect(s.owner.mutation(api.scribe.begin, { roomId: s.roomId, participantId: s.claude._id })).rejects.toThrow('Claude is still answering');
  expect(await s.t.run(ctx => ctx.db.query('scribeRuns').collect())).toEqual([]);
  await finish(s.t, busy.turnId, busy.commandId);
  await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  expect(await s.t.run(ctx => ctx.db.query('scribeRuns').collect())).toHaveLength(1);
});

test('calling in the scribe with the runner offline, or while a run is working, is refused', async () => {
  const s = await setup();
  vi.advanceTimersByTime(46_000);
  await expect(s.owner.mutation(api.scribe.begin, { roomId: s.roomId, participantId: s.claude._id })).rejects.toThrow(/runner .* is offline/);
  await heartbeat(s.t);
  await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await expect(s.dana.mutation(api.scribe.begin, { roomId: s.roomId, participantId: s.codex._id })).rejects.toThrow('The scribe is working on the document');
  expect(await s.t.run(ctx => ctx.db.query('scribeRuns').collect())).toHaveLength(1);
});

test('a failed scribe turn leaves the document as the checkpoint before the run, with the lock cleared', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  await s.t.mutation(api.runner.fail, { secret: SECRET, turnId: run.turnId, commandId: run.commandId, error: 'Model overloaded' });
  await expectReleased(s.t, s.documentId, run.scribeRunId);
  expect(await runOf(s.t, run.scribeRunId)).toMatchObject({ releaseReason: 'Model overloaded' });
});

test('stopping the scribe leaves the document as the checkpoint before the run, with the lock cleared', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  await s.owner.mutation(api.messages.cancel, { turnId: run.turnId });
  await expectReleased(s.t, s.documentId, run.scribeRunId);
  // A finish the runner sends after the stop changes nothing.
  await finish(s.t, run.turnId, run.commandId).catch(() => {});
  await expectReleased(s.t, s.documentId, run.scribeRunId);
});

test('a runner restart during the scribe turn leaves the document as the checkpoint before the run, with the lock cleared', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  await s.t.mutation(api.runner.recover, { secret: SECRET, runnerId: s.runnerId });
  await expectReleased(s.t, s.documentId, run.scribeRunId);
});

test('the lease cron reclaiming a silent scribe turn leaves the document as the checkpoint before the run, with the lock cleared', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  vi.advanceTimersByTime(6 * MINUTE);
  await s.t.mutation(internal.runner.reclaimExpiredLeases, {});
  expect((await s.t.run(ctx => ctx.db.get(run.turnId)))!.status).toBe('interrupted');
  await expectReleased(s.t, s.documentId, run.scribeRunId);
});

test('the lock expiring under a running scribe turn fails the turn and leaves the document as the checkpoint before the run', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  expect((await document(s.t, s.documentId)).scribeLockExpiresAt).toEqual(expect.closeTo(Date.now() + 35 * MINUTE, -2));
  vi.advanceTimersByTime(35 * MINUTE + 1_000);
  await s.t.finishInProgressScheduledFunctions();
  expect((await s.t.run(ctx => ctx.db.get(run.turnId)))!.status).toBe('failed');
  expect((await s.t.run(ctx => ctx.db.get(run.commandId)))!.status).toBe('failed');
  await expectReleased(s.t, s.documentId, run.scribeRunId);
});

test('a scribe command the runner never claims is ended by the lock expiry, leaving the document as it was and the lock cleared', async () => {
  const s = await setup();
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id, { start: false });
  vi.advanceTimersByTime(35 * MINUTE + 1_000);
  await s.t.finishInProgressScheduledFunctions();
  expect((await s.t.run(ctx => ctx.db.get(run.commandId)))!.status).toBe('failed');
  expect((await s.t.run(ctx => ctx.db.get(run.turnId)))!.status).toBe('failed');
  await expectReleased(s.t, s.documentId, run.scribeRunId);
  // A runner that comes back later cannot start it.
  await heartbeat(s.t);
  expect(await s.t.mutation(api.runner.claim, { secret: SECRET, commandId: run.commandId })).toBeNull();
});

test('a finish that arrives after the lock expiry released the run commits nothing', async () => {
  const s = await setup();
  const run = await runWithDraft(s);
  vi.advanceTimersByTime(35 * MINUTE + 1_000);
  await s.t.finishInProgressScheduledFunctions();
  await finish(s.t, run.turnId, run.commandId);
  await expectReleased(s.t, s.documentId, run.scribeRunId);
});

test('a comment posted during the run re-attaches to the block that absorbs its passage', async () => {
  const s = await setup();
  const a = await paragraph(s.t, s.documentId, s.codex._id, 'Cache warming takes ten minutes.');
  const b = await paragraph(s.t, s.documentId, s.pi._id, 'We could warm the cache lazily.');
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await draft(s.t, run.turnId, { op: 'replace', blockId: a, text: 'Cache warming takes ten minutes. We could warm the cache lazily.', sourceBlockIds: [b] });
  await draft(s.t, run.turnId, { op: 'remove', blockId: b });
  // Dana comments mid-run on the block the draft removes.
  const posted = await s.dana.mutation(api.threads.create, { blockId: b, start: 'We could '.length, end: 'We could warm the cache lazily'.length, body: 'How much faster?' });
  await finish(s.t, run.turnId, run.commandId);
  const thread = (await s.t.run(ctx => ctx.db.get(posted)))!;
  expect(thread).toMatchObject({ state: 'open', blockId: a, exact: 'warm the cache lazily' });
  expect(thread.detachedBeforeChangeSetId).toBeUndefined();
});

test('between runs a model\'s update_block on a scribe block is refused with comment instead, including from the model that acted as scribe', async () => {
  const s = await setup();
  const a = await paragraph(s.t, s.documentId, s.claude._id, 'Claude: first note.');
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await draft(s.t, run.turnId, { op: 'replace', blockId: a, text: 'Consolidated note.' });
  await finish(s.t, run.turnId, run.commandId);
  const block = (await s.t.run(ctx => ctx.db.get(a)))!;
  expect(block.author).toEqual({ kind: 'scribe', participantId: s.claude._id, credits: [s.claude._id] });
  for (const model of [s.claude, s.codex]) {
    await heartbeat(s.t);
    const { turnId } = await ordinaryTurn(s.t, s.owner, s.roomId, model._id);
    const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, { secret: SECRET, turnId, blockId: a, baseRev: block.rev, text: 'Reverted.' });
    expect(refused).toMatchObject({ ok: false, reason: 'not_your_block', message: expect.stringMatching(/comment on it instead/) });
  }
});

test('a draft that mentions 5 of 300 blocks keeps the other 295 unchanged', async () => {
  const s = await setup();
  const ids = await paragraphs(s.t, s.documentId, s.codex._id, Array.from({ length: 297 }, (_, i) => `Note ${i}`));
  const before = new Map((await currentDocument(s.t, s.documentId)).map(b => [b.blockId, b]));
  expect(before.size).toBe(300);
  const revs = new Map((await s.t.run(ctx => liveBlocks(ctx, s.documentId))).map(b => [b._id, b.rev]));
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await draft(s.t, run.turnId, { op: 'replace', blockId: ids[10], text: 'Note 10, merged with note 11.', sourceBlockIds: [ids[11]] });
  await draft(s.t, run.turnId, { op: 'remove', blockId: ids[11] });
  await draft(s.t, run.turnId, { op: 'move', blockId: ids[200], afterBlockId: s.happened._id });
  await draft(s.t, run.turnId, { op: 'keep', blockId: ids[5] });
  const last = await draft(s.t, run.turnId, { op: 'remove', blockId: ids[296] });
  expect(last.report).toMatchObject({ blocks: 300, untouched: { count: 295 }, replaced: 1, removed: 2, moved: 1, added: 0, finalBlocks: 298 });
  await finish(s.t, run.turnId, run.commandId);

  const mentioned = new Set<string>([ids[10]!, ids[11]!, ids[200]!, ids[5]!, ids[296]!]);
  const after = await s.t.run(ctx => liveBlocks(ctx, s.documentId));
  const untouched = after.filter(b => !mentioned.has(b._id));
  expect(untouched).toHaveLength(295);
  for (const b of untouched) {
    expect(state(b)).toEqual(state(before.get(b._id)!));
    expect(b.rev).toBe(revs.get(b._id));
  }
  expect(after.find(b => b._id === ids[5])).toMatchObject(state(before.get(ids[5]!)!));
  const order = after.map(b => b._id);
  expect(order.indexOf(ids[200]!)).toBe(order.indexOf(s.happened._id) + 1);
  const [changeSet] = await scribeChangeSets(s.t, s.documentId);
  expect(changeSet!.revisionCount).toBe(4);
});

test('a later draft operation on the same block supersedes the earlier one', async () => {
  const s = await setup();
  const a = await paragraph(s.t, s.documentId, s.codex._id, 'Original.');
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await draft(s.t, run.turnId, { op: 'replace', blockId: a, text: 'First try.' });
  await draft(s.t, run.turnId, { op: 'replace', blockId: a, text: 'Second try.' });
  const added = await draft(s.t, run.turnId, { op: 'add', kind: 'paragraph', text: 'New block.', sourceBlockIds: [a], afterBlockId: a });
  expect(added.draftId).toMatch(/^new-\d+$/);
  await draft(s.t, run.turnId, { op: 'add', kind: 'paragraph', text: 'After the new block.', sourceBlockIds: [], afterBlockId: added.draftId });
  await draft(s.t, run.turnId, { op: 'replace', blockId: added.draftId, text: 'New block, reworded.' });
  const missing = await draft(s.t, run.turnId, { op: 'remove', blockId: 'new-999' });
  expect(missing).toMatchObject({ ok: false, reason: 'not_found' });
  await finish(s.t, run.turnId, run.commandId);
  const texts = (await currentDocument(s.t, s.documentId)).map(b => b.text);
  expect(texts.slice(-3)).toEqual(['Second try.', 'New block, reworded.', 'After the new block.']);
  const reworded = (await s.t.run(ctx => liveBlocks(ctx, s.documentId))).find(b => b.text === 'New block, reworded.')!;
  expect(reworded).toMatchObject({ author: { kind: 'scribe', participantId: s.claude._id, credits: [s.codex._id] }, sourceBlockIds: [a] });
});

test('the scribe turn never saves a session id on the participant', async () => {
  const s = await setup();
  await s.t.run(ctx => ctx.db.patch(s.claude._id, { harnessSessionId: 'ordinary-session', documentRevSeen: 3 }));
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  await s.t.mutation(api.runner.sessionStarted, { secret: SECRET, turnId: run.turnId, sessionId: 'scribe-session' });
  await finish(s.t, run.turnId, run.commandId, 'scribe-session');
  expect(await s.t.run(ctx => ctx.db.get(s.claude._id))).toMatchObject({ harnessSessionId: 'ordinary-session', documentRevSeen: 3 });
});

test('a steer-now message to the scribe model during the run stays queued and runs as its own turn after the run ends', async () => {
  const s = await setup();
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  const sent = await s.dana.mutation(api.messages.send, { roomId: s.roomId, body: 'WAIT-FOR-SCRIBE', toParticipantId: s.claude._id, steer: true });
  expect(sent).toBeNull();
  const message = (await s.t.run(ctx => ctx.db.query('messages').collect())).find(m => m.body === 'WAIT-FOR-SCRIBE')!;
  expect(message.delivery).toBe('queued');
  await expect(s.dana.mutation(api.agent.steer, { messageId: message._id })).resolves.toEqual({ status: 'queued' });
  expect((await s.t.run(ctx => ctx.db.query('commands').collect())).filter(c => c.type === 'steer')).toEqual([]);

  await finish(s.t, run.turnId, run.commandId);
  const turns = (await s.t.run(ctx => ctx.db.query('turns').collect())).filter(t => t.participantId === s.claude._id);
  expect(turns).toHaveLength(2);
  const next = turns.find(t => t._id !== run.turnId)!;
  expect(next.status).toBe('queued');
  expect(next.scribeRunId).toBeUndefined();
  expect(next.prompt).toContain('WAIT-FOR-SCRIBE');
  expect(next.prompt).not.toContain('scribe for the room document');
  expect((await s.t.run(ctx => ctx.db.get(message._id)))!).toMatchObject({ delivery: 'delivered', deliveredTurnId: next._id });
});

test('turning the edit switch on during a run sends the scribe turn no settings change', async () => {
  const s = await setup();
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  const settings = (await s.t.run(ctx => ctx.db.query('commands').collect())).filter(c => c.type === 'settings');
  expect(settings.map(c => c.turnId)).toEqual([codexTurn.turnId]);
  expect((await s.t.run(ctx => ctx.db.get(run.turnId)))!.editsEnabled).toBe(false);
});

test('a 600-block document of 4,000-character blocks checkpoints before the run, and a draft replacing every block commits', async () => {
  const s = await setup();
  const text = (i: number, tag: string) => `${tag} ${i} `.padEnd(4_000, 'x');
  await paragraphs(s.t, s.documentId, s.codex._id, Array.from({ length: 597 }, (_, i) => text(i, 'Codex')));
  const blocks = await s.t.run(ctx => liveBlocks(ctx, s.documentId));
  expect(blocks).toHaveLength(600);
  const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
  expect(await checkpointBlocks(s.t, s.documentId, 'before_scribe')).toHaveLength(600);
  // The draft is written straight to its table: 600 tool calls would only slow the test.
  await s.t.run(async ctx => {
    for (const [seq, b] of blocks.entries()) {
      await ctx.db.insert('scribeDraftOps', { scribeRunId: run.scribeRunId, seq, op: 'replace', blockId: b._id, text: text(seq, 'Scribe') });
    }
  });
  await finish(s.t, run.turnId, run.commandId);
  const after = await s.t.run(ctx => liveBlocks(ctx, s.documentId));
  expect(after).toHaveLength(600);
  expect(after.every((b, i) => b.text === text(i, 'Scribe') && b.author.kind === 'scribe')).toBe(true);
  const [changeSet] = await scribeChangeSets(s.t, s.documentId);
  expect(changeSet!.revisionCount).toBe(600);
  expect(await checkpointBlocks(s.t, s.documentId, 'after_scribe')).toHaveLength(600);
  // The commit ends with its own checkpoint, with none taken in the middle of it.
  const checkpoints = await s.t.run(ctx => ctx.db.query('documentCheckpoints').collect());
  expect(checkpoints.filter(c => c.reason === 'interval' && c.rev > changeSet!.lastRev - 600)).toEqual([]);
});

test('the room\'s latest scribe run shows its scribe, who started it and its turn while working, then how it ended and its change set', async () => {
  const s = await setup();
  const outsider = s.t.withIdentity({ email: 'eve@example.com', subject: 'eve', name: 'Eve' });
  expect(await s.dana.query(api.scribe.latest, { roomId: s.roomId })).toBeNull();

  const stopped = await runWithDraft(s);
  const working = await s.dana.query(api.scribe.latest, { roomId: s.roomId });
  expect(working).toMatchObject({ runId: stopped.scribeRunId, participantId: s.claude._id, startedByParticipantId: s.danaP._id, status: 'running', turnId: stopped.turnId, startedAt: (await runOf(s.t, stopped.scribeRunId)).startedAt });
  expect(working!.changeSetId).toBeUndefined();
  expect(working!.stoppedByParticipantId).toBeUndefined();
  await expect(outsider.query(api.scribe.latest, { roomId: s.roomId })).rejects.toThrow('Not a member of this room');

  await s.owner.mutation(api.messages.cancel, { turnId: stopped.turnId });
  expect(await s.dana.query(api.scribe.latest, { roomId: s.roomId })).toMatchObject({ runId: stopped.scribeRunId, status: 'released', releaseReason: 'Cancelled by owner', stoppedByParticipantId: s.robert._id });

  const committed = await beginScribe(s.t, s.owner, s.roomId, s.pi._id);
  await draft(s.t, committed.turnId, { op: 'replace', blockId: s.ideas._id, text: 'Ideas', sourceBlockIds: [] });
  await finish(s.t, committed.turnId, committed.commandId);
  const [changeSet] = await scribeChangeSets(s.t, s.documentId);
  expect(await s.dana.query(api.scribe.latest, { roomId: s.roomId })).toMatchObject({
    runId: committed.scribeRunId, participantId: s.pi._id, startedByParticipantId: s.robert._id, status: 'committed', changeSetId: changeSet!._id,
  });
});
