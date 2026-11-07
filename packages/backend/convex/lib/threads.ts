import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { matchQuote, selectorAt } from './anchor';
import { dispatchNext } from './dispatch';
import { record } from './ledger';

// Comment threads on the room document. Only a person's comment can bring a
// model in: each @mention of a model participant queues one thread delivery
// for it. A model's comment, including its reply in a thread, mentions no one,
// so models cannot summon each other.

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The room's model participants that `body` @mentions by display name.
export async function mentionedModels(ctx: QueryCtx, roomId: Id<'rooms'>, body: string) {
  const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
  return participants
    .filter((p) => p.kind === 'harness')
    .filter((p) => new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRegExp(p.displayName)}(?![\\p{L}\\p{N}_])`, 'iu').test(body))
    .map((p) => p._id);
}

// Adds a comment to a thread. A person's comment queues a delivery for each
// model it mentions and starts any that is idle; it is saved whether or not
// the runner is online.
export async function postComment(
  ctx: MutationCtx,
  thread: Doc<'threads'>,
  author: Doc<'participants'>,
  body: string,
  turnId?: Id<'turns'>,
) {
  const mentions = author.kind === 'human' ? await mentionedModels(ctx, thread.roomId, body) : [];
  const commentId = await ctx.db.insert('comments', {
    threadId: thread._id,
    roomId: thread.roomId,
    authorParticipantId: author._id,
    body,
    mentions,
    turnId,
  });
  await record(ctx, {
    roomId: thread.roomId,
    type: 'document.comment_posted',
    actorParticipantId: author._id,
    subjectId: commentId,
    payload: { threadId: thread._id, commentId, mentions },
  });
  for (const participantId of mentions) {
    await ctx.db.insert('messages', {
      roomId: thread.roomId,
      authorParticipantId: author._id,
      body,
      visibility: 'room',
      toParticipantId: participantId,
      delivery: 'queued',
      threadId: thread._id,
      commentId,
    });
    await dispatchNext(ctx, participantId);
  }
  return commentId;
}

// Starts a thread on the passage [start, end) of the block's text.
export async function createThread(ctx: MutationCtx, block: Doc<'blocks'>, start: number, end: number) {
  if (block.deletedAt !== undefined) throw new Error('This block has been removed');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > block.text.length) {
    throw new Error('Select a passage in the block to comment on');
  }
  const threadId = await ctx.db.insert('threads', {
    documentId: block.documentId,
    roomId: block.roomId,
    blockId: block._id,
    ...selectorAt(block.text, start, end),
    state: 'open',
  });
  return (await ctx.db.get(threadId))!;
}

// Finds each thread's passage again in the block's new text, in the same
// write as the change. A found passage gets fresh selectors, and a thread
// detached earlier re-attaches; a lost one is detached by this change set,
// unless an earlier change already detached it.
export async function reanchorThreads(ctx: MutationCtx, blockId: Id<'blocks'>, text: string, changeSetId: Id<'changeSets'>) {
  for (const thread of await threadsOn(ctx, blockId)) {
    const match = matchQuote(text, thread);
    if (match) {
      await ctx.db.patch(thread._id, { ...selectorAt(text, match.start, match.end), detachedBeforeChangeSetId: undefined });
    } else if (!thread.detachedBeforeChangeSetId) {
      await ctx.db.patch(thread._id, { detachedBeforeChangeSetId: changeSetId });
    }
  }
}

// The block was deleted: its threads are detached by this change set.
export async function detachThreads(ctx: MutationCtx, blockId: Id<'blocks'>, changeSetId: Id<'changeSets'>) {
  for (const thread of await threadsOn(ctx, blockId)) {
    if (!thread.detachedBeforeChangeSetId) await ctx.db.patch(thread._id, { detachedBeforeChangeSetId: changeSetId });
  }
}

async function threadsOn(ctx: QueryCtx, blockId: Id<'blocks'>) {
  return await ctx.db.query('threads').withIndex('by_block', (q) => q.eq('blockId', blockId)).collect();
}
