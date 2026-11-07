import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server';
import { ensureUser, hasActiveTeammate, requireOwner } from './lib/auth';
import { record } from './lib/ledger';
import { agentName } from './lib/prompt';
import { resetSoloFollowUpSessions } from './lib/sessions';

// Room invites. A Convex row per room and email decides access; a Clerk
// invitation is sent only when the email has no Clerk account yet, so the
// person can sign up while Clerk sign-up is restricted.

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const CLERK_API = 'https://api.clerk.com/v1';

export const create = action({
  args: { roomId: v.id('rooms'), email: v.string() },
  handler: async (ctx, { roomId, email: rawEmail }): Promise<{ inviteId: Id<'roomInvites'>; url: string; emailed: boolean }> => {
    await requireOwner(ctx);
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Enter an email address');
    if (!(await ctx.runQuery(internal.invites.roomExists, { roomId }))) throw new Error('Unknown room');
    const webUrl = process.env.ATELIER_WEB_URL;
    if (!webUrl) throw new Error('ATELIER_WEB_URL is not set');

    const token = randomToken();
    const url = `${webUrl.replace(/\/+$/, '')}/invite/${token}`;
    const users = await clerk<unknown[]>('GET', `/users?email_address=${encodeURIComponent(email)}`);
    let clerkInvitationId: string | undefined;
    if (users.length === 0) {
      const invitation = await clerk<{ id: string }>('POST', '/invitations', {
        email_address: email,
        redirect_url: url,
        notify: true,
        ignore_existing: true,
      });
      clerkInvitationId = invitation.id;
    }
    const inviteId: Id<'roomInvites'> = await ctx.runMutation(internal.invites.insert, {
      roomId,
      email,
      tokenHash: await hashToken(token),
      clerkInvitationId,
    });
    return { inviteId, url, emailed: clerkInvitationId !== undefined };
  },
});

export const roomExists = internalQuery({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => (await ctx.db.get(roomId)) !== null,
});

export const insert = internalMutation({
  args: { roomId: v.id('rooms'), email: v.string(), tokenHash: v.string(), clerkInvitationId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const inviteId = await ctx.db.insert('roomInvites', { ...args, status: 'pending', expiresAt: Date.now() + INVITE_LIFETIME_MS });
    await record(ctx, { roomId: args.roomId, type: 'invite.created', subjectId: inviteId, payload: { email: args.email } });
    return inviteId;
  },
});

// The row is revoked first, so the invite stops working at once. The Clerk
// invitation id is cleared only after Clerk confirms its revoke, so a revoke
// whose Clerk call failed can be run again.
export const revoke = action({
  args: { inviteId: v.id('roomInvites') },
  handler: async (ctx, { inviteId }) => {
    await requireOwner(ctx);
    const clerkInvitationId: string | null = await ctx.runMutation(internal.invites.markRevoked, { inviteId });
    if (!clerkInvitationId) return;
    await clerk('POST', `/invitations/${encodeURIComponent(clerkInvitationId)}/revoke`);
    await ctx.runMutation(internal.invites.clearClerkInvitation, { inviteId, clerkInvitationId });
  },
});

// Returns the Clerk invitation still to revoke, if any. An invite already
// revoked whose Clerk invitation is still live returns it again.
export const markRevoked = internalMutation({
  args: { inviteId: v.id('roomInvites') },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    if (!invite) throw new Error('Unknown invite');
    if (invite.status === 'revoked' && invite.clerkInvitationId) return invite.clerkInvitationId;
    if (invite.status !== 'pending') throw new Error(`This invite is already ${invite.status}`);
    await ctx.db.patch(inviteId, { status: 'revoked', revokedAt: Date.now() });
    await record(ctx, { roomId: invite.roomId, type: 'invite.revoked', subjectId: inviteId });
    return invite.clerkInvitationId ?? null;
  },
});

