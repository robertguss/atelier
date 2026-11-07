import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireRunnerSecret } from './lib/auth';
import {
  SCRIBE_WORKING,
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
import { authorLabel, isOwnBlock, participantNames } from './lib/documentDigest';
import { createThread, postComment } from './lib/threads';
import { canWriteDocument, documentMode } from './lib/visibility';
import { blockKind } from './schema';

// The room document tools a model turn calls through the runner. Each takes
// the runner secret and the turn, and Convex applies every rule itself: the
// author is the turn's participant, never an argument; the turn must be
// running under its claimed command; reviews never see the document and
// follow-ups only read it. A refused call returns a reason and a message the
// model can act on, rather than throwing. Model writes never take a lease:
// each is a compare-and-set against the block's rev that refuses while a
// person holds the block. Nothing here reads team chat.

export const MODEL_LIMITS = { blockWritesPerTurn: 20, commentsPerTurn: 10, blockChars: 4_000, documentBlocks: 600 };

type Reason =
  | 'turn_ended'
  | 'no_document_access'
  | 'read_only'
  | 'not_found'
  | 'not_your_block'
  | 'being_edited'
  | 'scribe_working'
  | 'stale'
  | 'human_edited'
  | 'cap_reached'
  | 'too_long'
  | 'empty'
  | 'document_full'
  | 'quote_not_found'
  | 'bad_request';

export type Refusal = {
  ok: false;
  reason: Reason;
  message: string;
  current?: { text: string; rev: number; changedBy: string };
};

function refuse(reason: Reason, message: string, current?: Refusal['current']): Refusal {
  return { ok: false, reason, message, ...(current ? { current } : {}) };
}

const NOT_FOUND = 'There is no such block in this room\'s document; it may have been removed. Call read_document for the current ids.';

type Loaded = { ok: true; turn: Doc<'turns'>; document: Doc<'documents'> };

// The turn behind a tool call, if it is running under its claimed run_turn
// command and may use the document as `need` asks.
async function loadTurn(ctx: QueryCtx, secret: string, turnId: Id<'turns'>, need: 'read' | 'write'): Promise<Loaded | Refusal> {
  requireRunnerSecret(secret);
  const turn = await ctx.db.get(turnId);
  const command = turn
    ? await ctx.db
        .query('commands')
        .withIndex('by_turn', (q) => q.eq('turnId', turnId))
        .filter((q) => q.eq(q.field('type'), 'run_turn'))
        .first()
    : null;
  if (!turn || turn.status !== 'running' || command?.status !== 'claimed') {
    return refuse('turn_ended', 'This turn is no longer running, so its document tools no longer work.');
  }
  if (documentMode(turn) === 'none') return refuse('no_document_access', 'An independent review works without the room document.');
  if (need === 'write' && !canWriteDocument(turn)) {
    return refuse('read_only', 'This turn follows up an independent review: it can read the room document but not change it.');
  }
  const document = await getDocument(ctx, turn.roomId);
  if (!document) return refuse('not_found', 'This room has no document yet.');
  return { ok: true, turn, document };
}

// As loadTurn, for a block write: also refuses while the scribe works and
// once the turn has used its block writes.
async function loadForWrite(ctx: MutationCtx, secret: string, turnId: Id<'turns'>) {
  const loaded = await loadTurn(ctx, secret, turnId, 'write');
  if (!loaded.ok) return loaded;
  if (scribeWorking(loaded.document, Date.now())) return refuse('scribe_working', `${SCRIBE_WORKING}. Try again after it finishes.`);
  const changeSet = await ctx.db.query('changeSets').withIndex('by_turn', (q) => q.eq('turnId', turnId)).first();
  if ((changeSet?.revisionCount ?? 0) >= MODEL_LIMITS.blockWritesPerTurn) {
    return refuse('cap_reached', `Turn cap reached: at most ${MODEL_LIMITS.blockWritesPerTurn} block writes per turn.`);
  }
  return loaded;
}

function checkText(text: string) {
  if (!text.trim()) return refuse('empty', 'A block needs some text. To remove a block, delete it.');
  if (text.length > MODEL_LIMITS.blockChars) {
    return refuse('too_long', `A block holds at most ${MODEL_LIMITS.blockChars} characters; this one has ${text.length}. Split it into several blocks.`);
  }
  return null;
}

// A live block of the turn's room, from an id the model passed.
async function roomBlock(ctx: QueryCtx, turn: Doc<'turns'>, rawId: string) {
  const blockId = ctx.db.normalizeId('blocks', rawId);
  const block = blockId ? await ctx.db.get(blockId) : null;
  return block && block.roomId === turn.roomId && block.deletedAt === undefined ? block : null;
}

// A block the turn's participant wrote and nobody is editing.
async function ownBlock(ctx: QueryCtx, turn: Doc<'turns'>, rawId: string): Promise<{ ok: true; block: Doc<'blocks'> } | Refusal> {
  const block = await roomBlock(ctx, turn, rawId);
  if (!block) return refuse('not_found', NOT_FOUND);
  if (!isOwnBlock(block, turn.participantId)) {
    const author = authorLabel(block.author, await participantNames(ctx, turn.roomId));
    return refuse('not_your_block', `This block is by ${author}, not you. You can only change blocks you wrote: comment on it instead.`);
  }
  const holder = leaseHolder(block, Date.now());
  if (holder) return refuse('being_edited', `${await participantName(ctx, holder)} is editing this block. Try again later, or comment on it.`);
  return { ok: true, block };
}

// The block changed since the model read it: its current text, and who made
// the latest change.
async function stale(ctx: QueryCtx, block: Doc<'blocks'>) {
  const latest = await ctx.db.query('blockRevisions').withIndex('by_block', (q) => q.eq('blockId', block._id)).order('desc').first();
  const changeSet = latest ? await ctx.db.get(latest.changeSetId) : null;
  const changedBy =
    changeSet?.kind === 'scribe_run'
      ? 'the scribe'
      : changeSet?.actorParticipantId
        ? await participantName(ctx, changeSet.actorParticipantId)
        : 'Someone';
  return refuse(
    'stale',
    `${changedBy} changed this block after the version you sent (it is now rev ${block.rev}). Here is its current text: build on it rather than undo their change.`,
    { text: block.text, rev: block.rev, changedBy },
  );
}

async function turnChangeSet(ctx: MutationCtx, { turn, document }: Loaded) {
  return await openChangeSet(ctx, document._id, { kind: 'model_turn', actorParticipantId: turn.participantId, turnId: turn._id });
}

export const readDocumentForTurn = query({
  args: { secret: v.string(), turnId: v.id('turns') },
  handler: async (ctx, { secret, turnId }) => {
    const loaded = await loadTurn(ctx, secret, turnId, 'read');
    if (!loaded.ok) return loaded;
    const { turn, document } = loaded;
    const names = await participantNames(ctx, turn.roomId);
    const blocks = await liveBlocks(ctx, document._id);
    const threads = [];
    for (const state of ['open', 'settled'] as const) {
      const rows = await ctx.db
        .query('threads')
        .withIndex('by_document_state', (q) => q.eq('documentId', document._id).eq('state', state))
        .collect();
      for (const thread of rows) {
        const comments = await ctx.db.query('comments').withIndex('by_thread', (q) => q.eq('threadId', thread._id)).collect();
        threads.push({
          id: thread._id,
          blockId: thread.blockId,
          state: thread.state,
          passage: thread.exact,
          detached: thread.detachedBeforeChangeSetId !== undefined,
          comments: comments.length,
        });
      }
    }
    return {
      ok: true as const,
      rev: document.rev,
      writable: canWriteDocument(turn),
      blocks: blocks.map((b) => ({
        id: b._id,
        kind: b.kind,
        text: b.text,
        author: authorLabel(b.author, names),
        yours: isOwnBlock(b, turn.participantId),
        rev: b.rev,
        humanEdited: b.humanEditedAt !== undefined,
      })),
      threads,
    };
  },
});

export const readThreadForTurn = query({
  args: { secret: v.string(), turnId: v.id('turns'), threadId: v.string() },
  handler: async (ctx, { secret, turnId, threadId }) => {
    const loaded = await loadTurn(ctx, secret, turnId, 'read');
    if (!loaded.ok) return loaded;
    const id = ctx.db.normalizeId('threads', threadId);
    const thread = id ? await ctx.db.get(id) : null;
    if (!thread || thread.roomId !== loaded.turn.roomId) return refuse('not_found', 'There is no such thread in this room\'s document.');
    const names = await participantNames(ctx, thread.roomId);
    const comments = await ctx.db.query('comments').withIndex('by_thread', (q) => q.eq('threadId', thread._id)).collect();
    return {
      ok: true as const,
      id: thread._id,
      blockId: thread.blockId,
      state: thread.state,
      passage: thread.exact,
      detached: thread.detachedBeforeChangeSetId !== undefined,
      comments: comments.map((c) => ({ author: names.get(c.authorParticipantId) ?? 'Someone', body: c.body, at: c._creationTime })),
    };
  },
});

// Adds a block after another, at the end of a heading's section, or at the
// end of the document when neither is given.
export const addBlockForTurn = mutation({
  args: {
    secret: v.string(),
    turnId: v.id('turns'),
    afterBlockId: v.optional(v.string()),
    endOfSectionId: v.optional(v.string()),
    kind: blockKind,
    text: v.string(),
  },
  handler: async (ctx, { secret, turnId, afterBlockId, endOfSectionId, kind, text }) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) return loaded;
    if (afterBlockId !== undefined && endOfSectionId !== undefined) return refuse('bad_request', 'Give either afterBlockId or endOfSectionId, not both.');
    const badText = checkText(text);
    if (badText) return badText;
    const blocks = await liveBlocks(ctx, loaded.document._id);
    if (blocks.length >= MODEL_LIMITS.documentBlocks) {
      return refuse('document_full', `The document holds at most ${MODEL_LIMITS.documentBlocks} blocks. Update one of your blocks instead.`);
    }
    const anchorId = afterBlockId ?? endOfSectionId;
    let index = blocks.length - 1;
    if (anchorId !== undefined) {
      const anchor = await roomBlock(ctx, loaded.turn, anchorId);
      index = anchor ? blocks.findIndex((b) => b._id === anchor._id) : -1;
      if (index < 0) return refuse('not_found', NOT_FOUND);
      if (endOfSectionId !== undefined) while (blocks[index + 1] && blocks[index + 1]!.kind !== 'heading') index++;
    }
    const order = orderBetween(blocks[index]?.order ?? null, blocks[index + 1]?.order ?? null);
    const changeSetId = await turnChangeSet(ctx, loaded);
    const blockId = await insertBlock(ctx, changeSetId, { order, kind, text, author: { kind: 'participant', participantId: loaded.turn.participantId } });
    return { ok: true as const, blockId, rev: (await ctx.db.get(blockId))!.rev };
  },
});

