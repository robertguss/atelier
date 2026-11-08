import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  DOCUMENT_BLOCKS,
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
  patchBlock,
  scribeWorking,
  sectionEnd,
} from "./lib/document";
import {
  grantLease,
  loadForEdit,
  personChangeSet,
  refuseIfHeldByOther,
  refuseIfStale,
} from "./lib/leases";
import { blockKind } from "./schema";

// People edit the document one block at a time; lib/leases.ts holds the
// lease rules. Saves carry the block rev they were based on.

const LAPSED = "Your edit lock on this block has lapsed";

// Refuses unless the person holds an unexpired lease on the block.
const requireOwnLease = async (
  ctx: MutationCtx,
  block: Doc<"blocks">,
  participantId: Id<"participants">,
  now: number
) => {
  await refuseIfHeldByOther(ctx, block, participantId, now);
  if (leaseHolder(block, now) !== participantId) {
    throw new Error(LAPSED);
  }
};

export const startEdit = mutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    // Taking the block again while the lease is still yours renews it and keeps its change set.
    const kept =
      leaseHolder(block, now) === participant._id
        ? block.leaseChangeSetId
        : undefined;
    return await grantLease(ctx, block, participant._id, now, kept);
  },
});

export const renew = mutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await requireOwnLease(ctx, block, participant._id, now);
    return await grantLease(
      ctx,
      block,
      participant._id,
      now,
      block.leaseChangeSetId
    );
  },
});

// Ends the person's lease; their next edit of the block is a new change set.
export const stopEdit = mutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => {
    const block = await ctx.db.get(blockId);
    if (!block) {
      throw new Error("Unknown block");
    }
    const { participant } = await requireMember(ctx, block.roomId);
    if (block.leaseHolderParticipantId === participant._id) {
      await clearLease(ctx, blockId);
    }
  },
});

// Writes the block's text, taking the lease if it is free and renewing it.
// Refused when someone else holds the block or, given `baseRev`, when the
// block has changed since. The block keeps its author; a block someone else
// wrote is marked as edited by a human. Returns the block's rev.
export const save = mutation({
  args: {
    baseRev: v.optional(v.number()),
    blockId: v.id("blocks"),
    text: v.string(),
  },
  handler: async (ctx, { baseRev, blockId, text }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    if (baseRev !== undefined) {
      refuseIfStale(block, baseRev);
    }
    const problem = blockTextProblem(text);
    if (problem !== null) {
      throw new Error(problem);
    }
    // A lapsed lease of the person's own is retaken with a fresh change set.
    const kept =
      leaseHolder(block, now) === participant._id
        ? block.leaseChangeSetId
        : undefined;
    if (text === block.text) {
      await grantLease(ctx, block, participant._id, now, kept);
      return { rev: block.rev };
    }
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    await grantLease(ctx, block, participant._id, now, changeSetId);
    const ownBlock =
      block.author.kind === "participant" &&
      block.author.participantId === participant._id;
    const rev = await patchBlock(ctx, changeSetId, blockId, {
      text,
      ...(ownBlock ? {} : { humanEditedAt: now }),
    });
    return { rev };
  },
});

// Adds a block after another, at the end of a heading's section, or at the
// end of the document when neither is given. The person who adds it is its
// author and starts editing it, so the add and their typing form one change set.
export const add = mutation({
  args: {
    afterBlockId: v.optional(v.id("blocks")),
    endOfSectionId: v.optional(v.id("blocks")),
    kind: blockKind,
    roomId: v.id("rooms"),
    text: v.string(),
  },
  handler: async (
    ctx,
    { roomId, afterBlockId, endOfSectionId, kind, text }
  ) => {
    const { participant } = await requireMember(ctx, roomId);
    if (afterBlockId && endOfSectionId) {
      throw new Error("Choose one place for the new block");
    }
    const document = await getDocument(ctx, roomId);
    if (!document) {
      throw new Error("This room has no document yet");
    }
    const now = Date.now();
    if (scribeWorking(document, now)) {
      throw new Error(SCRIBE_WORKING);
    }
    const problem = blockTextProblem(text);
    if (problem !== null) {
      throw new Error(problem);
    }
    const blocks = await liveBlocks(ctx, document._id);
    if (blocks.length >= DOCUMENT_BLOCKS) {
      throw new Error(
        `The document holds at most ${DOCUMENT_BLOCKS} blocks. Merge or remove some first.`
      );
    }
    const anchorId = afterBlockId ?? endOfSectionId;
    let index = blocks.length - 1;
    if (anchorId) {
      index = blocks.findIndex((b) => b._id === anchorId);
      if (index < 0) {
        throw new Error("That block has been removed");
      }
      if (endOfSectionId) {
        index = sectionEnd(blocks, index);
      }
    }
    const order = orderBetween(
      blocks[index]?.order ?? null,
      blocks[index + 1]?.order ?? null
    );
    const changeSetId = await openChangeSet(ctx, document._id, {
      actorParticipantId: participant._id,
      kind: "human_edit",
    });
    const blockId = await insertBlock(ctx, changeSetId, {
      author: { kind: "participant", participantId: participant._id },
      kind,
      order,
      text,
    });
    await grantLease(
      ctx,
      { _id: blockId, roomId },
      participant._id,
      now,
      changeSetId
    );
    return blockId;
  },
});

export const remove = mutation({
  args: { blockId: v.id("blocks") },
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
  args: {
    blockId: v.id("blocks"),
    direction: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, { blockId, direction }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    const blocks = await liveBlocks(ctx, block.documentId);
    const index = blocks.findIndex((b) => b._id === blockId);
    const [before, after] =
      direction === "up"
        ? [blocks[index - 2], blocks[index - 1]]
        : [blocks[index + 1], blocks[index + 2]];
    const neighbour = direction === "up" ? after : before;
    if (!neighbour) {
      return;
    }
    const order = orderBetween(before?.order ?? null, after?.order ?? null);
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    await patchBlock(ctx, changeSetId, blockId, { order });
  },
});

// Scheduled for each lease's expiry when it is taken or renewed. A lease
// renewed since then has a later expiry and is left alone.
export const expireLease = internalMutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => {
    const block = await ctx.db.get(blockId);
    if (
      !block ||
      block.leaseExpiresAt === undefined ||
      block.leaseExpiresAt > Date.now()
    ) {
      return;
    }
    await clearLease(ctx, blockId);
  },
});
