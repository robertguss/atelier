/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { deleteBlock, insertBlock, liveBlocks, openChangeSet, orderBetween, patchBlock } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

const DAY = 24 * 60 * 60 * 1000;
const FIRST_PAGE = { numItems: 50, cursor: null };
// Each transaction runs at its own commit time, which can be a few ticks ahead of the frozen test clock.
const about = (ms: number) => expect.closeTo(ms, -2);

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = 'test-secret';
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Test = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: 'test-secret', name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }] });
  const roomId = await owner.mutation(api.rooms.create, { name: 'Planning', runnerId, cwd: '/tmp/planning' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'user_1' }])));
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: invite.url.split('/invite/')[1]! });
  vi.unstubAllGlobals();
  const participants = (await owner.query(api.rooms.get, { roomId }))!.participants;
  const robert = participants.find(p => p.displayName === 'Robert')!;
  const danaParticipant = participants.find(p => p.displayName === 'Dana')!;
  const claude = participants.find(p => p.harness === 'claude')!;
  const doc = (await owner.query(api.documents.get, { roomId }))!;
  const [happened, ideas, questions] = doc.blocks;
  return { t, owner, dana, roomId, robert, danaParticipant, claude, documentId: doc.documentId, happened: happened!, ideas: ideas!, questions: questions! };
}

// The live blocks as a version reports them.
async function current(t: Test, documentId: Id<'documents'>) {
  return await t.run(async ctx => (await liveBlocks(ctx, documentId)).map(b => ({ blockId: b._id, order: b.order, kind: b.kind, text: b.text, author: b.author })));
}

async function latestChangeSet(owner: { query: Function }, roomId: Id<'rooms'>) {
  const { page } = await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 1, cursor: null } }) as { page: { _id: Id<'changeSets'> }[] };
  return page[0]!._id;
}

// `count` revisions by a model in one change set: mostly text updates, with
// regular inserts, moves and deletes, so a rebuild has every kind to replay.
async function churn(t: Test, documentId: Id<'documents'>, claudeId: Id<'participants'>, count: number, label: string) {
  await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: claudeId });
    for (let i = 0; i < count; i++) {
      const blocks = await liveBlocks(ctx, documentId);
      const target = blocks[i % blocks.length]!;
      if (i % 5 === 0 || blocks.length < 4) {
        const next = blocks[(i % blocks.length) + 1]?.order ?? null;
        await insertBlock(ctx, changeSetId, { order: orderBetween(target.order, next), kind: 'paragraph', text: `${label} added ${i}`, author: { kind: 'participant', participantId: claudeId } });
      } else if (i % 11 === 0) {
        await deleteBlock(ctx, changeSetId, target._id);
      } else if (i % 7 === 0) {
        await patchBlock(ctx, changeSetId, target._id, { order: orderBetween(null, blocks[0]!.order) });
      } else {
        await patchBlock(ctx, changeSetId, target._id, { text: `${label} text ${i}` });
      }
    }
  });
}

