import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import { requireMember } from './lib/auth';
import { isActiveTurnStatus, requireRunnerOnline } from './lib/dispatch';
import { SCRIBE_WORKING, ensureDocument, leaseHolder, liveBlocks, participantName, scribeWorking, takeCheckpoint } from './lib/document';
import { record } from './lib/ledger';
import { agentName, contextBlock, loadRoomContext, neutralize, roomMembers, turnPrompt } from './lib/prompt';
import { SCRIBE_LOCK_MS, SCRIBE_OUT_OF_TIME, releaseScribe } from './lib/scribe';
import { failTurn } from './runner';

// Either person in a room can call in a scribe: one of the room's models,
// which reorganizes the whole document in one turn. The document is saved
// first and stays read-only to everyone else until the run ends. See
// lib/scribe.ts for how the draft is applied or discarded.

function scribeInstructions(startedBy: string) {
  return [
    `${neutralize(agentName(startedBy))} has called you in as the scribe for the room document. Reorganize and consolidate the whole document so it reads as one clear, current record: merge notes that overlap, cut repetition, and move blocks into the sections they belong in.`,
    'You change nothing directly. Build a draft with the draft tools. It is applied all at once when you finish this turn, and only then; until then the document is read-only for everyone else. A saved version of the document from before your run is kept, so nothing is lost.',
    'Rules for the draft:',
    '- Every block your draft does not mention is kept exactly as it is. Mention only the blocks you rewrite, move or remove.',
    '- Every block you write lists in sourceBlockIds the ids of the blocks it draws from. Their authors are credited.',
    '- Where people or models disagree, keep each view and say whose it is. Do not settle the disagreement yourself.',
    '- Do not drop open questions. Merge duplicates of a question into one, and keep it open.',
    '- Comment threads follow the passage they are on. Each draft tool reply says which threads will move and which will lose their passage; keep commented wording where you can.',
    'When the draft is complete, end your turn with a short summary of what you changed.',
  ].join('\n');
}

// A run whose lock has expired is over: its turn, if still waiting or
// running, fails, and the run is released.
async function expireRun(ctx: MutationCtx, run: Doc<'scribeRuns'>) {
  const turn = run.turnId ? await ctx.db.get(run.turnId) : null;
  if (turn && isActiveTurnStatus(turn.status)) {
    const command = await ctx.db
      .query('commands')
      .withIndex('by_turn', (q) => q.eq('turnId', turn._id))
      .filter((q) => q.eq(q.field('type'), 'run_turn'))
      .first();
    if (command && (command.status === 'pending' || command.status === 'claimed')) {
      await failTurn(ctx, turn._id, command._id, SCRIBE_OUT_OF_TIME, false);
    }
  }
  await releaseScribe(ctx, run._id, 'released', SCRIBE_OUT_OF_TIME);
}

// Refused while someone is editing a block, naming them; while the runner is
// offline; and while a run is already working. Saves the document as it is,
// locks it for 35 minutes and queues the scribe's turn.
export const begin = mutation({
  args: { roomId: v.id('rooms'), participantId: v.id('participants') },
  handler: async (ctx, { roomId, participantId }) => {
    const { participant: human } = await requireMember(ctx, roomId);
    const scribe = await ctx.db.get(participantId);
    if (!scribe || scribe.roomId !== roomId || scribe.kind !== 'harness') throw new Error('Choose one of the room\'s models to act as scribe');
    const document = (await ctx.db.get(await ensureDocument(ctx, roomId)))!;
    const now = Date.now();
    if (document.scribeRunId) {
      if (scribeWorking(document, now)) throw new Error(SCRIBE_WORKING);
      const stale = await ctx.db.get(document.scribeRunId);
      if (stale) await expireRun(ctx, stale);
    }
    for (const block of await liveBlocks(ctx, document._id)) {
      const holder = leaseHolder(block, now);
      if (holder) throw new Error(`${await participantName(ctx, holder)} is editing a block`);
    }
    const room = await requireRunnerOnline(ctx, await ctx.db.get(roomId));

    await takeCheckpoint(ctx, document._id, 'before_scribe');
    const scribeRunId = await ctx.db.insert('scribeRuns', {
      documentId: document._id,
      roomId,
      participantId,
      startedByParticipantId: human._id,
      status: 'running',
      startedAt: now,
    });
    const expiresAt = now + SCRIBE_LOCK_MS;
    await ctx.db.patch(document._id, { scribeRunId, scribeLockExpiresAt: expiresAt });
    await ctx.scheduler.runAt(expiresAt, internal.scribe.expireLock, { scribeRunId });

    const context = contextBlock({ ...(await loadRoomContext(ctx, room, await roomMembers(ctx, roomId))), editsEnabled: false }, 'scribe');
    const turnId = await ctx.db.insert('turns', {
      roomId,
      participantId,
      status: 'queued',
      prompt: turnPrompt({ context, messages: [scribeInstructions(human.displayName)] }),
      requestedByParticipantIds: [human._id],
      editsEnabled: false,
      scribeRunId,
    });
    await ctx.db.insert('commands', { runnerId: room.runnerId, type: 'run_turn', turnId, status: 'pending' });
    await ctx.db.patch(scribeRunId, { turnId });
    const started = await record(ctx, {
      roomId,
      type: 'document.scribe_started',
      actorParticipantId: human._id,
      subjectId: scribeRunId,
      payload: { documentId: document._id, scribeRunId, turnId, participantId },
    });
    await record(ctx, { roomId, type: 'turn.queued', actorParticipantId: participantId, subjectId: turnId, parentLedgerId: started, model: scribe.model });
    return scribeRunId;
  },
});

// Scheduled for the lock's expiry when a run starts. A run still working then
// has outlived any turn the runner could be running for it.
export const expireLock = internalMutation({
  args: { scribeRunId: v.id('scribeRuns') },
  handler: async (ctx, { scribeRunId }) => {
    const run = await ctx.db.get(scribeRunId);
    if (!run || run.status !== 'running') return;
    const document = await ctx.db.get(run.documentId);
    if (document?.scribeRunId === run._id && scribeWorking(document, Date.now())) return;
    await expireRun(ctx, run);
  },
});
