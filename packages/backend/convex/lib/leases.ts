import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireMember } from "./auth";
import {
  LEASE_MS,
  SCRIBE_WORKING,
  leaseHolder,
  openChangeSet,
  participantName,
  releaseLeasesOf,
  scribeWorking,
} from "./document";
import { required } from "./required";

// People edit the document one block at a time. A person's first change to a
// block takes a lease on it; editing renews it, and it lapses LEASE_MS after
// the last renewal. A person holds at most one lease per document, and
// everything they write under one lease forms one change set.

// The block and the member acting on it, refusing while the scribe works.
export const loadForEdit = async (ctx: MutationCtx, blockId: Id<"blocks">) => {
  const block = await ctx.db.get(blockId);
  if (!block) {
    throw new Error("Unknown block");
  }
  const { participant } = await requireMember(ctx, block.roomId);
  if (block.deletedAt !== undefined) {
    throw new Error("This block has been removed");
  }
  const now = Date.now();
  const document = required(await ctx.db.get(block.documentId), "document");
  if (scribeWorking(document, now)) {
    throw new Error(SCRIBE_WORKING);
  }
  return { block, now, participant };
};

// Refuses when someone else holds an unexpired lease on the block.
export const refuseIfHeldByOther = async (
  ctx: MutationCtx,
  block: Doc<"blocks">,
  participantId: Id<"participants">,
  now: number
) => {
  const holder = leaseHolder(block, now);
  if (holder && holder !== participantId) {
    throw new Error(
      `${await participantName(ctx, holder)} is editing this block`
    );
  }
};

// Refuses a write based on an older rev than the block's, with what the block
// holds now so the writer can keep their text as a draft.
export const refuseIfStale = (block: Doc<"blocks">, baseRev: number) => {
  if (block.rev !== baseRev) {
    throw new ConvexError({
      checked: block.checked,
      message: "This block changed since you last saw it",
      rev: block.rev,
      text: block.text,
    });
  }
};

// Every lease is granted here, so taking one releases the person's others.
export const grantLease = async (
  ctx: MutationCtx,
  block: Pick<Doc<"blocks">, "_id" | "roomId">,
  participantId: Id<"participants">,
  now: number,
  leaseChangeSetId?: Id<"changeSets">
) => {
  await releaseLeasesOf(ctx, block.roomId, participantId, block._id);
  const expiresAt = now + LEASE_MS;
  await ctx.db.patch(block._id, {
    leaseChangeSetId,
    leaseExpiresAt: expiresAt,
    leaseHolderParticipantId: participantId,
  });
  await ctx.scheduler.runAt(expiresAt, internal.blocks.expireLease, {
    blockId: block._id,
  });
  return { expiresAt };
};

// The change set a person's write to the block joins: their lease's, opened
// on its first write, or a new one when they hold no lease on it.
export const personChangeSet = async (
  ctx: MutationCtx,
  block: Doc<"blocks">,
  participantId: Id<"participants">,
  now: number
) => {
  const holdsLease = leaseHolder(block, now) === participantId;
  if (holdsLease && block.leaseChangeSetId) {
    return block.leaseChangeSetId;
  }
  const changeSetId = await openChangeSet(ctx, block.documentId, {
    actorParticipantId: participantId,
    kind: "human_edit",
  });
  if (holdsLease) {
    await ctx.db.patch(block._id, { leaseChangeSetId: changeSetId });
  }
  return changeSetId;
};

// Who holds an unexpired lease they have written under on any live block, if
// anyone. A lease with no write yet is only a caret and blocks no one.
export const writingLeaseHolder = (blocks: Doc<"blocks">[], now: number) =>
  blocks
    .filter(
      (block) =>
        block.deletedAt === undefined && block.leaseChangeSetId !== undefined
    )
    .map((block) => leaseHolder(block, now))
    .find((holder) => holder !== undefined);
