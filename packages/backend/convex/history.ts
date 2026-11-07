import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireMember } from './lib/auth';
import {
  SCRIBE_WORKING,
  deleteBlock,
  getDocument,
  leaseHolder,
  openChangeSet,
  participantName,
  patchBlock,
  reviveBlock,
  scribeWorking,
  takeCheckpoint,
  versionAt,
} from './lib/document';
import { record } from './lib/ledger';

// A document's history is its change sets. Each is one version: a model
// turn's writes, one person's edit session on a block, a scribe run, a
// restore or the template seeding.

function sameAuthor(a: Doc<'blocks'>['author'], b: Doc<'blocks'>['author']) {
  if (a.kind !== b.kind || a.participantId !== b.participantId) return false;
  return a.kind === 'participant' || (b.kind === 'scribe' && a.credits.join() === b.credits.join());
}

async function loadChangeSet(ctx: QueryCtx, changeSetId: Id<'changeSets'>) {
  const changeSet = await ctx.db.get(changeSetId);
  if (!changeSet) throw new Error('Unknown version');
  const member = await requireMember(ctx, changeSet.roomId);
  return { changeSet, ...member };
}

// Change sets, newest first.
export const list = query({
  args: { roomId: v.id('rooms'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { roomId, paginationOpts }) => {
    await requireMember(ctx, roomId);
    const document = await getDocument(ctx, roomId);
    if (!document) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('changeSets')
      .withIndex('by_document', (q) => q.eq('documentId', document._id))
      .order('desc')
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((c) => ({
        _id: c._id,
        kind: c.kind,
        actorParticipantId: c.actorParticipantId,
        at: c.at,
        revisionCount: c.revisionCount,
      })),
    };
  },
});

// The document as it stood once this change set's last revision was written.
export const version = query({
  args: { changeSetId: v.id('changeSets') },
  handler: async (ctx, { changeSetId }) => {
    const { changeSet } = await loadChangeSet(ctx, changeSetId);
    return { changeSetId, rev: changeSet.lastRev, blocks: await versionAt(ctx, changeSet.documentId, changeSet.lastRev) };
  },
});

// What one change set changed, in order.
export const diff = query({
  args: { changeSetId: v.id('changeSets') },
  handler: async (ctx, { changeSetId }) => {
    await loadChangeSet(ctx, changeSetId);
    const revisions = await ctx.db
      .query('blockRevisions')
      .withIndex('by_change_set', (q) => q.eq('changeSetId', changeSetId))
      .collect();
    return revisions
      .sort((a, b) => a.rev - b.rev)
      .map(({ blockId, rev, op, before, after }) => ({ blockId, rev, op, before, after }));
  },
});

// Returns every block to its text, kind, place and author in the chosen
// version, keeping block ids: blocks deleted since come back, blocks added
// since are deleted. The current state is checkpointed first, so nothing is
// lost, and the whole restore is one change set by the person.
export const restore = mutation({
  args: { changeSetId: v.id('changeSets') },
  handler: async (ctx, { changeSetId }) => {
    const { changeSet, participant } = await loadChangeSet(ctx, changeSetId);
    const document = (await ctx.db.get(changeSet.documentId))!;
    const now = Date.now();
    if (scribeWorking(document, now)) throw new Error(SCRIBE_WORKING);
    const rows = await ctx.db
      .query('blocks')
      .withIndex('by_document_order', (q) => q.eq('documentId', document._id))
      .collect();
    for (const row of rows) {
      const holder = row.deletedAt === undefined ? leaseHolder(row, now) : undefined;
      if (holder) throw new Error(`${await participantName(ctx, holder)} is editing a block`);
    }

    const target = new Map((await versionAt(ctx, document._id, changeSet.lastRev)).map((b) => [b.blockId, b]));
    await takeCheckpoint(ctx, document._id, 'before_restore');
    const restoreId = await openChangeSet(ctx, document._id, { kind: 'restore', actorParticipantId: participant._id });
    // Every write below goes through the shared block write path, so whatever
    // follows a block's text there also follows a restore.
    for (const row of rows) {
      const wanted = target.get(row._id);
      if (!wanted) {
        if (row.deletedAt === undefined) await deleteBlock(ctx, restoreId, row._id);
        continue;
      }
      const { order, kind, text, author } = wanted;
      const state = { order, kind, text, author };
      const ownBlock = author.kind === 'participant' && author.participantId === participant._id;
      const edited = ownBlock ? {} : { humanEditedAt: now };
      if (row.deletedAt !== undefined) {
        await reviveBlock(ctx, restoreId, row._id, state, edited);
      } else if (row.order !== order || row.kind !== kind || row.text !== text || !sameAuthor(row.author, author)) {
        await patchBlock(ctx, restoreId, row._id, { ...state, ...(row.text !== text ? edited : {}) });
      }
    }
    await record(ctx, {
      roomId: document.roomId,
      type: 'document.restored',
      actorParticipantId: participant._id,
      subjectId: restoreId,
      payload: { documentId: document._id, changeSetId: restoreId, restoredChangeSetId: changeSetId },
    });
    return restoreId;
  },
});
