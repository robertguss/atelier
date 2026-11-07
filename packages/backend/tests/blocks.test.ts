/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { insertBlock, openChangeSet, orderBetween } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

const MINUTE = 60_000;
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

// A paragraph Claude wrote in its own turn, right after a heading.
async function claudeParagraph(t: ReturnType<typeof convexTest>, documentId: Id<'documents'>, claudeId: Id<'participants'>, after: { order: string }, text: string) {
  return await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'model_turn', actorParticipantId: claudeId });
    const next = (await ctx.db.query('blocks').withIndex('by_document_order', q => q.eq('documentId', documentId).gt('order', after.order)).first())?.order ?? null;
    return await insertBlock(ctx, changeSetId, { order: orderBetween(after.order, next), kind: 'paragraph', text, author: { kind: 'participant', participantId: claudeId } });
  });
}

async function texts(owner: { query: Function }, roomId: Id<'rooms'>) {
  return ((await owner.query(api.documents.get, { roomId })) as { blocks: { text: string }[] }).blocks.map(b => b.text);
}

async function setScribeLock(t: ReturnType<typeof convexTest>, documentId: Id<'documents'>, roomId: Id<'rooms'>, participantId: Id<'participants'>, expiresAt: number) {
  await t.run(async ctx => {
    const scribeRunId = await ctx.db.insert('scribeRuns', { documentId, roomId, participantId, startedByParticipantId: participantId, status: 'running', startedAt: Date.now() });
    await ctx.db.patch(documentId, { scribeRunId, scribeLockExpiresAt: expiresAt });
  });
}

test('the teammate fixes a sentence in Claude\'s block: the block keeps Claude as author, is marked human-edited, and the revision is the teammate\'s', async () => {
  const { t, dana, owner, roomId, danaParticipant, claude, documentId, happened } = await setup();
  const blockId = await claudeParagraph(t, documentId, claude._id, happened, 'The cache is warmed on boot, wich is slow.');

  await dana.mutation(api.blocks.startEdit, { blockId });
  const savedAt = Date.now();
  await dana.mutation(api.blocks.save, { blockId, text: 'The cache is warmed on boot, which is slow.' });

  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === blockId)!;
  expect(block.text).toBe('The cache is warmed on boot, which is slow.');
  expect(block.author).toEqual({ kind: 'participant', participantId: claude._id });
  expect(block.humanEditedAt).toEqual(about(savedAt));
  const [latest] = (await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 1, cursor: null } })).page;
  expect([latest!.kind, latest!.actorParticipantId]).toEqual(['human_edit', danaParticipant._id]);
  const diff = await owner.query(api.history.diff, { changeSetId: latest!._id });
  expect(diff.map(r => [r.blockId, r.op, r.before?.text, r.after?.text])).toEqual([
    [blockId, 'update', 'The cache is warmed on boot, wich is slow.', 'The cache is warmed on boot, which is slow.'],
  ]);
});

test('editing your own block does not mark it human-edited', async () => {
  const { dana, owner, roomId } = await setup();
  const blockId = await dana.mutation(api.blocks.add, { roomId, endOfSectionId: (await owner.query(api.documents.get, { roomId }))!.blocks[0]!._id, kind: 'paragraph', text: 'My note' });
  await dana.mutation(api.blocks.save, { blockId, text: 'My note, revised' });
  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === blockId)!;
  expect(block.humanEditedAt).toBeUndefined();
});

