import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { NOTICE_VERSION, requireMember, requireOwner } from './lib/auth';
import { cancelMessage } from './lib/dispatch';
import { record } from './lib/ledger';

// The owner's view of who is in a room and who has been invited.
export const list = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    await requireOwner(ctx);
    await requireMember(ctx, roomId);
    const rows = await ctx.db.query('roomMembers').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
    const members = [];
    for (const m of rows.filter((m) => m.removedAt === undefined)) {
      const user = await ctx.db.get(m.userId);
      const participant = await ctx.db.get(m.participantId);
      members.push({
        _id: m._id,
        role: m.role,
        participantId: m.participantId,
        displayName: participant?.displayName ?? null,
        email: user?.email ?? null,
        noticeVersion: m.noticeVersion ?? null,
      });
    }
    const now = Date.now();
    const invites = (await ctx.db.query('roomInvites').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect())
      .filter((i) => i.status === 'pending')
      .map((i) => ({ _id: i._id, email: i.email, expiresAt: i.expiresAt, expired: i.expiresAt <= now }));
    return { members, invites };
  },
});

// Which version of the join notice the caller has accepted in this room.
export const notice = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    const { member } = await requireMember(ctx, roomId);
    return { currentVersion: NOTICE_VERSION, acceptedVersion: member.noticeVersion ?? null };
  },
});

export const acceptNotice = mutation({
  args: { roomId: v.id('rooms'), version: v.number() },
  handler: async (ctx, { roomId, version }) => {
    const { member } = await requireMember(ctx, roomId);
    if (version !== NOTICE_VERSION) throw new Error('The notice has changed; read it again');
    await ctx.db.patch(member._id, { noticeVersion: version, noticeAcceptedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { memberId: v.id('roomMembers') },
  handler: async (ctx, { memberId }) => {
    await requireOwner(ctx);
    const member = await ctx.db.get(memberId);
    if (!member) throw new Error('Unknown member');
    const { participant: owner } = await requireMember(ctx, member.roomId);
    if (member.role === 'owner') throw new Error('The owner cannot be removed');
    if (member.removedAt !== undefined) return;
    await ctx.db.patch(memberId, { removedAt: Date.now() });
    // Whatever the removed person left waiting for an agent is never delivered.
    const waiting = (await ctx.db.query('messages').withIndex('by_room', (q) => q.eq('roomId', member.roomId)).collect())
      .filter((m) => m.authorParticipantId === member.participantId && m.delivery === 'queued');
    for (const m of waiting) await cancelMessage(ctx, m, 'removed', owner._id);
    await record(ctx, {
      roomId: member.roomId,
      type: 'member.removed',
      actorParticipantId: owner._id,
      subjectId: memberId,
      payload: { participantId: member.participantId },
    });
  },
});
