import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  SCRIBE_WORKING,
  anyLeaseHolder,
  deleteBlock,
  getDocument,
  openChangeSet,
  participantName,
  patchBlock,
  reviveBlock,
  scribeWorking,
  takeCheckpoint,
  versionAt,
} from "./lib/document";
import { record } from "./lib/ledger";
import { required } from "./lib/required";

// A document's history is its change sets. Each is one version: a model
// turn's writes, one person's edit session on a block, a scribe run, a
// restore or the template seeding.

const sameAuthor = (a: Doc<"blocks">["author"], b: Doc<"blocks">["author"]) => {
  if (a.kind !== b.kind || a.participantId !== b.participantId) {
    return false;
  }
  return (
    a.kind === "participant" ||
    (b.kind === "scribe" && a.credits.join(",") === b.credits.join(","))
  );
};

const loadChangeSet = async (ctx: QueryCtx, changeSetId: Id<"changeSets">) => {
  const changeSet = await ctx.db.get(changeSetId);
  if (!changeSet) {
    throw new Error("Unknown version");
  }
  const member = await requireMember(ctx, changeSet.roomId);
  return { changeSet, ...member };
};

// Change sets, newest first. A scribe run's also names the model that acted
// as scribe and the person who called it in.
export const list = query({
  args: { paginationOpts: paginationOptsValidator, roomId: v.id("rooms") },
  handler: async (ctx, { roomId, paginationOpts }) => {
    await requireMember(ctx, roomId);
    const document = await getDocument(ctx, roomId);
    if (!document) {
      return { continueCursor: "", isDone: true, page: [] };
    }
    const result = await ctx.db
      .query("changeSets")
      .withIndex("by_document", (q) => q.eq("documentId", document._id))
      .order("desc")
      .paginate(paginationOpts);
    // A scribe run is the model that acted as scribe and the person who called it in.
    const page = await Promise.all(
      result.page.map(async (c) => {
        const run = c.scribeRunId ? await ctx.db.get(c.scribeRunId) : null;
        return {
          _id: c._id,
          actorParticipantId: c.actorParticipantId,
          at: c.at,
          kind: c.kind,
          revisionCount: c.revisionCount,
          scribeParticipantId: run?.participantId,
          scribeStartedByParticipantId: run?.startedByParticipantId,
        };
      })
    );
    return { ...result, page };
  },
});

// The document as it stood once this change set's last revision was written.
export const version = query({
  args: { changeSetId: v.id("changeSets") },
  handler: async (ctx, { changeSetId }) => {
    const { changeSet } = await loadChangeSet(ctx, changeSetId);
    return {
      blocks: await versionAt(ctx, changeSet.documentId, changeSet.lastRev),
      changeSetId,
      rev: changeSet.lastRev,
    };
  },
});

// The document as it stood just before this change set's first revision. A
// thread detached by a change set links here, to its original passage.
export const versionBefore = query({
  args: { changeSetId: v.id("changeSets") },
  handler: async (ctx, { changeSetId }) => {
    const { changeSet } = await loadChangeSet(ctx, changeSetId);
    const first = await ctx.db
      .query("blockRevisions")
      .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSetId))
      .first();
    const rev = (first?.rev ?? changeSet.lastRev + 1) - 1;
    return {
      blocks: await versionAt(ctx, changeSet.documentId, rev),
      changeSetId,
      rev,
    };
  },
});

// What one change set changed, in order.
export const diff = query({
  args: { changeSetId: v.id("changeSets") },
  handler: async (ctx, { changeSetId }) => {
    await loadChangeSet(ctx, changeSetId);
    const revisions = await ctx.db
      .query("blockRevisions")
      .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSetId))
      .collect();
    return revisions
      .toSorted((a, b) => a.rev - b.rev)
      .map(({ blockId, rev, op, before, after }) => ({
        after,
        before,
        blockId,
        op,
        rev,
      }));
  },
});

// Brings one block to its state in the chosen version, or deletes it if the
// version had no such block.
const restoreRow = async (
  ctx: MutationCtx,
  {
    now,
    participantId,
    restoreId,
    row,
    wanted,
  }: {
    now: number;
    participantId: Id<"participants">;
    restoreId: Id<"changeSets">;
    row: Doc<"blocks">;
    wanted: Awaited<ReturnType<typeof versionAt>>[number] | undefined;
  }
) => {
  if (!wanted) {
    if (row.deletedAt === undefined) {
      await deleteBlock(ctx, restoreId, row._id);
    }
    return;
  }
  const { order, kind, text, author, checked } = wanted;
  const state = { author, checked, kind, order, text };
  const ownBlock =
    author.kind === "participant" && author.participantId === participantId;
  const edited = ownBlock ? {} : { humanEditedAt: now };
  if (row.deletedAt !== undefined) {
    await reviveBlock(ctx, restoreId, row._id, state, edited);
  } else if (
    row.order !== order ||
    row.kind !== kind ||
    row.text !== text ||
    row.checked !== checked ||
    !sameAuthor(row.author, author)
  ) {
    await patchBlock(ctx, restoreId, row._id, {
      ...state,
      ...(row.text === text ? {} : edited),
    });
  }
};

// Returns every block to its text, kind, place and author in the chosen
// version, keeping block ids: blocks deleted since come back, blocks added
// since are deleted. The current state is checkpointed first, so nothing is
// lost, and the whole restore is one change set by the person.
export const restore = mutation({
  args: { changeSetId: v.id("changeSets") },
  handler: async (ctx, { changeSetId }) => {
    const { changeSet, participant } = await loadChangeSet(ctx, changeSetId);
    const document = required(
      await ctx.db.get(changeSet.documentId),
      "document"
    );
    const now = Date.now();
    if (scribeWorking(document, now)) {
      throw new Error(SCRIBE_WORKING);
    }
    const rows = await ctx.db
      .query("blocks")
      .withIndex("by_document_order", (q) => q.eq("documentId", document._id))
      .collect();
    const holder = anyLeaseHolder(rows, now);
    if (holder !== undefined) {
      throw new Error(
        `${await participantName(ctx, holder)} is editing a block`
      );
    }

    const atVersion = await versionAt(ctx, document._id, changeSet.lastRev);
    const target = new Map(atVersion.map((b) => [b.blockId, b]));
    await takeCheckpoint(ctx, document._id, "before_restore");
    const restoreId = await openChangeSet(ctx, document._id, {
      actorParticipantId: participant._id,
      kind: "restore",
    });
    // Every write below goes through the shared block write path, so whatever
    // follows a block's text there also follows a restore.
    for (const row of rows) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
      await restoreRow(ctx, {
        now,
        participantId: participant._id,
        restoreId,
        row,
        wanted: target.get(row._id),
      });
    }
    await record(ctx, {
      actorParticipantId: participant._id,
      payload: {
        changeSetId: restoreId,
        documentId: document._id,
        restoredChangeSetId: changeSetId,
      },
      roomId: document.roomId,
      subjectId: restoreId,
      type: "document.restored",
    });
    return restoreId;
  },
});