export const clearClerkInvitation = internalMutation({
  args: { inviteId: v.id('roomInvites'), clerkInvitationId: v.string() },
  handler: async (ctx, { inviteId, clerkInvitationId }) => {
    const invite = await ctx.db.get(inviteId);
    if (invite?.clerkInvitationId === clerkInvitationId) await ctx.db.patch(inviteId, { clerkInvitationId: undefined });
  },
});

// What the invite page shows. An unknown token returns null and nothing else.
export const lookup = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const invite = await findInvite(ctx, token);
    if (!invite) return null;
    const room = await ctx.db.get(invite.roomId);
    const identity = await ctx.auth.getUserIdentity();
    return {
      roomId: invite.roomId,
      roomName: room?.name ?? '',
      email: maskEmail(invite.email),
      status: invite.status === 'pending' && invite.expiresAt <= Date.now() ? ('expired' as const) : invite.status,
      matches: emailMatches(identity, invite.email),
      expiresAt: invite.expiresAt,
    };
  },
});

type AcceptResult =
  | { ok: true; roomId: Id<'rooms'> }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'accepted' | 'email_mismatch' };

// Rejections are returned rather than thrown, so an expiry found here is
// written to the invite row.
export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AcceptResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Sign in to accept this invite');
    const invite = await findInvite(ctx, token);
    if (!invite) return { ok: false, reason: 'not_found' };
    if (!emailMatches(identity, invite.email)) return { ok: false, reason: 'email_mismatch' };
    const user = await ensureUser(ctx);
    if (invite.status === 'accepted') {
      return invite.acceptedByUserId === user._id ? { ok: true, roomId: invite.roomId } : { ok: false, reason: 'accepted' };
    }
    if (invite.status !== 'pending') return { ok: false, reason: invite.status };
    if (invite.expiresAt <= Date.now()) {
      await ctx.db.patch(invite._id, { status: 'expired' });
      return { ok: false, reason: 'expired' };
    }

    const roomId = invite.roomId;
    const existing = await ctx.db
      .query('roomMembers')
      .withIndex('by_room_user', (q) => q.eq('roomId', roomId).eq('userId', user._id))
      .unique();
    const joins = !existing || existing.removedAt !== undefined;
    const firstTeammate = joins && !(await hasActiveTeammate(ctx, roomId));
    let memberId = existing?._id;
    let participantId = existing?.participantId;
    if (!existing) {
      participantId = await ctx.db.insert('participants', {
        roomId,
        kind: 'human',
        displayName: agentName(identity.name || identity.email),
        userId: user._id,
      });
      memberId = await ctx.db.insert('roomMembers', { roomId, userId: user._id, role: 'member', participantId });
    } else if (existing.removedAt !== undefined) {
      await ctx.db.patch(existing._id, { removedAt: undefined });
    }
    await ctx.db.patch(invite._id, { status: 'accepted', acceptedByUserId: user._id, acceptedAt: Date.now() });
    if (joins) {
      const joinedLedgerId = await record(ctx, {
        roomId,
        type: 'member.joined',
        actorParticipantId: participantId,
        subjectId: memberId,
        payload: { inviteId: invite._id },
      });
      if (firstTeammate) await resetSoloFollowUpSessions(ctx, roomId, joinedLedgerId);
    }
    return { ok: true, roomId };
  },
});

async function findInvite(ctx: QueryCtx, token: string) {
  const tokenHash = await hashToken(token);
  return await ctx.db.query('roomInvites').withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash)).unique();
}

// A verified email on the signed-in identity must equal the invited one.
function emailMatches(identity: { email?: string; emailVerified?: boolean } | null, email: string) {
  return !!identity?.email && identity.emailVerified !== false && identity.email.toLowerCase() === email;
}

function maskEmail(email: string) {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function clerk<T = unknown>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error('CLERK_SECRET_KEY is not set');
  const response = await fetch(`${CLERK_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Clerk ${method} ${path.split('?')[0]} failed: ${response.status}`);
  return (await response.json()) as T;
}