// Replaces the text of a block the model wrote, if it is still at `baseRev`.
export const updateBlockForTurn = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), blockId: v.string(), baseRev: v.number(), text: v.string() },
  handler: async (ctx, { secret, turnId, blockId, baseRev, text }) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) return loaded;
    const badText = checkText(text);
    if (badText) return badText;
    const own = await ownBlock(ctx, loaded.turn, blockId);
    if (!own.ok) return own;
    const { block } = own;
    if (block.rev !== baseRev) return await stale(ctx, block);
    if (text === block.text) return { ok: true as const, rev: block.rev };
    await patchBlock(ctx, await turnChangeSet(ctx, loaded), block._id, { text });
    return { ok: true as const, rev: (await ctx.db.get(block._id))!.rev };
  },
});

// Deletes a block the model wrote, if it is still at `baseRev` and no person
// has edited it.
export const deleteBlockForTurn = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), blockId: v.string(), baseRev: v.number() },
  handler: async (ctx, { secret, turnId, blockId, baseRev }) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) return loaded;
    const own = await ownBlock(ctx, loaded.turn, blockId);
    if (!own.ok) return own;
    const { block } = own;
    if (block.humanEditedAt !== undefined) {
      return refuse('human_edited', 'A person has edited this block, so you cannot delete it. Comment on it instead if you think it should go.');
    }
    if (block.rev !== baseRev) return await stale(ctx, block);
    await deleteBlock(ctx, await turnChangeSet(ctx, loaded), block._id);
    return { ok: true as const };
  },
});

