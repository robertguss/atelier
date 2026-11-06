import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireMember } from './lib/auth';
import { activeOrdinaryTurn, dispatchNext, offlineReason, OFFLINE_AFTER_MS, runnerOnline } from './lib/dispatch';
import { record } from './lib/ledger';
import { renderMessage } from './lib/prompt';

// "Steer now": put a queued message into the agent's running turn instead of
// waiting for it to end. With no turn running, the message is dispatched as
// usual. The runner reports the harness's verdict through steerResult.
export const steer = mutation({
  args: { messageId: v.id('messages') },
  handler: async (ctx, { messageId }): Promise<{ status: 'steering' | 'delivered' | 'queued'; turnId?: Id<'turns'> }> => {
    const message = await ctx.db.get(messageId);
    if (!message) throw new Error('Unknown message');
    const { participant } = await requireMember(ctx, message.roomId);
    if (message.delivery !== 'queued' || !message.toParticipantId) throw new Error('This message is no longer waiting');
    // A follow-up to a review or decision always runs as its own turn.
    if (message.followUpRitualId) throw new Error('A follow-up runs as its own turn');
    const room = await ctx.db.get(message.roomId);
    const runner = room ? await ctx.db.get(room.runnerId) : null;
    if (!room || !runnerOnline(runner)) throw new Error(offlineReason(runner));

    const active = await activeOrdinaryTurn(ctx, message.toParticipantId);
    if (active?.status === 'running' && !active.followUp) {
      const commandId = await ctx.db.insert('commands', {
        runnerId: room.runnerId,
        type: 'steer',
        turnId: active._id,
        status: 'pending',
        payload: { messageId, text: await renderMessage(ctx, message, 'steered') },
      });
      await ctx.db.patch(messageId, { delivery: 'steering', steering: { turnId: active._id, commandId } });
      await record(ctx, { roomId: message.roomId, type: 'message.steer_requested', actorParticipantId: participant._id, subjectId: messageId, payload: { turnId: active._id } });
      return { status: 'steering', turnId: active._id };
    }
    const turnId = await dispatchNext(ctx, message.toParticipantId);
    return turnId ? { status: 'delivered', turnId } : { status: 'queued' };
  },
});

// Everything a member needs to draw the agent pane: messages to agents with
// their delivery state, agent replies, turns with their streamed text, each
// agent's status, the edit switch and the runner's last heartbeat. Members
// never see reviews, follow-ups to them, or any turn's prompt.
export const pane = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const room = (await ctx.db.get(roomId))!;
    const runner = await ctx.db.get(room.runnerId);
    const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
    const messages = (await ctx.db.query('messages').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect())
      .filter((m) => m.visibility === 'room' && !m.ritualId && (isOwner || !m.followUpRitualId));
    const turns = (await ctx.db.query('turns').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect())
      .filter((t) => !t.ritualId && (isOwner || !t.followUp));

    const agents = [];
    for (const p of participants.filter((p) => p.kind === 'harness')) {
      const active = await activeOrdinaryTurn(ctx, p._id);
      const status = !active ? 'idle' : active.status === 'queued' ? 'starting' : active.waitingOnHandId ? 'waiting' : 'running';
      agents.push({
        participantId: p._id,
        displayName: p.displayName,
        harness: p.harness ?? null,
        status,
        activeTurnId: active && (isOwner || !active.followUp) ? active._id : null,
        queued: messages.filter((m) => m.toParticipantId === p._id && (m.delivery === 'queued' || m.delivery === 'steering')).length,
      });
    }

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
      turns: turns.map((t) => ({
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
      })),
    };
  },
});
