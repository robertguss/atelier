/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { deleteBlock, insertBlock, openChangeSet, orderBetween, patchBlock } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

const DEFAULT_HEADINGS = ["What's happened", 'Ideas & notes', 'Open questions'];

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
  const eve = t.withIdentity({ email: 'eve@example.com', subject: 'eve', name: 'Eve' });
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
  return { t, owner, dana, eve, roomId, robert, danaParticipant, claude };
}

// Removes a room's document and its history, as for a room created before documents existed.
async function dropDocument(t: ReturnType<typeof convexTest>) {
  await t.run(async ctx => {
    for (const table of ['blockRevisions', 'blocks', 'changeSets', 'documents'] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
    for (const row of (await ctx.db.query('ledger').collect()).filter(e => e.type === 'document.changed')) await ctx.db.delete(row._id);
  });
}

test('creating a room with no template seeds the three default headings, attributed to Robert, in one template seeding change set', async () => {
  const { t, owner, roomId, robert } = await setup();
  const doc = (await owner.query(api.documents.get, { roomId }))!;
  expect(doc.blocks.map(b => [b.kind, b.text, b.author])).toEqual(
    DEFAULT_HEADINGS.map(text => ['heading', text, { kind: 'participant', participantId: robert._id }]),
  );
  expect(doc.rev).toBe(3);

  await t.run(async ctx => {
    const changeSets = await ctx.db.query('changeSets').collect();
    expect(changeSets.map(c => [c.kind, c.actorParticipantId, c.revisionCount])).toEqual([['template_seed', robert._id, 3]]);
    const revisions = await ctx.db.query('blockRevisions').collect();
    expect(revisions.map(r => [r.op, r.changeSetId, r.rev, r.after?.text])).toEqual(
      DEFAULT_HEADINGS.map((text, i) => ['insert', changeSets[0]!._id, i + 1, text]),
    );
    const document = (await ctx.db.query('documents').collect())[0]!;
    expect(document.roomId).toBe(roomId);
    expect(document.templateId).toBeUndefined();
  });
});

test('the seeding ledger row carries ids and no block text', async () => {
  const { t, roomId, robert } = await setup();
  await t.run(async ctx => {
    const ledger = await ctx.db.query('ledger').collect();
    const changed = ledger.filter(e => e.type === 'document.changed');
    const changeSet = (await ctx.db.query('changeSets').collect())[0]!;
    const document = (await ctx.db.query('documents').collect())[0]!;
    expect(changed.map(e => [e.roomId, e.actorParticipantId, e.subjectId, e.payload])).toEqual([
      [roomId, robert._id, changeSet._id, { documentId: document._id, changeSetId: changeSet._id, kind: 'template_seed' }],
    ]);
    for (const heading of DEFAULT_HEADINGS) expect(JSON.stringify(ledger)).not.toContain(heading);
  });
});

test('documents.ensure seeds the default once for an older room with no document, and a second call changes nothing', async () => {
  const { t, owner, dana, roomId, robert } = await setup();
  await dropDocument(t);
  expect(await owner.query(api.documents.get, { roomId })).toBeNull();

  // The teammate opens the room first; the seeded headings are still Robert's.
  const documentId = await dana.mutation(api.documents.ensure, { roomId });
  const doc = (await dana.query(api.documents.get, { roomId }))!;
  expect(doc.documentId).toBe(documentId);
  expect(doc.blocks.map(b => [b.text, b.author])).toEqual(
    DEFAULT_HEADINGS.map(text => [text, { kind: 'participant', participantId: robert._id }]),
  );

  expect(await owner.mutation(api.documents.ensure, { roomId })).toBe(documentId);
  expect(await owner.query(api.documents.get, { roomId })).toEqual(doc);
  await t.run(async ctx => {
    expect(await ctx.db.query('documents').collect()).toHaveLength(1);
    expect(await ctx.db.query('changeSets').collect()).toHaveLength(1);
    expect(await ctx.db.query('blockRevisions').collect()).toHaveLength(3);
    expect((await ctx.db.query('ledger').collect()).filter(e => e.type === 'document.changed')).toHaveLength(1);
  });
});

test('both members read the document, while a non-member and a removed member are refused', async () => {
  const { owner, dana, eve, roomId } = await setup();
  const forOwner = await owner.query(api.documents.get, { roomId });
  expect(await dana.query(api.documents.get, { roomId })).toEqual(forOwner);
  await expect(eve.query(api.documents.get, { roomId })).rejects.toThrow('Not a member of this room');
  await expect(eve.mutation(api.documents.ensure, { roomId })).rejects.toThrow('Not a member of this room');

  const { members } = await owner.query(api.members.list, { roomId });
  await owner.mutation(api.members.remove, { memberId: members.find(m => m.role === 'member')!._id });
  await expect(dana.query(api.documents.get, { roomId })).rejects.toThrow('no longer a member');
  await expect(dana.mutation(api.documents.ensure, { roomId })).rejects.toThrow('no longer a member');
});

test('documents.get shows each block\'s lease holder and its number of open threads', async () => {
  const { t, owner, roomId, danaParticipant } = await setup();
  const [first, second] = (await owner.query(api.documents.get, { roomId }))!.blocks;
  await t.run(async ctx => {
    await ctx.db.patch(first!._id, { leaseHolderParticipantId: danaParticipant._id, leaseExpiresAt: Date.now() + 120_000 });
    const document = (await ctx.db.query('documents').collect())[0]!;
    const thread = { documentId: document._id, roomId, exact: 'happened', prefix: "What's ", suffix: '', position: 7 };
    await ctx.db.insert('threads', { ...thread, blockId: first!._id, state: 'open' });
    await ctx.db.insert('threads', { ...thread, blockId: first!._id, state: 'open' });
    await ctx.db.insert('threads', { ...thread, blockId: second!._id, state: 'settled' });
  });
  const blocks = (await owner.query(api.documents.get, { roomId }))!.blocks;
  expect(blocks.map(b => [b.leaseHolderParticipantId, b.openThreads])).toEqual([
    [danaParticipant._id, 2],
    [undefined, 0],
    [undefined, 0],
  ]);
});

test('the 200th revision takes a checkpoint that holds every live block, and none is taken before it', async () => {
  const { t, owner, roomId, danaParticipant } = await setup();
  const seeded = (await owner.query(api.documents.get, { roomId }))!;
  const documentId = seeded.documentId;
  const [first, second, third] = seeded.blocks;

  // Seeding wrote revisions 1 to 3. Revisions 4 and 5 add a paragraph and remove a heading.
  let paragraphId: Id<'blocks'>;
  await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'human_edit', actorParticipantId: danaParticipant._id });
    paragraphId = await insertBlock(ctx, changeSetId, {
      order: orderBetween(first!.order, second!.order),
      kind: 'paragraph',
      text: 'draft 0',
      author: { kind: 'participant', participantId: danaParticipant._id },
    });
    await deleteBlock(ctx, changeSetId, third!._id);
    for (let i = 1; i <= 194; i++) await patchBlock(ctx, changeSetId, paragraphId, { text: `draft ${i}` });
  });
  await t.run(async ctx => {
    expect((await ctx.db.get(documentId))!.rev).toBe(199);
    expect(await ctx.db.query('documentCheckpoints').collect()).toEqual([]);
  });

  await t.run(async ctx => {
    const changeSetId = await openChangeSet(ctx, documentId, { kind: 'human_edit', actorParticipantId: danaParticipant._id });
    await patchBlock(ctx, changeSetId, paragraphId, { text: 'final text' });
  });
  await t.run(async ctx => {
    const document = (await ctx.db.get(documentId))!;
    expect([document.rev, document.revisionsSinceCheckpoint]).toEqual([200, 0]);
    const checkpoints = await ctx.db.query('documentCheckpoints').collect();
    expect(checkpoints.map(c => [c.documentId, c.rev, c.reason, c.blockCount])).toEqual([[documentId, 200, 'interval', 3]]);
    const rows = await ctx.db.query('checkpointBlocks').withIndex('by_checkpoint', q => q.eq('checkpointId', checkpoints[0]!._id)).collect();
    rows.sort((a, b) => (a.order < b.order ? -1 : 1));
    expect(rows.map(r => [r.blockId, r.kind, r.text])).toEqual([
      [first!._id, 'heading', "What's happened"],
      [paragraphId, 'paragraph', 'final text'],
      [second!._id, 'heading', 'Ideas & notes'],
    ]);
  });
  expect((await owner.query(api.documents.get, { roomId }))!.blocks.map(b => b.text)).toEqual(["What's happened", 'final text', 'Ideas & notes']);
});
