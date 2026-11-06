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
        .filter((t) => t.status !== 'done')
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
  args: { roomId: v.id('rooms'), body: v.string(), toParticipantId: v.optional(v.id('participants')) },
  handler: async (ctx, { roomId, body, toParticipantId }) => {
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

    const messageId = await ctx.db.insert('messages', {
      roomId,
      authorParticipantId: human._id,
      body: text,
      visibility: 'room',
    });
    const posted = await record(ctx, {
      roomId,
      type: 'message.posted',
      actorParticipantId: human._id,
      subjectId: messageId,
      payload: { to: target._id },
    });

    const turnId = await ctx.db.insert('turns', {
      roomId,
      participantId: target._id,
      status: 'queued',
      prompt: text,
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
