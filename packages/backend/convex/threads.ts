import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import { runnerOnline } from "./lib/dispatch";
import { getDocument } from "./lib/document";
import { record } from "./lib/ledger";
import { required } from "./lib/required";
import { createThread, postComment } from "./lib/threads";

// Comment threads on the room document, for the people in the room. Saving
// a comment never needs the runner. Only a person can settle or reopen a
// thread: these functions take a signed-in member, and no runner function
// changes a thread's state.

const commentBody = (body: string) => {
  const text = body.trim();
  if (!text) {
    throw new Error("Empty comment");
  }
  return text;
};

const loadThread = async (ctx: QueryCtx, threadId: Id<"threads">) => {
  const thread = await ctx.db.get(threadId);
  if (!thread) {
    throw new Error("Unknown thread");
  }
  const member = await requireMember(ctx, thread.roomId);
  return { thread, ...member };
};

// Starts a thread on the passage [start, end) of the block's stored text,
// measured in JavaScript string indices. The server builds the anchor.
export const create = mutation({
  args: {
    blockId: v.id("blocks"),
    body: v.string(),
    end: v.number(),
    start: v.number(),
  },
  handler: async (ctx, { blockId, start, end, body }) => {
    const block = await ctx.db.get(blockId);
    if (!block) {
      throw new Error("Unknown block");
    }
    const { participant } = await requireMember(ctx, block.roomId);
    const text = commentBody(body);
    const thread = await createThread(ctx, block, start, end);
    await postComment(ctx, thread, participant, text);
    return thread._id;
  },
});

export const reply = mutation({
  args: { body: v.string(), threadId: v.id("threads") },
  handler: async (ctx, { threadId, body }) => {
    const { thread, participant } = await loadThread(ctx, threadId);
    return await postComment(ctx, thread, participant, commentBody(body));
  },
});

const setState = async (
  ctx: MutationCtx,
  threadId: Id<"threads">,
  state: Doc<"threads">["state"]
) => {
  const { thread, participant } = await loadThread(ctx, threadId);
  if (thread.state === state) {
    return;
  }
  await ctx.db.patch(threadId, { state });
  await record(ctx, {
    actorParticipantId: participant._id,
    payload: { threadId },
    roomId: thread.roomId,
    subjectId: threadId,
    type:
      state === "settled"
        ? "document.thread_settled"
        : "document.thread_reopened",
  });
};

export const settle = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await setState(ctx, threadId, "settled");
  },
});

export const reopen = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await setState(ctx, threadId, "open");
  },
});

// Where each mention stands, for the thread card.
const mentionState = async (
  ctx: QueryCtx,
  delivery: Doc<"messages">,
  online: boolean
) => {
  if (delivery.delivery === "queued") {
    return online ? "waiting" : "waitingForRunner";
  }
  if (delivery.delivery === "cancelled") {
    return "cancelled";
  }
  const turn = delivery.deliveredTurnId
    ? await ctx.db.get(delivery.deliveredTurnId)
    : null;
  if (!turn) {
    return "failed";
  }
  if (turn.status === "queued" || turn.status === "running") {
    return "answering";
  }
  return turn.status === "done" ? "replied" : "failed";
};

// Every thread in the room's document with its comments in order, open ones
// and settled ones apart. A detached thread names the change set that removed
// its passage; history.versionBefore opens the version just before it.
export const list = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    await requireMember(ctx, roomId);
    const document = await getDocument(ctx, roomId);
    if (!document) {
      return { open: [], settled: [] };
    }
    const room = required(await ctx.db.get(roomId), "room");
    const online = runnerOnline(await ctx.db.get(room.runnerId));
    const load = async (state: Doc<"threads">["state"]) => {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_document_state", (q) =>
          q.eq("documentId", document._id).eq("state", state)
        )
        .collect();
      return await Promise.all(
        threads.map(async (t) => {
          const comments = await ctx.db
            .query("comments")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id))
            .collect();
          return {
            _id: t._id,
            blockId: t.blockId,
            comments: await Promise.all(
              comments.map(async (c) => {
                const deliveries = await ctx.db
                  .query("messages")
                  .withIndex("by_comment", (q) => q.eq("commentId", c._id))
                  .collect();
                return {
                  _id: c._id,
                  at: c._creationTime,
                  authorParticipantId: c.authorParticipantId,
                  body: c.body,
                  mentions: await Promise.all(
                    deliveries.map(async (d) => ({
                      participantId: required(d.toParticipantId, "recipient"),
                      state: await mentionState(ctx, d, online),
                    }))
                  ),
                };
              })
            ),
            detachedBeforeChangeSetId: t.detachedBeforeChangeSetId ?? null,
            exact: t.exact,
            position: t.position,
            prefix: t.prefix,
            state: t.state,
            suffix: t.suffix,
          };
        })
      );
    };
    return { open: await load("open"), settled: await load("settled") };
  },
});
