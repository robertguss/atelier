/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
const modules = import.meta.glob('../convex/**/*.ts');

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = 'test-secret';
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// A fake Clerk Backend API. `existing` lists emails that already have accounts.
function mockClerk(existing: string[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    if (method === 'GET' && url.startsWith('https://api.clerk.com/v1/users?')) {
      const email = new URL(url).searchParams.get('email_address');
      return Response.json(existing.includes(email!) ? [{ id: 'user_1' }] : []);
    }
    if (method === 'POST' && url === 'https://api.clerk.com/v1/invitations') return Response.json({ id: `inv_${calls.length}` });
    if (method === 'POST' && /\/v1\/invitations\/[^/]+\/revoke$/.test(url)) return Response.json({ status: 'revoked' });
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const eve = t.withIdentity({ email: 'eve@example.com', subject: 'eve', name: 'Eve' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: 'test-secret', name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }, { id: 'pi', version: 'test' }] });
  const roomId = await owner.mutation(api.rooms.create, { name: 'Planning', runnerId, cwd: '/tmp/planning' });
  const otherRoomId = await owner.mutation(api.rooms.create, { name: 'Other', runnerId, cwd: '/tmp/other' });
  return { t, owner, dana, eve, runnerId, roomId, otherRoomId };
}

function tokenOf(url: string) { return url.split('/invite/')[1]!; }

test('an invited teammate joins one room, sees only it, and has no owner powers', async () => {
  const { t, owner, dana, runnerId, roomId, otherRoomId } = await setup();
  const calls = mockClerk();
  expect(await dana.query(api.rooms.list, {})).toEqual([]);
  expect(await dana.query(api.rooms.access, { roomId })).toBe('none');

  const invite = await owner.action(api.invites.create, { roomId, email: ' Dana@Example.com ' });
  expect(invite.emailed).toBe(true);
  expect(invite.url).toMatch(/^https:\/\/atelier\.example\.com\/invite\/[\w-]{40,}$/);
  const clerkInvite = calls.find(c => c.method === 'POST')!;
  expect(clerkInvite.body).toMatchObject({ email_address: 'dana@example.com', redirect_url: invite.url });
  await t.run(async ctx => {
    const row = (await ctx.db.query('roomInvites').collect())[0]!;
    expect(JSON.stringify(row)).not.toContain(tokenOf(invite.url));
    expect(row.expiresAt - Date.now()).toBe(7 * DAY);
  });

  expect(await dana.query(api.invites.lookup, { token: tokenOf(invite.url) })).toMatchObject({ roomName: 'Planning', email: 'd***@example.com', status: 'pending', matches: true });
  expect(await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) })).toEqual({ ok: true, roomId });
  expect(await dana.query(api.invites.lookup, { token: tokenOf(invite.url) })).toMatchObject({ status: 'accepted' });

  const list = await dana.query(api.rooms.list, {});
  expect(list.map(r => [r._id, r.role])).toEqual([[roomId, 'member']]);
  expect(await dana.query(api.rooms.access, { roomId })).toBe('member');
  expect(await dana.query(api.rooms.access, { roomId: otherRoomId })).toBe('none');
  expect(await dana.query(api.rooms.access, { roomId: 'not-an-id' })).toBe('none');
  expect(await owner.query(api.rooms.access, { roomId })).toBe('owner');
  expect((await dana.query(api.rooms.get, { roomId }))!.room.name).toBe('Planning');
  await expect(dana.query(api.rooms.get, { roomId: otherRoomId })).rejects.toThrow();

  const room = await owner.query(api.rooms.get, { roomId });
  const human = room!.participants.find(p => p.kind === 'human' && p.displayName === 'Dana')!;
  const me = await dana.query(api.me.get, {});
  expect(me).toMatchObject({ signedIn: true, isOwner: false });
  expect(human.userId).toBe((me as { userId: Id<'users'> }).userId);
  const claude = room!.participants.find(p => p.harness === 'claude')!;

  await expect(dana.mutation(api.rooms.addParticipant, { roomId, harness: 'pi' })).rejects.toThrow();
  await expect(dana.mutation(api.rituals.begin, { roomId, request: 'Review', participantIds: [claude._id] })).rejects.toThrow();
  await expect(dana.action(api.invites.create, { roomId, email: 'friend@example.com' })).rejects.toThrow();
  await expect(dana.mutation(api.rooms.create, { name: 'Mine', runnerId, cwd: '/tmp' })).rejects.toThrow();

  await t.run(async ctx => {
    const joined = (await ctx.db.query('ledger').collect()).filter(e => e.type === 'member.joined');
    expect(joined).toHaveLength(1);
    expect(joined[0]!.actorParticipantId).toBe(human._id);
  });
});

