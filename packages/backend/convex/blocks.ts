import { v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { requireMember } from './lib/auth';
import {
  DOCUMENT_BLOCKS,
  LEASE_MS,
  SCRIBE_WORKING,
  blockTextProblem,
  clearLease,
  deleteBlock,
  getDocument,
  insertBlock,
  leaseHolder,
  liveBlocks,
  openChangeSet,
  orderBetween,
  participantName,
  patchBlock,
  scribeWorking,
} from './lib/document';
import { blockKind } from './schema';

// People edit the document one block at a time. Starting to edit takes a
// lease on the block; the browser renews it while the person types, and it
// lapses LEASE_MS after the last renewal. Everything a person writes under
// one lease forms one change set.

const LAPSED = 'Your edit lock on this block has lapsed';

// The block and the member acting on it, refusing while the scribe works.
async function loadForEdit(ctx: MutationCtx, blockId: Id<'blocks'>) {
  const block = await ctx.db.get(blockId);
  if (!block) throw new Error('Unknown block');
  const { participant } = await requireMember(ctx, block.roomId);
  if (block.deletedAt !== undefined) throw new Error('This block has been removed');
  const now = Date.now();
  const document = (await ctx.db.get(block.documentId))!;
  if (scribeWorking(document, now)) throw new Error(SCRIBE_WORKING);
  return { block, participant, now };
}

// Refuses when someone else holds an unexpired lease on the block.
async function refuseIfHeldByOther(ctx: MutationCtx, block: Doc<'blocks'>, participantId: Id<'participants'>, now: number) {
  const holder = leaseHolder(block, now);
  if (holder && holder !== participantId) throw new Error(`${await participantName(ctx, holder)} is editing this block`);
}

// Refuses unless the person holds an unexpired lease on the block.
async function requireOwnLease(ctx: MutationCtx, block: Doc<'blocks'>, participantId: Id<'participants'>, now: number) {
  await refuseIfHeldByOther(ctx, block, participantId, now);
  if (leaseHolder(block, now) !== participantId) throw new Error(LAPSED);
}

async function grantLease(ctx: MutationCtx, blockId: Id<'blocks'>, participantId: Id<'participants'>, now: number, leaseChangeSetId?: Id<'changeSets'>) {
  const expiresAt = now + LEASE_MS;
  await ctx.db.patch(blockId, { leaseHolderParticipantId: participantId, leaseExpiresAt: expiresAt, leaseChangeSetId });
  await ctx.scheduler.runAt(expiresAt, internal.blocks.expireLease, { blockId });
  return { expiresAt };
}

// The change set a person's write to the block joins: their lease's, opened
// on its first write, or a new one when they hold no lease on it.
async function personChangeSet(ctx: MutationCtx, block: Doc<'blocks'>, participantId: Id<'participants'>, now: number) {
  const holdsLease = leaseHolder(block, now) === participantId;
  if (holdsLease && block.leaseChangeSetId) return block.leaseChangeSetId;
  const changeSetId = await openChangeSet(ctx, block.documentId, { kind: 'human_edit', actorParticipantId: participantId });
  if (holdsLease) await ctx.db.patch(block._id, { leaseChangeSetId: changeSetId });
  return changeSetId;
}

export const startEdit = mutation({
  args: { blockId: v.id('blocks') },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    // Taking the block again while the lease is still yours keeps its change set.
    const kept = leaseHolder(block, now) === participant._id ? block.leaseChangeSetId : undefined;
    return await grantLease(ctx, blockId, participant._id, now, kept);
  },
});

export const renew = mutation({
  args: { blockId: v.id('blocks') },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await requireOwnLease(ctx, block, participant._id, now);
    return await grantLease(ctx, blockId, participant._id, now, block.leaseChangeSetId);
  },
});

// Ends the person's lease; their next edit of the block is a new change set.
export const stopEdit = mutation({
  args: { blockId: v.id('blocks') },
  handler: async (ctx, { blockId }) => {
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error('Unknown block');
    const { participant } = await requireMember(ctx, block.roomId);
    if (block.leaseHolderParticipantId === participant._id) await clearLease(ctx, blockId);
  },
});