test('while Robert edits a block, the teammate cannot start editing, save, move or remove it, and is told Robert is editing it', async () => {
  const { owner, dana, roomId, robert, ideas } = await setup();
  const startedAt = Date.now();
  const { expiresAt } = await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  expect(expiresAt).toEqual(about(startedAt + 2 * MINUTE));
  const block = (await dana.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === ideas._id)!;
  expect([block.leaseHolderParticipantId, block.leaseExpiresAt]).toEqual([robert._id, expiresAt]);

  await expect(dana.mutation(api.blocks.startEdit, { blockId: ideas._id })).rejects.toThrow('Robert is editing this block');
  await expect(dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Mine now' })).rejects.toThrow('Robert is editing this block');
  await expect(dana.mutation(api.blocks.move, { blockId: ideas._id, direction: 'up' })).rejects.toThrow('Robert is editing this block');
  await expect(dana.mutation(api.blocks.remove, { blockId: ideas._id })).rejects.toThrow('Robert is editing this block');
  expect(await texts(owner, roomId)).toEqual(["What's happened", 'Ideas & notes', 'Open questions']);
});

test('a renewed lease holds past two minutes from its start, and lapses two minutes after the last renewal', async () => {
  const { t, owner, dana, ideas } = await setup();
  await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  vi.advanceTimersByTime(90_000);
  await owner.mutation(api.blocks.renew, { blockId: ideas._id });
  vi.advanceTimersByTime(90_000);
  // The cleanup scheduled when the lease was taken has run and left the renewed lease alone.
  await t.finishInProgressScheduledFunctions();
  await expect(dana.mutation(api.blocks.startEdit, { blockId: ideas._id })).rejects.toThrow('Robert is editing this block');
  vi.advanceTimersByTime(31_000);
  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
});

test('after two minutes without renewal, Robert\'s save is refused as lapsed, the teammate can take the block, and Robert\'s later save names her', async () => {
  const { t, owner, dana, roomId, danaParticipant, ideas } = await setup();
  await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  vi.advanceTimersByTime(2 * MINUTE + 1);
  await expect(owner.mutation(api.blocks.save, { blockId: ideas._id, text: 'Late' })).rejects.toThrow('Your edit lock on this block has lapsed');
  await expect(owner.mutation(api.blocks.renew, { blockId: ideas._id })).rejects.toThrow('Your edit lock on this block has lapsed');

  // The scheduled cleanup clears the lapsed lease.
  await t.finishInProgressScheduledFunctions();
  const cleared = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === ideas._id)!;
  expect([cleared.leaseHolderParticipantId, cleared.leaseExpiresAt]).toEqual([undefined, undefined]);

  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await expect(owner.mutation(api.blocks.save, { blockId: ideas._id, text: 'Late' })).rejects.toThrow('Dana is editing this block');
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === ideas._id)!;
  expect([block.text, block.leaseHolderParticipantId]).toEqual(['Ideas', danaParticipant._id]);
});

test('two saves by the same person within one lease form one change set, and the next lease starts another', async () => {
  const { owner, dana, roomId, ideas } = await setup();
  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
  vi.advanceTimersByTime(30_000);
  await dana.mutation(api.blocks.renew, { blockId: ideas._id });
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas and notes' });
  await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

  const first = (await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 10, cursor: null } })).page;
  expect(first.map(c => [c.kind, c.revisionCount])).toEqual([['human_edit', 2], ['template_seed', 3]]);
  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === ideas._id)!;
  expect(block.leaseHolderParticipantId).toBeUndefined();

  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await dana.mutation(api.blocks.save, { blockId: ideas._id, text: 'Notes' });
  const second = (await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 10, cursor: null } })).page;
  expect(second.map(c => [c.kind, c.revisionCount])).toEqual([['human_edit', 1], ['human_edit', 2], ['template_seed', 3]]);
});

test('removing the teammate releases her lease at once, so Robert can edit the block', async () => {
  const { owner, dana, roomId, ideas } = await setup();
  await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  const { members } = await owner.query(api.members.list, { roomId });
  await owner.mutation(api.members.remove, { memberId: members.find(m => m.role === 'member')!._id });

  const block = (await owner.query(api.documents.get, { roomId }))!.blocks.find(b => b._id === ideas._id)!;
  expect([block.leaseHolderParticipantId, block.leaseExpiresAt]).toEqual([undefined, undefined]);
  await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  await owner.mutation(api.blocks.save, { blockId: ideas._id, text: 'Ideas' });
});

test('every human edit is refused with a notice that the scribe is working while its lock is unexpired, and allowed once it lapses', async () => {
  const { t, owner, dana, roomId, claude, documentId, happened, ideas } = await setup();
  await dana.mutation(api.blocks.startEdit, { blockId: happened._id });
  await setScribeLock(t, documentId, roomId, claude._id, Date.now() + 10 * MINUTE);

  const working = 'The scribe is working on the document';
  await expect(owner.mutation(api.blocks.startEdit, { blockId: ideas._id })).rejects.toThrow(working);
  await expect(dana.mutation(api.blocks.renew, { blockId: happened._id })).rejects.toThrow(working);
  await expect(dana.mutation(api.blocks.save, { blockId: happened._id, text: 'Changed' })).rejects.toThrow(working);
  await expect(owner.mutation(api.blocks.add, { roomId, afterBlockId: ideas._id, kind: 'paragraph', text: 'New' })).rejects.toThrow(working);
  await expect(owner.mutation(api.blocks.move, { blockId: ideas._id, direction: 'down' })).rejects.toThrow(working);
  await expect(owner.mutation(api.blocks.remove, { blockId: ideas._id })).rejects.toThrow(working);
  expect(await texts(owner, roomId)).toEqual(["What's happened", 'Ideas & notes', 'Open questions']);

  vi.advanceTimersByTime(10 * MINUTE + 1);
  await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
});

