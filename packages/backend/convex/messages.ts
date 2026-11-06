import { reviewFinished } from './lib/review';
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireOwner } from './lib/auth';
import { record } from './lib/ledger';

// The room timeline: visible messages plus every turn that hasn't produced a
// message yet (queued, running, failed, interrupted), so the phone can show
// live progress and errors in place.
export const timeline = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    await requireOwner(ctx);
    const messages = await ctx.db
      .query('messages')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();
    const turns = await ctx.db
      .query('turns')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();

    const items = [
      ...messages
        .filter((m) => m.visibility === 'room')
        .map((m) => ({
          kind: 'message' as const,
          id: m._id,
          at: m._creationTime,
          authorParticipantId: m.authorParticipantId,
          body: m.body,
        })),
      ...turns
        .filter((t) => !t.ritualId && t.status !== 'done')
        .map((t) => ({
          kind: 'turn' as const,
          id: t._id,
          at: t._creationTime,
          authorParticipantId: t.participantId,
          status: t.status,
          partialText: t.partialText ?? '',
          error: t.error ?? null,
        })),
    ];
    return items.sort((a, b) => a.at - b.at);
  },
});

// Post a message and ask one participant (Claude by default) to reply.
export const send = mutation({
  args: { roomId: v.id('rooms'), body: v.string(), toParticipantId: v.optional(v.id('participants')), decisionId: v.optional(v.id('decisions')), reviewTurnId: v.optional(v.id('turns')) },
  handler: async (ctx, { roomId, body, toParticipantId, decisionId, reviewTurnId }) => {
    await requireOwner(ctx);
    const text = body.trim();
    if (!text) throw new Error('Empty message');
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error('Unknown room');

    const participants = await ctx.db
      .query('participants')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();
    const human = participants.find((p) => p.kind === 'human');
    const target = toParticipantId
      ? participants.find((p) => p._id === toParticipantId)
      : participants.find((p) => p.harness === 'claude');
    if (!human || !target || target.kind !== 'harness') throw new Error('Room has no one to reply');

    let parentLedgerId;
    let decisionContext = '';
    if (decisionId) {
      const decision = await ctx.db.get(decisionId);
      if (!decision || decision.roomId !== roomId) throw new Error('Invalid decision');
      parentLedgerId = (await ctx.db.query('ledger').withIndex('by_room', q => q.eq('roomId', roomId)).collect()).find(e => e.type === 'decision.recorded' && e.subjectId === decisionId)?._id;
      if (!parentLedgerId) throw new Error('Decision has no ledger entry');
      decisionContext = `\n\nFollow-up to the owner's decision: ${decision.choice}\nRationale: ${decision.rationale ?? ''}`;
    }
    if (reviewTurnId) {
      if (decisionId) throw new Error('Choose one follow-up source');
      const source = await ctx.db.get(reviewTurnId);
      const ritual = source?.ritualId ? await ctx.db.get(source.ritualId) : null;
      if (!source || source.roomId !== roomId || !ritual || ritual.status === 'collecting') throw new Error('Review is not available for follow-up');
      if (source.participantId !== target._id) throw new Error('Choose the participant who wrote this answer');
      parentLedgerId = (await ctx.db.query('ledger').withIndex('by_room', q => q.eq('roomId', roomId)).collect()).find(e => e.type === 'ritual.revealed' && e.subjectId === ritual._id)?._id;
      decisionContext = `\n\nFollow-up to your independent review. Original request: ${ritual.request}\nYour answer: ${source.finalText ?? 'The review turn failed; no answer was returned.'}`;
    }
    const messageId = await ctx.db.insert('messages', {
      roomId,
      authorParticipantId: human._id,
      body: text,
      visibility: 'room',
    });
    const posted = await record(ctx, {
      roomId,
      type: 'message.posted',
      parentLedgerId,
      actorParticipantId: human._id,
      subjectId: messageId,
      payload: { to: target._id },
    });

    const turnId = await ctx.db.insert('turns', {
      roomId,
      participantId: target._id,
      status: 'queued',
      prompt: text + decisionContext,
    });
    await record(ctx, {
      roomId,
      type: 'turn.queued',
      actorParticipantId: target._id,
      subjectId: turnId,
      parentLedgerId: posted,
      model: target.model,
    });

    await ctx.db.insert('commands', { runnerId: room.runnerId, type: 'run_turn', turnId, status: 'pending' });
    return turnId;
  },
});

export const cancel = mutation({
  args: { turnId: v.id('turns') },
  handler: async (ctx, { turnId }) => {
    await requireOwner(ctx);
    const turn = await ctx.db.get(turnId);
    if (!turn || !['queued', 'running'].includes(turn.status)) return;
    await ctx.db.patch(turnId, { status: turn.ritualId ? 'failed' : 'interrupted', error: 'Cancelled by you', endedAt: Date.now() });
    await reviewFinished(ctx, turn);
    const room = await ctx.db.get(turn.roomId);
    if (room) {
      for (const status of ['pending', 'claimed'] as const) {
        const commands = await ctx.db.query('commands').withIndex('by_runner_status', q => q.eq('runnerId', room.runnerId).eq('status', status)).collect();
        for (const command of commands.filter(c => c.turnId === turnId)) await ctx.db.patch(command._id, { status: 'failed', error: 'Cancelled by owner', leaseExpiresAt: undefined });
      }
    }
    await record(ctx, { roomId: turn.roomId, type: 'turn.interrupted', subjectId: turnId, payload: { error: 'Cancelled by owner' } });
  },
});
