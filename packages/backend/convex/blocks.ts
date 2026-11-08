import { v } from "convex/values";

import { internalMutation, mutation } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  blockTextProblem,
  clearLease,
  deleteBlock,
  insertBlock,
  leaseHolder,
  liveBlocks,
  patchBlock,
} from "./lib/document";
import {
  grantLease,
  humanEdit,
  loadForEdit,
  personChangeSet,
  refuseIfHeldByOther,
  refuseIfStale,
} from "./lib/leases";

// People edit the document one block at a time; lib/leases.ts holds the
// lease rules. Saves carry the block rev they were based on.

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
// Refused when someone else holds the block or when the block has changed
// since `baseRev`. The block keeps its author; a block someone else
// wrote is marked as edited by a human. Returns the block's rev.
export const save = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.id("blocks"),
    text: v.string(),
  },
  handler: async (ctx, { baseRev, blockId, text }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    refuseIfStale(block, baseRev);
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
    const rev = await patchBlock(ctx, changeSetId, blockId, {
      text,
      ...humanEdit(block, participant._id, now),
    });
    return { rev };
  },
});

export const remove = mutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => {
    const { block, participant, now } = await loadForEdit(ctx, blockId);
    await refuseIfHeldByOther(ctx, block, participant._id, now);
    const changeSetId = await personChangeSet(ctx, block, participant._id, now);
    const live = await liveBlocks(ctx, block.documentId);
    const last = live.length === 1;
    await deleteBlock(ctx, changeSetId, blockId);
    await clearLease(ctx, blockId);
    // A document always keeps a block to type in.
    if (last) {
      await insertBlock(ctx, changeSetId, {
        author: { kind: "participant", participantId: participant._id },
        kind: "paragraph",
        order: block.order,
        text: "",
      });
    }
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
