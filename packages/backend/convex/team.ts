import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireMember } from './lib/auth';
import { record } from './lib/ledger';

// The humans-only chat in a room. Nothing that builds agent prompts reads
// this table. Posts are permanent: there is no edit or delete.

export const list = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    await requireMember(ctx, roomId);
    const rows = await ctx.db.query('teamMessages').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
    return rows.map((m) => ({ _id: m._id, at: m._creationTime, authorParticipantId: m.authorParticipantId, body: m.body }));
  },
});

export const post = mutation({
  args: { roomId: v.id('rooms'), body: v.string() },
  handler: async (ctx, { roomId, body }) => {
    const { user, participant } = await requireMember(ctx, roomId);
    const text = body.trim();
    if (!text) throw new Error('Empty message');
    const messageId = await ctx.db.insert('teamMessages', { roomId, authorUserId: user._id, authorParticipantId: participant._id, body: text });
    // The ledger holds the id only, so ledger readers never see the text.
    await record(ctx, { roomId, type: 'team_message.posted', actorParticipantId: participant._id, subjectId: messageId, payload: { messageId } });
    return messageId;
  },
});