test('history lists change sets newest first, page by page, with actor, kind and time', async () => {
  const { owner, dana, roomId, robert, danaParticipant, ideas, questions } = await setup();
  const seededAt = Date.now();
  vi.advanceTimersByTime(1000);
  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
  vi.advanceTimersByTime(1000);
  await owner.mutation(api.blocks.remove, { blockId: questions._id });

  const first = await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page.map(c => [c.kind, c.actorParticipantId, c.at])).toEqual([
    ['human_edit', robert._id, about(seededAt + 2000)],
    ['human_edit', danaParticipant._id, about(seededAt + 1000)],
  ]);
  expect(first.isDone).toBe(false);
  const second = await dana.query(api.history.list, { roomId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
  expect(second.page.map(c => [c.kind, c.actorParticipantId, c.at])).toEqual([['template_seed', robert._id, about(seededAt)]]);
});

test('a change set\'s diff lists its revisions in order with the text before and after', async () => {
  const { owner, roomId, ideas } = await setup();
  await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await owner.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
  await owner.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas!' });
  const diff = await owner.query(api.history.diff, { changeSetId: await latestChangeSet(owner, roomId) });
  expect(diff.map(r => [r.blockId, r.op, r.before?.text, r.after?.text])).toEqual([
    [ideas._id, 'update', 'Ideas & notes', 'Ideas'],
    [ideas._id, 'update', 'Ideas', 'Ideas!'],
  ]);
});

test('a version 450 revisions back, past two checkpoints, is rebuilt exactly as the document was then', async () => {
  const { t, owner, roomId, claude, documentId } = await setup();
  const seedId = await latestChangeSet(owner, roomId);
  const seeded = await current(t, documentId);

  // Revisions 4 to 250; the first checkpoint is taken at 200.
  await churn(t, documentId, claude._id, 147, 'early');
  await churn(t, documentId, claude._id, 100, 'middle');
  const chosen = await latestChangeSet(owner, roomId);
  const then = await current(t, documentId);

  // Revisions 251 to 700, with checkpoints at 400 and 600.
  await churn(t, documentId, claude._id, 150, 'later');
  await churn(t, documentId, claude._id, 300, 'latest');
  await t.run(async ctx => {
    expect((await ctx.db.get(documentId))!.rev).toBe(700);
    expect((await ctx.db.query('documentCheckpoints').collect()).map(c => c.rev)).toEqual([200, 400, 600]);
  });
  expect(await current(t, documentId)).not.toEqual(then);

  const version = await owner.query(api.history.version, { changeSetId: chosen });
  expect(version.rev).toBe(250);
  expect(version.blocks).toEqual(then);
  expect((await owner.query(api.history.version, { changeSetId: seedId })).blocks).toEqual(seeded);
  expect((await owner.query(api.history.version, { changeSetId: await latestChangeSet(owner, roomId) })).blocks).toEqual(await current(t, documentId));
});

test('Robert restores yesterday\'s version: today\'s state is saved first, block ids are kept, and history shows one restore by Robert', async () => {
  const { t, owner, dana, roomId, robert, danaParticipant, documentId, happened, ideas, questions } = await setup();
  const plan = await owner.mutation(api.blocks.add, { roomId, endOfSectionId: happened._id, kind: 'paragraph', text: "Yesterday's plan" });
  await owner.mutation(api.blocks.stopEdit, { blockId: plan });
  const note = await dana.mutation(api.blocks.add, { roomId, endOfSectionId: ideas._id, kind: 'listItem', text: "Dana's note" });
  await dana.mutation(api.blocks.stopEdit, { blockId: note });
  const yesterdayId = await latestChangeSet(owner, roomId);
  const yesterday = await current(t, documentId);

  vi.advanceTimersByTime(DAY);
  await dana.mutation(api.blocks.startEdit, { blockId: plan });
  await dana.mutation(api.blocks.save, { blockId: plan, text: "Today's plan" });
  await dana.mutation(api.blocks.stopEdit, { blockId: plan });
  await owner.mutation(api.blocks.remove, { blockId: note });
  const added = await owner.mutation(api.blocks.add, { roomId, endOfSectionId: questions._id, kind: 'paragraph', text: 'Added today' });
  await owner.mutation(api.blocks.stopEdit, { blockId: added });
  await dana.mutation(api.blocks.move, { blockId: questions._id, direction: 'up' });
  const todayId = await latestChangeSet(owner, roomId);
  const today = await current(t, documentId);

  const restoredAt = Date.now();
  await owner.mutation(api.history.restore, { changeSetId: yesterdayId });

  expect(await current(t, documentId)).toEqual(yesterday);
  const blocks = (await owner.query(api.documents.get, { roomId }))!.blocks;
  expect(blocks.map(b => b._id)).toEqual([happened._id, plan, ideas._id, note, questions._id]);
  // A re-created block keeps its author.
  expect(blocks.find(b => b._id === note)!.author).toEqual({ kind: 'participant', participantId: danaParticipant._id });

  // Today's state was saved as a checkpoint first, and its version still rebuilds.
  await t.run(async ctx => {
    const checkpoints = await ctx.db.query('documentCheckpoints').collect();
    expect(checkpoints.map(c => [c.reason, c.blockCount])).toEqual([['before_restore', today.length]]);
    const rows = await ctx.db.query('checkpointBlocks').withIndex('by_checkpoint', q => q.eq('checkpointId', checkpoints[0]!._id)).collect();
    rows.sort((a, b) => (a.order < b.order ? -1 : 1));
    expect(rows.map(r => ({ blockId: r.blockId, order: r.order, kind: r.kind, text: r.text, author: r.author }))).toEqual(today);
  });
  expect((await owner.query(api.history.version, { changeSetId: todayId })).blocks).toEqual(today);

  const history = (await owner.query(api.history.list, { roomId, paginationOpts: FIRST_PAGE })).page;
  expect(history.filter(c => c.kind === 'restore')).toHaveLength(1);
  const [restore] = history;
  expect([restore!.kind, restore!.actorParticipantId, restore!.at]).toEqual(['restore', robert._id, about(restoredAt)]);
  const diff = await owner.query(api.history.diff, { changeSetId: restore!._id });
  expect(diff.map(r => [r.blockId, r.op]).sort()).toEqual([
    [added, 'delete'],
    [note, 'insert'],
    [plan, 'update'],
    [questions._id, 'move'],
  ].sort());

  await t.run(async ctx => {
    const ledger = await ctx.db.query('ledger').collect();
    const restored = ledger.filter(e => e.type === 'document.restored');
    expect(restored.map(e => [e.actorParticipantId, e.subjectId, e.payload])).toEqual([
      [robert._id, restore!._id, { documentId, changeSetId: restore!._id, restoredChangeSetId: yesterdayId }],
    ]);
    expect(JSON.stringify(ledger)).not.toContain("Yesterday's plan");
  });
});

test('restoring a version sets the human-edited mark on a model\'s block whose text it changes', async () => {
  const { t, owner, roomId, claude, documentId, happened } = await setup();
  const blockId = await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: claude._id });
    return await insertBlock(ctx, changeSetId, { order: orderBetween(happened.order, null), kind: 'paragraph', text: 'First finding', author: { kind: 'participant', participantId: claude._id } });
  });
  const firstId = await latestChangeSet(owner, roomId);
  await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: claude._id });
    await patchBlock(ctx, changeSetId, blockId, { text: 'Revised finding' });
  });

  const restoredAt = Date.now();
  await owner.mutation(api.history.restore, { changeSetId: firstId });
  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === blockId)!;
  expect([block.text, block.author, block.humanEditedAt]).toEqual(['First finding', { kind: 'participant', participantId: claude._id }, about(restoredAt)]);
});

