import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireMember } from './lib/auth';
import { activeOrdinaryTurn, dispatchNext, OFFLINE_AFTER_MS, requireRunnerOnline, steerMessage, takesSteer } from './lib/dispatch';
import { visibleMessage, visibleTurn } from './lib/visibility';

// "Steer now": put a queued message into the agent's running turn instead of
// waiting for it to end. With no turn running, the message is dispatched as
// usual.
export const steer = mutation({
  args: { messageId: v.id('messages') },
  handler: async (ctx, { messageId }): Promise<{ status: 'steering' | 'delivered' | 'queued'; turnId?: Id<'turns'> }> => {
    const message = await ctx.db.get(messageId);
    if (!message) throw new Error('Unknown message');
    const { participant } = await requireMember(ctx, message.roomId);
    if (message.delivery !== 'queued' || !message.toParticipantId) throw new Error('This message is no longer waiting');
    if (message.followUpRitualId) throw new Error('A follow-up runs as its own turn');
    const room = await requireRunnerOnline(ctx, await ctx.db.get(message.roomId));

    const active = await activeOrdinaryTurn(ctx, message.toParticipantId);
    if (takesSteer(active)) {
      await steerMessage(ctx, message, active, room.runnerId, participant._id);
      return { status: 'steering', turnId: active._id };
    }
    const turnId = await dispatchNext(ctx, message.toParticipantId);
    return turnId ? { status: 'delivered', turnId } : { status: 'queued' };
  },
});

const RECENT_CARDS = 20;

// Members never see reviews, follow-ups to them, or any turn's prompt.
export const pane = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const room = (await ctx.db.get(roomId))!;
    const runner = await ctx.db.get(room.runnerId);
    const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
    const messages = (await ctx.db.query('messages').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect())
      .filter((m) => visibleMessage(m, isOwner, { ownerSeesReviewAnswers: false }));
    const turns = (await ctx.db.query('turns').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect())
      .filter((t) => visibleTurn(t, isOwner));

    const agents = [];
    for (const p of participants.filter((p) => p.kind === 'harness')) {
      const active = await activeOrdinaryTurn(ctx, p._id);
      const status = !active ? 'idle' : active.status === 'queued' ? 'starting' : active.waitingOnHandId ? 'waiting' : 'running';
      agents.push({
        participantId: p._id,
        displayName: p.displayName,
        harness: p.harness ?? null,
        status,
        activeTurnId: active && visibleTurn(active, isOwner) ? active._id : null,
        queued: messages.filter((m) => m.toParticipantId === p._id && (m.delivery === 'queued' || m.delivery === 'steering')).length,
        // Null until the runner reports it. An agent that cannot raise cards asks in plain text.
        canRaiseCards: runner?.harnessCapabilities?.find((c) => c.id === p.harness)?.canRaiseCards ?? null,
      });
    }

    // Open cards, then the most recent closed ones, only on turns the caller can see.
    const visibleTurnIds = new Set(turns.map((t) => t._id));
    const hands = (await ctx.db.query('hands').withIndex('by_room_status', (q) => q.eq('roomId', roomId)).collect())
      .filter((h) => visibleTurnIds.has(h.turnId))
      .sort((a, b) => a.raisedAt - b.raisedAt);
    const cards = [...hands.filter((h) => h.status === 'raised'), ...hands.filter((h) => h.status !== 'raised').slice(-RECENT_CARDS)];

    return {
      runner: { lastHeartbeatAt: runner?.lastHeartbeatAt ?? 0, offlineAfterMs: OFFLINE_AFTER_MS },
      editsEnabled: room.editsEnabled === true,
      agents,
      messages: messages.map((m) => ({
        id: m._id,
        at: m._creationTime,
        authorParticipantId: m.authorParticipantId,
        body: m.body,
        toParticipantId: m.toParticipantId ?? null,
        // Set on an agent's reply.
        turnId: m.turnId ?? null,
        delivery: m.delivery ?? null,
        deliveredTurnId: m.deliveredTurnId ?? null,
        cancelReason: m.cancelReason ?? null,
      })),
      cards: cards.map((h) => ({
        id: h._id,
        turnId: h.turnId,
        participantId: h.participantId,
        questions: h.questions,
        status: h.status,
        answers: h.answers ?? null,
        answeredByParticipantId: h.answeredByParticipantId ?? null,
        answeredAt: h.answeredAt ?? null,
        via: h.via ?? null,
        raisedAt: h.raisedAt,
        closedAt: h.closedAt ?? null,
        closeReason: h.closeReason ?? null,
      })),
      turns: await Promise.all(turns.map(async (t) => ({
        id: t._id,
        at: t._creationTime,
        participantId: t.participantId,
        status: t.status,
        partialText: t.partialText ?? '',
        error: t.error ?? null,
        requestedByParticipantIds: t.requestedByParticipantIds ?? [],
        waitingOnHandId: t.waitingOnHandId ?? null,
        stoppedByParticipantId: t.stoppedByParticipantId ?? null,
        startedAt: t.startedAt ?? null,
        endedAt: t.endedAt ?? null,
        items: (await ctx.db.query('turnItems').withIndex('by_turn_call', (q) => q.eq('turnId', t._id)).collect())
          .sort((a, b) => a.seq - b.seq)
          .map((i) => ({ name: i.name, summary: i.summary, ok: i.ok ?? null })),
      }))),
    };
  },
});
