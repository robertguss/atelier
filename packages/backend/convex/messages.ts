import { reviewFinished } from './lib/review';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query, type QueryCtx } from './_generated/server';
import { requireMember } from './lib/auth';
import { answerCard, closeOpenCards, ownerOnlyCard, waitingCard } from './lib/cards';
import { dispatchNext, offlineReason, runnerOnline } from './lib/dispatch';
import { record } from './lib/ledger';

// The room timeline: visible messages plus every turn that hasn't produced a
// message yet (queued, running, failed, interrupted), so the phone can show
// live progress and errors in place. Members never see independent reviews,
// review answers, or follow-ups to a review or its decision.
export const timeline = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
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
        .filter((m) => m.visibility === 'room' && (isOwner || (!m.ritualId && !m.followUpRitualId)))
        .map((m) => ({
          kind: 'message' as const,
          id: m._id,
          at: m._creationTime,
          authorParticipantId: m.authorParticipantId,
          body: m.body,
        })),
      ...turns
        .filter((t) => !t.ritualId && t.status !== 'done' && (isOwner || !t.followUp))
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

// Post a message to one agent (Claude by default). An idle agent starts a
// turn at once; a busy one gets it, with anything else waiting, when its
// current turn ends. Returns the new turn, or null when the message waits.
// Following up a review or decision is the owner's alone. A message to an
// agent waiting on its own question card answers that card instead.
export const send = mutation({
  args: { roomId: v.id('rooms'), body: v.string(), toParticipantId: v.optional(v.id('participants')), decisionId: v.optional(v.id('decisions')), reviewTurnId: v.optional(v.id('turns')) },
  handler: async (ctx, { roomId, body, toParticipantId, decisionId, reviewTurnId }): Promise<Id<'turns'> | null> => {
    const { participant: human, isOwner } = await requireMember(ctx, roomId);
    if ((decisionId || reviewTurnId) && !isOwner) throw new Error('Only the owner can follow up a review');
    const text = body.trim();
    if (!text) throw new Error('Empty message');
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error('Unknown room');
    const runner = await ctx.db.get(room.runnerId);
    if (!runnerOnline(runner)) throw new Error(offlineReason(runner));

    const participants = await ctx.db
      .query('participants')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();
    const target = toParticipantId
      ? participants.find((p) => p._id === toParticipantId)
      : participants.find((p) => p.harness === 'claude');
    if (!target || target.kind !== 'harness') throw new Error('Room has no one to reply');

    const card = decisionId || reviewTurnId ? null : await waitingCard(ctx, target._id);
    if (card && (isOwner || !(await ownerOnlyCard(ctx, card)))) {
      const messageId = await ctx.db.insert('messages', {
        roomId,
        authorParticipantId: human._id,
        body: text,
        visibility: 'room',
        toParticipantId: target._id,
        delivery: 'answeredCard',
        deliveredTurnId: card.turnId,
      });
      await record(ctx, { roomId, type: 'message.posted', actorParticipantId: human._id, subjectId: messageId, payload: { to: target._id, handId: card._id } });
      const answers = card.questions.map((q) => ({ questionId: q.id, labels: [], freeText: text }));
      await answerCard(ctx, card, human, answers, 'chat', messageId);
      return null;
    }

    let parentLedgerId: Id<'ledger'> | undefined;
    let followUpRitualId: Id<'rituals'> | undefined;
    if (decisionId) {
      const decision = await ctx.db.get(decisionId);
      if (!decision || decision.roomId !== roomId) throw new Error('Invalid decision');
      followUpRitualId = decision.ritualId;
      parentLedgerId = await ledgerIdFor(ctx, roomId, 'decision.recorded', decisionId);
      if (!parentLedgerId) throw new Error('Decision has no ledger entry');
    }
    if (reviewTurnId) {
      if (decisionId) throw new Error('Choose one follow-up source');
      const source = await ctx.db.get(reviewTurnId);
      const ritual = source?.ritualId ? await ctx.db.get(source.ritualId) : null;
      if (!source || source.roomId !== roomId || !ritual || ritual.status === 'collecting') throw new Error('Review is not available for follow-up');
      if (source.participantId !== target._id) throw new Error('Choose the participant who wrote this answer');
      followUpRitualId = ritual._id;
      parentLedgerId = await ledgerIdFor(ctx, roomId, 'ritual.revealed', ritual._id);
    }
    const messageId = await ctx.db.insert('messages', {
      roomId,
      authorParticipantId: human._id,
      body: text,
      visibility: 'room',
      followUpRitualId,
      followUpDecisionId: decisionId,
      followUpReviewTurnId: reviewTurnId,
      toParticipantId: target._id,
      delivery: 'queued',
    });
    await record(ctx, {
      roomId,
      type: 'message.posted',
      parentLedgerId,
      actorParticipantId: human._id,
      subjectId: messageId,
      payload: { to: target._id },
    });
    return await dispatchNext(ctx, target._id);
  },
});

async function ledgerIdFor(ctx: QueryCtx, roomId: Id<'rooms'>, type: string, subjectId: string) {
  const row = await ctx.db
    .query('ledger')
    .withIndex('by_room_type', (q) => q.eq('roomId', roomId).eq('type', type).eq('subjectId', subjectId))
    .first();
  return row?._id;
}

// Any member can stop an ordinary turn; review turns are the owner's.
export const cancel = mutation({
  args: { turnId: v.id('turns') },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) throw new Error('Unknown turn');
    const { participant, isOwner } = await requireMember(ctx, turn.roomId);
    if (turn.ritualId && !isOwner) throw new Error('Only the owner can stop a review');
    if (!['queued', 'running'].includes(turn.status)) return;
    const reason = isOwner ? 'Cancelled by owner' : `Cancelled by ${participant.displayName}`;
    await ctx.db.patch(turnId, {
      status: turn.ritualId ? 'failed' : 'interrupted',
      error: isOwner ? 'Cancelled by you' : reason,
      endedAt: Date.now(),
      stoppedByParticipantId: participant._id,
    });
    await closeOpenCards(ctx, turnId, 'cancelled', reason);
    await reviewFinished(ctx, turn);
    const room = await ctx.db.get(turn.roomId);
    if (room) {
      for (const status of ['pending', 'claimed'] as const) {
        const commands = await ctx.db.query('commands').withIndex('by_runner_status', q => q.eq('runnerId', room.runnerId).eq('status', status)).collect();
        for (const command of commands.filter(c => c.turnId === turnId)) await ctx.db.patch(command._id, { status: 'failed', error: reason, leaseExpiresAt: undefined });
      }
    }
    await record(ctx, { roomId: turn.roomId, type: 'turn.interrupted', actorParticipantId: participant._id, subjectId: turnId, payload: { error: reason } });
    if (!turn.ritualId) await dispatchNext(ctx, turn.participantId);
  },
});
