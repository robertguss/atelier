import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireMember } from './lib/auth';
import { activeOrdinaryTurn, dispatchNext, isActiveTurnStatus, OFFLINE_AFTER_MS, requireRunnerOnline, steerMessage, takesSteer } from './lib/dispatch';
import { activeRoomTurns, streamedText, toolItems } from './lib/turnActivity';
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
    if (message.threadId) throw new Error('A mention in a thread runs as its own turn');
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
// Turns in one page of agent-pane history. A turn usually brings a message in
// and a reply out, so the message window is wider.
export const PANE_PAGE = 40;
const MAX_TURNS = 400;
const MESSAGES_PER_TURN = 4;

// The agent pane's history: the latest `limit` turns (PANE_PAGE by default)
// with what was said around them, plus every active turn and waiting message
// however old. Active turns come without text or tool calls, which `live`
// carries, so the runner's streaming writes never rerun this query.
// Members never see reviews, follow-ups to them, or any turn's prompt.
export const pane = query({
  args: { roomId: v.id('rooms'), limit: v.optional(v.number()) },
  handler: async (ctx, { roomId, limit }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const room = (await ctx.db.get(roomId))!;
    const runner = await ctx.db.get(room.runnerId);
    const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
    const harnesses = participants.filter((p) => p.kind === 'harness');

    const turnLimit = Math.min(Math.max(Math.floor(limit ?? PANE_PAGE), 1), MAX_TURNS);
    const messageLimit = turnLimit * MESSAGES_PER_TURN;
    const recentTurns = await ctx.db.query('turns').withIndex('by_room', (q) => q.eq('roomId', roomId)).order('desc').take(turnLimit + 1);
    const recentMessages = await ctx.db.query('messages').withIndex('by_room', (q) => q.eq('roomId', roomId)).order('desc').take(messageLimit + 1);
    const moreTurns = recentTurns.length > turnLimit;
    const moreMessages = recentMessages.length > messageLimit;
    // Start both lists where the shorter-reaching one starts, so the timeline has no gaps.
    const since = Math.max(
      moreTurns ? recentTurns[turnLimit - 1]!._creationTime : 0,
      moreMessages ? recentMessages[messageLimit - 1]!._creationTime : 0,
    );
    const waiting = [];
    for (const p of harnesses) {
      for (const delivery of ['queued', 'steering'] as const) {
        waiting.push(...(await ctx.db.query('messages').withIndex('by_to_delivery', (q) => q.eq('toParticipantId', p._id).eq('delivery', delivery)).collect()));
      }
    }
    const messages = oldestFirst([...recentMessages.filter((m) => m._creationTime >= since), ...waiting])
      .filter((m) => visibleMessage(m, isOwner, { ownerSeesReviewAnswers: false }));
    const turns = oldestFirst([...recentTurns.filter((t) => t._creationTime >= since), ...(await activeRoomTurns(ctx, roomId))])
      .filter((t) => visibleTurn(t, isOwner));

    const agents = [];
    for (const p of harnesses) {
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
      hasOlder: moreTurns || moreMessages,
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
      turns: await Promise.all(turns.map(async (t) => {
        const ended = !isActiveTurnStatus(t.status);
        return {
          id: t._id,
          at: t._creationTime,
          participantId: t.participantId,
          status: t.status,
          partialText: ended ? await streamedText(ctx, t) : '',
          error: t.error ?? null,
          requestedByParticipantIds: t.requestedByParticipantIds ?? [],
          waitingOnHandId: t.waitingOnHandId ?? null,
          stoppedByParticipantId: t.stoppedByParticipantId ?? null,
          // Set on a turn answering a thread mention; its reply is in that thread.
          threadId: t.threadId ?? null,
          startedAt: t.startedAt ?? null,
          endedAt: t.endedAt ?? null,
          items: ended ? await toolItems(ctx, t._id) : [],
        };
      })),
    };
  },
});

// Streamed text and tool calls of the room's active turns. Small, so it can
// rerun on every runner write.
export const live = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const turns = (await activeRoomTurns(ctx, roomId)).filter((t) => visibleTurn(t, isOwner));
    return Promise.all(turns.map(async (t) => ({ id: t._id, partialText: await streamedText(ctx, t), items: await toolItems(ctx, t._id) })));
  },
});

// Deduplicated by id, oldest first.
function oldestFirst<T extends { _id: string; _creationTime: number }>(docs: T[]): T[] {
  return [...new Map(docs.map((d) => [d._id, d])).values()].sort((a, b) => a._creationTime - b._creationTime);
}