// Starts a comment thread on the passage `quote` of any block. Comments keep
// working while the scribe works. A model's comment summons no one.
export const commentForTurn = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), blockId: v.string(), quote: v.string(), body: v.string() },
  handler: async (ctx, { secret, turnId, blockId, quote, body }) => {
    const loaded = await loadTurn(ctx, secret, turnId, 'write');
    if (!loaded.ok) return loaded;
    const { turn } = loaded;
    const written = await ctx.db.query('comments').withIndex('by_turn', (q) => q.eq('turnId', turnId)).take(MODEL_LIMITS.commentsPerTurn);
    if (written.length >= MODEL_LIMITS.commentsPerTurn) {
      return refuse('cap_reached', `Turn cap reached: at most ${MODEL_LIMITS.commentsPerTurn} comments per turn.`);
    }
    const text = body.trim();
    if (!text) return refuse('empty', 'A comment needs some text.');
    if (text.length > MODEL_LIMITS.blockChars) return refuse('too_long', `A comment holds at most ${MODEL_LIMITS.blockChars} characters.`);
    const block = await roomBlock(ctx, turn, blockId);
    if (!block) return refuse('not_found', NOT_FOUND);
    const start = quote ? block.text.indexOf(quote) : -1;
    if (start < 0) return refuse('quote_not_found', 'That passage is not in the block\'s text. Quote it exactly as it appears in the block.');
    const thread = await createThread(ctx, block, start, start + quote.length);
    const author = (await ctx.db.get(turn.participantId))!;
    const commentId = await postComment(ctx, thread, author, text, turn._id);
    return { ok: true as const, threadId: thread._id, commentId };
  },
});