test('the join notice is stored by version on the member row', async () => {
  const { owner, dana, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
  const before = await dana.query(api.members.notice, { roomId });
  expect(before.acceptedVersion).toBeNull();
  await expect(dana.mutation(api.members.acceptNotice, { roomId, version: before.currentVersion - 1 })).rejects.toThrow();
  await dana.mutation(api.members.acceptNotice, { roomId, version: before.currentVersion });
  expect(await dana.query(api.members.notice, { roomId })).toEqual({ currentVersion: before.currentVersion, acceptedVersion: before.currentVersion });
});

test('an invite for another address shows the masked address and cannot be accepted', async () => {
  const { t, owner, eve, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  const token = tokenOf(invite.url);
  expect(await eve.query(api.invites.lookup, { token })).toMatchObject({ roomName: 'Planning', email: 'd***@example.com', status: 'pending', matches: false });
  expect(await eve.mutation(api.invites.accept, { token })).toEqual({ ok: false, reason: 'email_mismatch' });
  expect(await eve.query(api.rooms.access, { roomId })).toBe('none');
  await t.run(async ctx => { expect((await ctx.db.query('roomInvites').collect())[0]!.status).toBe('pending'); });
});

test('an unknown token reveals nothing', async () => {
  const { owner, dana, roomId } = await setup();
  mockClerk();
  await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  expect(await dana.query(api.invites.lookup, { token: 'made-up-token' })).toBeNull();
  expect(await dana.mutation(api.invites.accept, { token: 'made-up-token' })).toEqual({ ok: false, reason: 'not_found' });
});

test('expired and revoked invites are rejected and the row says why', async () => {
  const { t, owner, dana, roomId, otherRoomId } = await setup();
  const calls = mockClerk();
  const expiring = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  const revoked = await owner.action(api.invites.create, { roomId: otherRoomId, email: 'dana@example.com' });

  await owner.action(api.invites.revoke, { inviteId: revoked.inviteId });
  const clerkRevoke = calls.find(c => c.url.endsWith('/revoke'))!;
  const clerkInvites = calls.filter(c => c.method === 'POST' && c.url.endsWith('/invitations'));
  expect(clerkInvites).toHaveLength(2);
  expect(clerkRevoke.url).toBe(`https://api.clerk.com/v1/invitations/inv_${calls.indexOf(clerkInvites[1]!) + 1}/revoke`);
  expect(await dana.query(api.invites.lookup, { token: tokenOf(revoked.url) })).toMatchObject({ status: 'revoked' });
  expect(await dana.mutation(api.invites.accept, { token: tokenOf(revoked.url) })).toEqual({ ok: false, reason: 'revoked' });

  vi.setSystemTime(Date.now() + 7 * DAY + 1);
  expect(await dana.query(api.invites.lookup, { token: tokenOf(expiring.url) })).toMatchObject({ status: 'expired' });
  expect(await dana.mutation(api.invites.accept, { token: tokenOf(expiring.url) })).toEqual({ ok: false, reason: 'expired' });

  await t.run(async ctx => {
    const rows = await ctx.db.query('roomInvites').collect();
    expect(rows.find(r => r._id === expiring.inviteId)!.status).toBe('expired');
    expect(rows.find(r => r._id === revoked.inviteId)!.status).toBe('revoked');
    expect(await ctx.db.query('roomMembers').collect()).toHaveLength(2);
  });
  expect(await dana.query(api.rooms.list, {})).toEqual([]);
});

test('a second-room invite for an existing account adds a member row without a Clerk invitation', async () => {
  const { t, owner, dana, roomId, otherRoomId } = await setup();
  const calls = mockClerk(['dana@example.com']);
  const first = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  const second = await owner.action(api.invites.create, { roomId: otherRoomId, email: 'dana@example.com' });
  expect(first.emailed).toBe(false);
  expect(second.emailed).toBe(false);
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  await dana.mutation(api.invites.accept, { token: tokenOf(first.url) });
  await dana.mutation(api.invites.accept, { token: tokenOf(second.url) });
  expect((await dana.query(api.rooms.list, {})).map(r => r.role)).toEqual(['member', 'member']);
  await t.run(async ctx => {
    const users = await ctx.db.query('users').collect();
    const danaUser = users.find(u => u.email === 'dana@example.com')!;
    expect(await ctx.db.query('roomMembers').withIndex('by_user', q => q.eq('userId', danaUser._id)).collect()).toHaveLength(2);
  });
});

test('removing a member ends access at once and keeps their messages', async () => {
  const { t, owner, dana, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
  const { members } = await owner.query(api.members.list, { roomId });
  const member = members.find(m => m.role === 'member')!;
  await t.run(async ctx => {
    await ctx.db.insert('messages', { roomId, authorParticipantId: member.participantId, body: 'Dana was here', visibility: 'room' });
  });
  await expect(dana.mutation(api.members.remove, { memberId: member._id })).rejects.toThrow();

  await owner.mutation(api.members.remove, { memberId: member._id });
  await expect(dana.query(api.rooms.get, { roomId })).rejects.toThrow();
  expect(await dana.query(api.rooms.access, { roomId })).toBe('removed');
  expect(await dana.query(api.rooms.list, {})).toEqual([]);
  expect(JSON.stringify(await owner.query(api.messages.timeline, { roomId }))).toContain('Dana was here');
  expect((await owner.query(api.members.list, { roomId })).members.map(m => m.role)).toEqual(['owner']);
  await t.run(async ctx => {
    const removed = (await ctx.db.query('ledger').collect()).filter(e => e.type === 'member.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.subjectId).toBe(member._id);
  });
  const ownerMember = (await owner.query(api.members.list, { roomId })).members[0]!;
  await expect(owner.mutation(api.members.remove, { memberId: ownerMember._id })).rejects.toThrow();
});

test('the owner backfill links existing rooms once, however often it runs', async () => {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const roomIds = await t.run(async ctx => {
    const runnerId = await ctx.db.insert('runners', { name: 'test', machine: 'test', lastHeartbeatAt: 0, harnesses: [] });
    const ids = [];
    for (const name of ['Legacy A', 'Legacy B']) {
      const roomId = await ctx.db.insert('rooms', { name, runnerId, cwd: '/tmp', handbook: '' });
      await ctx.db.insert('participants', { roomId, kind: 'human', displayName: 'Robert' });
      await ctx.db.insert('participants', { roomId, kind: 'harness', harness: 'claude', displayName: 'Claude' });
      ids.push(roomId);
    }
    return ids;
  });
  expect(await owner.query(api.rooms.list, {})).toEqual([]);
  const userId = await owner.mutation(api.users.ensure, {});
  expect(await owner.mutation(api.users.ensure, {})).toBe(userId);
  await t.run(async ctx => {
    for (const roomId of roomIds) {
      const rows = await ctx.db.query('roomMembers').withIndex('by_room', q => q.eq('roomId', roomId)).collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: 'owner', userId });
      expect((await ctx.db.get(rows[0]!.participantId))!.kind).toBe('human');
      expect((await ctx.db.get(rows[0]!.participantId))!.userId).toBe(userId);
    }
    expect(await ctx.db.query('users').collect()).toHaveLength(1);
  });
  expect((await owner.query(api.me.get, {}))).toMatchObject({ isOwner: true, userId });
});

test('rooms.list keeps the fields the phone reads for the owner', async () => {
  const { owner, roomId, otherRoomId } = await setup();
  const rooms = await owner.query(api.rooms.list, {});
  expect(rooms.map(r => r._id)).toEqual([otherRoomId, roomId]);
  for (const room of rooms) {
    expect(Object.keys(room).sort()).toEqual(['_creationTime', '_id', 'cwd', 'handbook', 'name', 'readyReviews', 'role', 'runnerId']);
    expect(room.role).toBe('owner');
    expect(room.readyReviews).toBe(0);
  }
});
