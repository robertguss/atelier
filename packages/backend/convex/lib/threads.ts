import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { matchQuote, selectorAt } from "./anchor";
import type { Selector } from "./anchor";
import { dispatchNext } from "./dispatch";
import { record } from "./ledger";
import { required } from "./required";

// Comment threads on the room document. Only a person's comment can bring a
// model in: each @mention of a model participant queues one thread delivery
// for it. A model's comment, including its reply in a thread, mentions no one,
// so models cannot summon each other.

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// The room's model participants that `body` @mentions by display name.
export const mentionedModels = async (
  ctx: QueryCtx,
  roomId: Id<"rooms">,
  body: string
) => {
  const participants = await ctx.db
    .query("participants")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  return participants
    .filter((p) => p.kind === "harness")
    .filter((p) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}_@])@${escapeRegExp(p.displayName)}(?![\\p{L}\\p{N}_])`,
        "iu"
      ).test(body)
    )
    .map((p) => p._id);
};

// Adds a comment to a thread. A person's comment queues a delivery for each
// model it mentions and starts any that is idle; it is saved whether or not
// the runner is online.
export const postComment = async (
  ctx: MutationCtx,
  thread: Doc<"threads">,
  author: Doc<"participants">,
  body: string,
  turnId?: Id<"turns">
) => {
  const mentions =
    author.kind === "human"
      ? await mentionedModels(ctx, thread.roomId, body)
      : [];
  const commentId = await ctx.db.insert("comments", {
    authorParticipantId: author._id,
    body,
    mentions,
    roomId: thread.roomId,
    threadId: thread._id,
    turnId,
  });
  await record(ctx, {
    actorParticipantId: author._id,
    payload: { commentId, mentions, threadId: thread._id },
    roomId: thread.roomId,
    subjectId: commentId,
    type: "document.comment_posted",
  });
  await Promise.all(
    mentions.map(async (participantId) => {
      await ctx.db.insert("messages", {
        authorParticipantId: author._id,
        body,
        commentId,
        delivery: "queued",
        roomId: thread.roomId,
        threadId: thread._id,
        toParticipantId: participantId,
        visibility: "room",
      });
      await dispatchNext(ctx, participantId);
    })
  );
  return commentId;
};

// Starts a thread on the passage [start, end) of the block's text.
export const createThread = async (
  ctx: MutationCtx,
  block: Doc<"blocks">,
  start: number,
  end: number
) => {
  if (block.deletedAt !== undefined) {
    throw new Error("This block has been removed");
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > block.text.length
  ) {
    throw new Error("Select a passage in the block to comment on");
  }
  const threadId = await ctx.db.insert("threads", {
    blockId: block._id,
    documentId: block.documentId,
    roomId: block.roomId,
    ...selectorAt(block.text, start, end),
    state: "open",
  });
  return required(await ctx.db.get(threadId), "thread");
};

const threadsOn = async (ctx: QueryCtx, blockId: Id<"blocks">) =>
  await ctx.db
    .query("threads")
    .withIndex("by_block", (q) => q.eq("blockId", blockId))
    .collect();

// Finds each thread's passage again in the block's new text, in the same
// write as the change. A found passage gets fresh selectors, and a thread
// detached earlier re-attaches; a lost one is detached by this change set,
// unless an earlier change already detached it.
export const reanchorThreads = async (
  ctx: MutationCtx,
  blockId: Id<"blocks">,
  text: string,
  changeSetId: Id<"changeSets">
) => {
  const threads = await threadsOn(ctx, blockId);
  await Promise.all(
    threads.map(async (thread) => {
      const match = matchQuote(text, thread);
      if (match) {
        await ctx.db.patch(thread._id, {
          ...selectorAt(text, match.start, match.end),
          detachedBeforeChangeSetId: undefined,
        });
      } else if (thread.detachedBeforeChangeSetId === undefined) {
        await ctx.db.patch(thread._id, {
          detachedBeforeChangeSetId: changeSetId,
        });
      }
    })
  );
};

// The block was deleted: its threads are detached by this change set.
export const detachThreads = async (
  ctx: MutationCtx,
  blockId: Id<"blocks">,
  changeSetId: Id<"changeSets">
) => {
  const threads = await threadsOn(ctx, blockId);
  await Promise.all(
    threads
      .filter((thread) => thread.detachedBeforeChangeSetId === undefined)
      .map(async (thread) => {
        await ctx.db.patch(thread._id, {
          detachedBeforeChangeSetId: changeSetId,
        });
      })
  );
};

// The block's open threads that are still attached to their passage.
export const attachedThreadsOn = async (
  ctx: QueryCtx,
  blockId: Id<"blocks">
) => {
  const threads = await threadsOn(ctx, blockId);
  return threads.filter(
    (thread) =>
      thread.state === "open" && thread.detachedBeforeChangeSetId === undefined
  );
};

// A block text a thread's passage may have moved into. `shift` maps the
// passage's old position into this text, when the caller knows it.
export interface ThreadHome {
  text: string;
  shift?: number;
}

// The candidate whose text holds the passage best, with fresh selectors for
// it there, or null when none holds it.
export const bestHome = <H extends ThreadHome>(
  selector: Selector,
  candidates: H[]
) => {
  let best: { home: H; start: number; end: number; score: number } | null =
    null;
  for (const home of candidates) {
    const match = matchQuote(home.text, {
      ...selector,
      position: selector.position + (home.shift ?? 0),
    });
    if (match && (!best || match.score > best.score)) {
      best = { home, ...match };
    }
  }
  return (
    best && {
      home: best.home,
      selector: selectorAt(best.home.text, best.start, best.end),
    }
  );
};

// Moves each thread onto the candidate block that holds its passage best, or
// detaches it by this change set when none does. Used when a change splits,
// joins or rewrites blocks, so a passage may now live in another block.
export const rehomeThreads = async (
  ctx: MutationCtx,
  threads: Doc<"threads">[],
  candidates: (ThreadHome & { blockId: Id<"blocks"> })[],
  changeSetId: Id<"changeSets">
) => {
  await Promise.all(
    threads.map(async (thread) => {
      const found = bestHome(thread, candidates);
      await ctx.db.patch(
        thread._id,
        found
          ? {
              blockId: found.home.blockId,
              ...found.selector,
              detachedBeforeChangeSetId: undefined,
            }
          : { detachedBeforeChangeSetId: changeSetId }
      );
    })
  );
};