// Writes the block's text and renews the lease. The block keeps its author;
// a block someone else wrote is marked as edited by a human.
export const save = mutation({
  args: { blockId: v.id('blocks'), text: v.string() },
  handler: async (ctx, { blockId, text }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await requireOwnLease(ctx, block, participant._id, now);
    const problem = blockTextProblem(text);
    if (problem) throw new Error(problem);
    if (text === block.text) {
      await grantLease(ctx, blockId, participant._id, now, block.leaseChangeSetId);
      return;
    }
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    await grantLease(ctx, blockId, participant._id, now, changeSetId);
    const ownBlock = block.author.kind === 'participant' && block.author.participantId === participant._id;
    await patchBlock(ctx, changeSetId, blockId, { text, ...(ownBlock ? {} : { humanEditedAt: now }) });
  },
});

// Adds a block after another, at the end of a heading's section, or at the
// end of the document when neither is given. The person who adds it is its
// author and starts editing it, so the add and their typing form one change set.
export const add = mutation({
  args: {
    roomId: v.id('rooms'),
    afterBlockId: v.optional(v.id('blocks')),
    endOfSectionId: v.optional(v.id('blocks')),
    kind: blockKind,
    text: v.string(),
  },
  handler: async (ctx, { roomId, afterBlockId, endOfSectionId, kind, text }) => {
    const { participant } = await requireMember(ctx, roomId);
    if (afterBlockId && endOfSectionId) throw new Error('Choose one place for the new block');
    const document = await getDocument(ctx, roomId);
    if (!document) throw new Error('This room has no document yet');
    const now = Date.now();
    if (scribeWorking(document, now)) throw new Error(SCRIBE_WORKING);
    const problem = blockTextProblem(text);
    if (problem) throw new Error(problem);
    const blocks = await liveBlocks(ctx, document._id);
    if (blocks.length >= DOCUMENT_BLOCKS) throw new Error(`The document holds at most ${DOCUMENT_BLOCKS} blocks. Merge or remove some first.`);
    const anchorId = afterBlockId ?? endOfSectionId;
    let index = blocks.length - 1;
    if (anchorId) {
      index = blocks.findIndex((b) => b._id === anchorId);
      if (index < 0) throw new Error('That block has been removed');
      if (endOfSectionId) while (blocks[index + 1] && blocks[index + 1]!.kind !== 'heading') index++;
    }
    const order = orderBetween(blocks[index]?.order ?? null, blocks[index + 1]?.order ?? null);
    const changeSetId = await openChangeSet(ctx, document._id, { kind: 'human_edit', actorParticipantId: participant._id });
    const blockId = await insertBlock(ctx, changeSetId, { order, kind, text, author: { kind: 'participant', participantId: participant._id } });
    await grantLease(ctx, blockId, participant._id, now, changeSetId);
    return blockId;
  },
});

export const remove = mutation({
  args: { blockId: v.id('blocks') },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    await deleteBlock(ctx, changeSetId, blockId);
    await clearLease(ctx, blockId);
  },
});

// Moves a block one place up or down. At the top or bottom it stays put.
export const move = mutation({
  args: { blockId: v.id('blocks'), direction: v.union(v.literal('up'), v.literal('down')) },
  handler: async (ctx, { blockId, direction }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    const blocks = await liveBlocks(ctx, block.documentId);
    const index = blocks.findIndex((b) => b._id === blockId);
    const [before, after] = direction === 'up' ? [blocks[index - 2], blocks[index - 1]] : [blocks[index + 1], blocks[index + 2]];
    const neighbour = direction === 'up' ? after : before;
    if (!neighbour) return;
    const order = orderBetween(before?.order ?? null, after?.order ?? null);
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    await patchBlock(ctx, changeSetId, blockId, { order });
  },
});

// Scheduled for each lease's expiry when it is taken or renewed. A lease
// renewed since then has a later expiry and is left alone.
export const expireLease = internalMutation({
  args: { blockId: v.id('blocks') },
  handler: async (ctx, { blockId }) => {
    const block = await ctx.db.get(blockId);
    if (!block || block.leaseExpiresAt === undefined || block.leaseExpiresAt > Date.now()) return;
    await clearLease(ctx, blockId);
  },
});