test('a person adds a block after a block or at the end of a section, as its author, and the add and later saves form one change set', async () => {
  const { t, owner, dana, roomId, robert, danaParticipant, claude, documentId, happened, ideas } = await setup();
  await claudeParagraph(t, documentId, claude._id, happened, 'Claude finding');

  const endOfSection = await dana.mutation(api.blocks.add, { roomId, endOfSectionId: happened._id, kind: 'listItem', text: '' });
  await dana.mutation(api.blocks.save, { blockId: endOfSection, text: 'Dana item' });
  const afterHeading = await owner.mutation(api.blocks.add, { roomId, afterBlockId: ideas._id, kind: 'paragraph', text: 'Robert idea' });
  const lastSection = await owner.mutation(api.blocks.add, { roomId, endOfSectionId: (await owner.query(api.documents.get, { roomId }))!.blocks.at(-1)!._id, kind: 'heading', text: 'Decisions' });

  const blocks = (await owner.query(api.documents.get, { roomId }))!.blocks;
  expect(blocks.map(b => [b.kind, b.text])).toEqual([
    ['heading', "What's happened"],
    ['paragraph', 'Claude finding'],
    ['listItem', 'Dana item'],
    ['heading', 'Ideas & notes'],
    ['paragraph', 'Robert idea'],
    ['heading', 'Open questions'],
    ['heading', 'Decisions'],
  ]);
  const byId = new Map(blocks.map(b => [b._id, b]));
  expect(byId.get(endOfSection)!.author).toEqual({ kind: 'participant', participantId: danaParticipant._id });
  expect(byId.get(afterHeading)!.author).toEqual({ kind: 'participant', participantId: robert._id });
  // Adding a block starts editing it.
  expect(byId.get(lastSection)!.leaseHolderParticipantId).toBe(robert._id);

  const history = (await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 3, cursor: null } })).page;
  expect(history.map(c => [c.kind, c.actorParticipantId, c.revisionCount])).toEqual([
    ['human_edit', robert._id, 1],
    ['human_edit', robert._id, 1],
    ['human_edit', danaParticipant._id, 2],
  ]);
});

test('a person moves a block up and down past its neighbours and removes it', async () => {
  const { owner, dana, roomId, happened, questions } = await setup();
  await dana.mutation(api.blocks.move, { blockId: questions._id, direction: 'up' });
  expect(await texts(owner, roomId)).toEqual(["What's happened", 'Open questions', 'Ideas & notes']);
  await dana.mutation(api.blocks.move, { blockId: questions._id, direction: 'up' });
  expect(await texts(owner, roomId)).toEqual(['Open questions', "What's happened", 'Ideas & notes']);
  // The first block cannot move further up.
  await dana.mutation(api.blocks.move, { blockId: questions._id, direction: 'up' });
  await dana.mutation(api.blocks.move, { blockId: happened._id, direction: 'down' });
  expect(await texts(owner, roomId)).toEqual(['Open questions', 'Ideas & notes', "What's happened"]);

  await owner.mutation(api.blocks.remove, { blockId: happened._id });
  expect(await texts(owner, roomId)).toEqual(['Open questions', 'Ideas & notes']);
  await expect(owner.mutation(api.blocks.startEdit, { blockId: happened._id })).rejects.toThrow('This block has been removed');

  const history = (await owner.query(api.history.list, { roomId, paginationOpts: { numItems: 4, cursor: null } })).page;
  const ops = [];
  for (const changeSet of history) ops.push((await owner.query(api.history.diff, { changeSetId: changeSet._id })).map(r => r.op));
  expect(ops).toEqual([['delete'], ['move'], ['move'], ['move']]);
});

test('a person cannot save or add a block longer than a model may write, or add past the document\'s block limit', async () => {
  const s = await setup();
  const long = 'x'.repeat(4_001);
  await s.owner.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
  await expect(s.owner.mutation(api.blocks.save, { blockId: s.ideas._id, text: long })).rejects.toThrow('at most 4000 characters');
  await s.owner.mutation(api.blocks.save, { blockId: s.ideas._id, text: 'x'.repeat(4_000) });
  await expect(s.owner.mutation(api.blocks.add, { roomId: s.roomId, kind: 'paragraph', text: long })).rejects.toThrow('at most 4000 characters');

  await s.t.run(async ctx => {
    const live = (await ctx.db.query('blocks').collect()).length;
    for (let i = live; i < 600; i++) {
      await ctx.db.insert('blocks', { documentId: s.documentId, roomId: s.roomId, order: `b${String(i).padStart(4, '0')}`, kind: 'paragraph', text: 'filler', author: { kind: 'participant', participantId: s.robert._id }, rev: 0 });
    }
  });
  await expect(s.owner.mutation(api.blocks.add, { roomId: s.roomId, kind: 'paragraph', text: 'one too many' })).rejects.toThrow('at most 600 blocks');
});

test('someone outside the room cannot edit its blocks', async () => {
  const { t, ideas } = await setup();
  const eve = t.withIdentity({ email: 'eve@example.com', subject: 'eve', name: 'Eve' });
  await expect(eve.mutation(api.blocks.startEdit, { blockId: ideas._id })).rejects.toThrow('Not a member of this room');
});