test('restore is refused while anyone holds an edit lease, naming them, and while the scribe is working', async () => {
  const { t, owner, dana, roomId, claude, documentId, ideas } = await setup();
  const seedId = await latestChangeSet(owner, roomId);
  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
  await expect(owner.mutation(api.history.restore, { changeSetId: seedId })).rejects.toThrow('Dana is editing a block');
  await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

  await t.run(async ctx => {
    const scribeRunId = await ctx.db.insert('scribeRuns', { documentId, roomId, participantId: claude._id, startedByParticipantId: claude._id, status: 'running', startedAt: Date.now() });
    await ctx.db.patch(documentId, { scribeRunId, scribeLockExpiresAt: Date.now() + 60_000 });
  });
  await expect(dana.mutation(api.history.restore, { changeSetId: seedId })).rejects.toThrow('The scribe is working on the document');

  await t.run(async ctx => {
    expect(await ctx.db.query('documentCheckpoints').collect()).toEqual([]);
    expect((await ctx.db.query('changeSets').collect()).filter(c => c.kind === 'restore')).toEqual([]);
  });
  expect((await owner.query(api.documents.get, { roomId }))!.blocks.map(b => b.text)).toContain('Ideas');
});

test('someone outside the room cannot read its history', async () => {
  const { t, owner, roomId } = await setup();
  const eve = t.withIdentity({ email: 'eve@example.com', subject: 'eve', name: 'Eve' });
  const changeSetId = await latestChangeSet(owner, roomId);
  await expect(eve.query(api.history.list, { roomId, paginationOpts: FIRST_PAGE })).rejects.toThrow('Not a member of this room');
  await expect(eve.query(api.history.version, { changeSetId })).rejects.toThrow('Not a member of this room');
  await expect(eve.query(api.history.diff, { changeSetId })).rejects.toThrow('Not a member of this room');
  await expect(eve.mutation(api.history.restore, { changeSetId })).rejects.toThrow('Not a member of this room');
});
