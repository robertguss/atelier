import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./lib/auth";
import { ensureDocument, getDocument, liveBlocks } from "./lib/document";

// The room's document for its members: blocks in order, each with its author,
// lease holder and number of open threads. Null until the document is seeded.
export const get = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    await requireMember(ctx, roomId);
    const document = await getDocument(ctx, roomId);
    if (!document) {
      return null;
    }
    const blocks = await liveBlocks(ctx, document._id);
    const open = await ctx.db
      .query("threads")
      .withIndex("by_document_state", (q) =>
        q.eq("documentId", document._id).eq("state", "open")
      )
      .collect();
    const openThreads = new Map<Id<"blocks">, number>();
    for (const thread of open) {
      openThreads.set(
        thread.blockId,
        (openThreads.get(thread.blockId) ?? 0) + 1
      );
    }
    return {
      blocks: blocks.map((b) => ({
        _id: b._id,
        author: b.author,
        checked: b.checked,
        humanEditedAt: b.humanEditedAt,
        kind: b.kind,
        leaseExpiresAt: b.leaseExpiresAt,
        leaseHolderParticipantId: b.leaseHolderParticipantId,
        openThreads: openThreads.get(b._id) ?? 0,
        order: b.order,
        rev: b.rev,
        text: b.text,
      })),
      documentId: document._id,
      rev: document.rev,
      scribeLockExpiresAt: document.scribeLockExpiresAt,
      scribeRunId: document.scribeRunId,
    };
  },
});

// Seeds the default template for a room created before documents existed.
// Safe to call any number of times.
export const ensure = mutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    await requireMember(ctx, roomId);
    return await ensureDocument(ctx, roomId);
  },
});
