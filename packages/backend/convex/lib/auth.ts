import type { Auth, UserIdentity } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

// Bump when the join notice text changes, so members are asked to read it again.
export const NOTICE_VERSION = 2;

// ATELIER_OWNER_EMAILS (comma-separated) lists the Clerk accounts with owner
// powers. Everyone else reaches only the rooms they were invited to.
export async function getOwner(ctx: { auth: Auth }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return isOwnerIdentity(identity) ? identity : null;
}

export async function requireOwner(ctx: { auth: Auth }) {
  const owner = await getOwner(ctx);
  if (!owner) throw new Error('Not signed in as the Atelier owner');
  return owner;
}

function isOwnerIdentity(identity: UserIdentity) {
  const raw: string = process.env.ATELIER_OWNER_EMAILS ?? '';
  const allowed = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = identity.email?.toLowerCase();
  return !!email && allowed.includes(email);
}

export async function getUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query('users')
    .withIndex('by_token', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
    .unique();
}

// The caller's membership in a room, whether active or removed.
export async function getMembership(ctx: QueryCtx, roomId: Id<'rooms'>) {
  const user = await getUser(ctx);
  if (!user) return null;
  const member = await ctx.db
    .query('roomMembers')
    .withIndex('by_room_user', (q) => q.eq('roomId', roomId).eq('userId', user._id))
    .unique();
  return member ? { user, member } : null;
}

export async function requireMember(ctx: QueryCtx, roomId: Id<'rooms'>) {
  const found = await getMembership(ctx, roomId);
  if (!found) throw new Error('Not a member of this room');
  if (found.member.removedAt !== undefined) throw new Error('You are no longer a member of this room');
  const participant = await ctx.db.get(found.member.participantId);
  if (!participant) throw new Error('Member has no participant');
  const isOwner = found.member.role === 'owner' && (await getOwner(ctx)) !== null;
  return { user: found.user, member: found.member, participant, isOwner };
}

// Upsert the caller's user row. For the owner, also link every room created
// before memberships existed: its unlinked human participant becomes the
// owner's, with an owner member row. Safe to run any number of times.
export async function ensureUser(ctx: MutationCtx): Promise<Doc<'users'>> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Not signed in');
  const fields = { email: identity.email?.toLowerCase(), name: identity.name };
  const existing = await ctx.db
    .query('users')
    .withIndex('by_token', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
    .unique();
  let user: Doc<'users'>;
  if (existing) {
    if (existing.email !== fields.email || existing.name !== fields.name) await ctx.db.patch(existing._id, fields);
    user = { ...existing, ...fields };
  } else {
    const id = await ctx.db.insert('users', { tokenIdentifier: identity.tokenIdentifier, ...fields });
    user = (await ctx.db.get(id))!;
  }
  if (isOwnerIdentity(identity)) await backfillOwner(ctx, user._id);
  return user;
}

async function backfillOwner(ctx: MutationCtx, userId: Id<'users'>) {
  const memberships = await ctx.db.query('roomMembers').withIndex('by_user', (q) => q.eq('userId', userId)).collect();
  const linked = new Set(memberships.map((m) => m.roomId));
  for (const room of await ctx.db.query('rooms').collect()) {
    if (linked.has(room._id)) continue;
    const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', room._id)).collect();
    const human = participants.find((p) => p.kind === 'human' && (p.userId === undefined || p.userId === userId));
    if (!human) continue;
    if (human.userId === undefined) await ctx.db.patch(human._id, { userId });
    await ctx.db.insert('roomMembers', { roomId: room._id, userId, role: 'owner', participantId: human._id });
  }
}

// Runner functions authenticate with a shared secret instead of Clerk.
export function requireRunnerSecret(secret: string) {
  const expected = process.env.ATELIER_RUNNER_SECRET;
  if (!expected || !timingSafeEqual(secret, expected)) {
    throw new Error('Bad runner secret');
  }
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Whether anyone besides the owner currently belongs to the room.
export async function hasActiveTeammate(ctx: QueryCtx, roomId: Id<'rooms'>) {
  const rows = await ctx.db.query('roomMembers').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
  return rows.some((m) => m.role === 'member' && m.removedAt === undefined);
}
