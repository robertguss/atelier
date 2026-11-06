import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
  process.env.ATELIER_RUNNER_SECRET = "test-secret";
  process.env.CLERK_SECRET_KEY = "sk_test";
  process.env.ATELIER_WEB_URL = "https://atelier.example.com/";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A fake Clerk Backend API. `existing` lists emails that already have accounts.
function mockClerk(existing: string[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method,
      url,
    });
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk_test"
    );
    if (method === "GET" && url.startsWith("https://api.clerk.com/v1/users?")) {
      const email = new URL(url).searchParams.get("email_address");
      return Response.json(existing.includes(email!) ? [{ id: "user_1" }] : []);
    }
    if (method === "POST" && url === "https://api.clerk.com/v1/invitations") {
      return Response.json({ id: `inv_${calls.length}` });
    }
    if (method === "POST" && /\/v1\/invitations\/[^/]+\/revoke$/.test(url)) {
      return Response.json({ status: "revoked" });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    name: "Robert",
    subject: "owner",
  });
  const dana = t.withIdentity({
    email: "dana@example.com",
    name: "Dana",
    subject: "dana",
  });
  const eve = t.withIdentity({
    email: "eve@example.com",
    name: "Eve",
    subject: "eve",
  });
  const runnerId = await t.mutation(api.runners.heartbeat, {
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
  const otherRoomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/other",
    name: "Other",
    runnerId,
  });
  return { dana, eve, otherRoomId, owner, roomId, runnerId, t };
}

function tokenOf(url: string) {
  return url.split("/invite/")[1]!;
}

test("an invited teammate joins one room, sees only it, and has no owner powers", async () => {
  const { t, owner, dana, runnerId, roomId, otherRoomId } = await setup();
  const calls = mockClerk();
  await expect(dana.query(api.rooms.list, {})).resolves.toEqual([]);
  await expect(dana.query(api.rooms.access, { roomId })).resolves.toBe("none");

  const invite = await owner.action(api.invites.create, {
    email: " Dana@Example.com ",
    roomId,
  });
  expect(invite.emailed).toBe(true);
  expect(invite.url).toMatch(
    /^https:\/\/atelier\.example\.com\/invite\/[\w-]{40,}$/
  );
  const clerkInvite = calls.find((c) => c.method === "POST")!;
  expect(clerkInvite.body).toMatchObject({
    email_address: "dana@example.com",
    redirect_url: invite.url,
  });
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("roomInvites").collect())[0]!;
    expect(JSON.stringify(row)).not.toContain(tokenOf(invite.url));
    expect(row.expiresAt - Date.now()).toBe(7 * DAY);
  });

  await expect(
    dana.query(api.invites.lookup, { token: tokenOf(invite.url) })
  ).resolves.toMatchObject({
    email: "d***@example.com",
    matches: true,
    roomName: "Planning",
    status: "pending",
  });
  await expect(
    dana.mutation(api.invites.accept, { token: tokenOf(invite.url) })
  ).resolves.toEqual({ ok: true, roomId });
  await expect(
    dana.query(api.invites.lookup, { token: tokenOf(invite.url) })
  ).resolves.toMatchObject({ status: "accepted" });

  const list = await dana.query(api.rooms.list, {});
  expect(list.map((r) => [r._id, r.role])).toEqual([[roomId, "member"]]);
  await expect(dana.query(api.rooms.access, { roomId })).resolves.toBe(
    "member"
  );
  await expect(
    dana.query(api.rooms.access, { roomId: otherRoomId })
  ).resolves.toBe("none");
  await expect(
    dana.query(api.rooms.access, { roomId: "not-an-id" })
  ).resolves.toBe("none");
  await expect(owner.query(api.rooms.access, { roomId })).resolves.toBe(
    "owner"
  );
  expect((await dana.query(api.rooms.get, { roomId }))!.room.name).toBe(
    "Planning"
  );
  await expect(
    dana.query(api.rooms.get, { roomId: otherRoomId })
  ).rejects.toThrow();

  const room = await owner.query(api.rooms.get, { roomId });
  const human = room!.participants.find(
    (p) => p.kind === "human" && p.displayName === "Dana"
  )!;
  const me = await dana.query(api.me.get, {});
  expect(me).toMatchObject({ isOwner: false, signedIn: true });
  expect(human.userId).toBe((me as { userId: Id<"users"> }).userId);
  const claude = room!.participants.find((p) => p.harness === "claude")!;

  await expect(
    dana.mutation(api.rooms.addParticipant, { harness: "pi", roomId })
  ).rejects.toThrow();
  await expect(
    dana.mutation(api.rituals.begin, {
      participantIds: [claude._id],
      request: "Review",
      roomId,
    })
  ).rejects.toThrow();
  await expect(
    dana.action(api.invites.create, { email: "friend@example.com", roomId })
  ).rejects.toThrow();
  await expect(
    dana.mutation(api.rooms.create, { cwd: "/tmp", name: "Mine", runnerId })
  ).rejects.toThrow();

  await t.run(async (ctx) => {
    const joined = (await ctx.db.query("ledger").collect()).filter(
      (e) => e.type === "member.joined"
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.actorParticipantId).toBe(human._id);
  });
});

test("the join notice is stored by version on the member row", async () => {
  const { owner, dana, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
  const before = await dana.query(api.members.notice, { roomId });
  expect(before.acceptedVersion).toBeNull();
  await expect(
    dana.mutation(api.members.acceptNotice, {
      roomId,
      version: before.currentVersion - 1,
    })
  ).rejects.toThrow();
  await dana.mutation(api.members.acceptNotice, {
    roomId,
    version: before.currentVersion,
  });
  await expect(dana.query(api.members.notice, { roomId })).resolves.toEqual({
    acceptedVersion: before.currentVersion,
    currentVersion: before.currentVersion,
  });
});

test("an invite for another address shows the masked address and cannot be accepted", async () => {
  const { t, owner, eve, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const token = tokenOf(invite.url);
  await expect(eve.query(api.invites.lookup, { token })).resolves.toMatchObject(
    {
      email: "d***@example.com",
      matches: false,
      roomName: "Planning",
      status: "pending",
    }
  );
  await expect(eve.mutation(api.invites.accept, { token })).resolves.toEqual({
    ok: false,
    reason: "email_mismatch",
  });
  await expect(eve.query(api.rooms.access, { roomId })).resolves.toBe("none");
  await t.run(async (ctx) => {
    expect((await ctx.db.query("roomInvites").collect())[0]!.status).toBe(
      "pending"
    );
  });
});

test("an unknown token reveals nothing", async () => {
  const { owner, dana, roomId } = await setup();
  mockClerk();
  await owner.action(api.invites.create, { email: "dana@example.com", roomId });
  await expect(
    dana.query(api.invites.lookup, { token: "made-up-token" })
  ).resolves.toBeNull();
  await expect(
    dana.mutation(api.invites.accept, { token: "made-up-token" })
  ).resolves.toEqual({ ok: false, reason: "not_found" });
});

test("expired and revoked invites are rejected and the row says why", async () => {
  const { t, owner, dana, roomId, otherRoomId } = await setup();
  const calls = mockClerk();
  const expiring = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const revoked = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId: otherRoomId,
  });

  await owner.action(api.invites.revoke, { inviteId: revoked.inviteId });
  const clerkRevoke = calls.find((c) => c.url.endsWith("/revoke"))!;
  const clerkInvites = calls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/invitations")
  );
  expect(clerkInvites).toHaveLength(2);
  expect(clerkRevoke.url).toBe(
    `https://api.clerk.com/v1/invitations/inv_${calls.indexOf(clerkInvites[1]!) + 1}/revoke`
  );
  await expect(
    dana.query(api.invites.lookup, { token: tokenOf(revoked.url) })
  ).resolves.toMatchObject({ status: "revoked" });
  await expect(
    dana.mutation(api.invites.accept, { token: tokenOf(revoked.url) })
  ).resolves.toEqual({ ok: false, reason: "revoked" });

  vi.setSystemTime(Date.now() + 7 * DAY + 1);
  await expect(
    dana.query(api.invites.lookup, { token: tokenOf(expiring.url) })
  ).resolves.toMatchObject({ status: "expired" });
  await expect(
    dana.mutation(api.invites.accept, { token: tokenOf(expiring.url) })
  ).resolves.toEqual({ ok: false, reason: "expired" });

  await t.run(async (ctx) => {
    const rows = await ctx.db.query("roomInvites").collect();
    expect(rows.find((r) => r._id === expiring.inviteId)!.status).toBe(
      "expired"
    );
    expect(rows.find((r) => r._id === revoked.inviteId)!.status).toBe(
      "revoked"
    );
    await expect(ctx.db.query("roomMembers").collect()).resolves.toHaveLength(
      2
    );
  });
  await expect(dana.query(api.rooms.list, {})).resolves.toEqual([]);
});

test("a second-room invite for an existing account adds a member row without a Clerk invitation", async () => {
  const { t, owner, dana, roomId, otherRoomId } = await setup();
  const calls = mockClerk(["dana@example.com"]);
  const first = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const second = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId: otherRoomId,
  });
  expect(first.emailed).toBe(false);
  expect(second.emailed).toBe(false);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await dana.mutation(api.invites.accept, { token: tokenOf(first.url) });
  await dana.mutation(api.invites.accept, { token: tokenOf(second.url) });
  expect((await dana.query(api.rooms.list, {})).map((r) => r.role)).toEqual([
    "member",
    "member",
  ]);
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const danaUser = users.find((u) => u.email === "dana@example.com")!;
    await expect(
      ctx.db
        .query("roomMembers")
        .withIndex("by_user", (q) => q.eq("userId", danaUser._id))
        .collect()
    ).resolves.toHaveLength(2);
  });
});

test("removing a member ends access at once and keeps their messages", async () => {
  const { t, owner, dana, roomId } = await setup();
  mockClerk();
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
  const { members } = await owner.query(api.members.list, { roomId });
  const member = members.find((m) => m.role === "member")!;
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      authorParticipantId: member.participantId,
      body: "Dana was here",
      roomId,
      visibility: "room",
    });
  });
  await expect(
    dana.mutation(api.members.remove, { memberId: member._id })
  ).rejects.toThrow();

  await owner.mutation(api.members.remove, { memberId: member._id });
  await expect(dana.query(api.rooms.get, { roomId })).rejects.toThrow();
  await expect(dana.query(api.rooms.access, { roomId })).resolves.toBe(
    "removed"
  );
  await expect(dana.query(api.rooms.list, {})).resolves.toEqual([]);
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).toContain("Dana was here");
  expect(
    (await owner.query(api.members.list, { roomId })).members.map((m) => m.role)
  ).toEqual(["owner"]);
  await t.run(async (ctx) => {
    const removed = (await ctx.db.query("ledger").collect()).filter(
      (e) => e.type === "member.removed"
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]!.subjectId).toBe(member._id);
  });
  const ownerMember = (await owner.query(api.members.list, { roomId }))
    .members[0]!;
  await expect(
    owner.mutation(api.members.remove, { memberId: ownerMember._id })
  ).rejects.toThrow();
});

test("a removed teammate rejoins through a new invite, and a repeat accept only lets her back in", async () => {
  const { t, owner, dana, roomId } = await setup();
  mockClerk();
  const first = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await dana.mutation(api.invites.accept, { token: tokenOf(first.url) });
  const member = (await owner.query(api.members.list, { roomId })).members.find(
    (m) => m.role === "member"
  )!;
  await owner.mutation(api.members.remove, { memberId: member._id });
  await owner.mutation(api.members.remove, { memberId: member._id });
  await t.run(async (ctx) => {
    expect(
      (await ctx.db.query("ledger").collect()).filter(
        (e) => e.type === "member.removed"
      )
    ).toHaveLength(1);
  });

  const second = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await expect(
    dana.mutation(api.invites.accept, { token: tokenOf(second.url) })
  ).resolves.toEqual({ ok: true, roomId });
  await expect(dana.query(api.rooms.access, { roomId })).resolves.toBe(
    "member"
  );
  await t.run(async (ctx) => {
    const rows = (
      await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .collect()
    ).filter((m) => m.role === "member");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.removedAt).toBeUndefined();
    const joined = (await ctx.db.query("ledger").collect()).filter(
      (e) =>
        e.type === "member.joined" && e.payload?.inviteId === second.inviteId
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.subjectId).toBe(member._id);
  });

  await expect(
    dana.mutation(api.invites.accept, { token: tokenOf(second.url) })
  ).resolves.toEqual({ ok: true, roomId });
  const otherDana = t.withIdentity({
    email: "dana@example.com",
    name: "Other Dana",
    subject: "dana-2",
  });
  await expect(
    otherDana.mutation(api.invites.accept, { token: tokenOf(second.url) })
  ).resolves.toEqual({ ok: false, reason: "accepted" });
  await expect(otherDana.query(api.rooms.access, { roomId })).resolves.toBe(
    "none"
  );
});

test("a revoke whose Clerk call failed can be retried until Clerk revokes the invitation", async () => {
  const { t, owner, roomId } = await setup();
  const calls = mockClerk();
  const clerkFetch = globalThis.fetch;
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const clerkInvitationId = (await t.run(async (ctx) =>
    ctx.db.get(invite.inviteId)
  ))!.clerkInvitationId!;
  expect(clerkInvitationId).toBeTruthy();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("down", { status: 503 }))
  );
  await expect(
    owner.action(api.invites.revoke, { inviteId: invite.inviteId })
  ).rejects.toThrow(/503/);
  await expect(
    t.run(async (ctx) => ctx.db.get(invite.inviteId))
  ).resolves.toMatchObject({
    clerkInvitationId,
    status: "revoked",
  });

  vi.stubGlobal("fetch", clerkFetch);
  await owner.action(api.invites.revoke, { inviteId: invite.inviteId });
  expect(
    calls.filter(
      (c) =>
        c.url ===
        `https://api.clerk.com/v1/invitations/${clerkInvitationId}/revoke`
    )
  ).toHaveLength(1);
  expect(
    (await t.run(async (ctx) => ctx.db.get(invite.inviteId)))!.clerkInvitationId
  ).toBeUndefined();
  await t.run(async (ctx) => {
    expect(
      (await ctx.db.query("ledger").collect()).filter(
        (e) => e.type === "invite.revoked"
      )
    ).toHaveLength(1);
  });
});

test("the owner backfill links existing rooms once, however often it runs", async () => {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    name: "Robert",
    subject: "owner",
  });
  const roomIds = await t.run(async (ctx) => {
    const runnerId = await ctx.db.insert("runners", {
      harnesses: [],
      lastHeartbeatAt: 0,
      machine: "test",
      name: "test",
    });
    const ids = [];
    for (const name of ["Legacy A", "Legacy B"]) {
      const roomId = await ctx.db.insert("rooms", {
        cwd: "/tmp",
        handbook: "",
        name,
        runnerId,
      });
      await ctx.db.insert("participants", {
        displayName: "Robert",
        kind: "human",
        roomId,
      });
      await ctx.db.insert("participants", {
        displayName: "Claude",
        harness: "claude",
        kind: "harness",
        roomId,
      });
      ids.push(roomId);
    }
    return ids;
  });
  await expect(owner.query(api.rooms.list, {})).resolves.toEqual([]);
  const userId = await owner.mutation(api.users.ensure, {});
  await expect(owner.mutation(api.users.ensure, {})).resolves.toBe(userId);
  await t.run(async (ctx) => {
    for (const roomId of roomIds) {
      const rows = await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: "owner", userId });
      expect((await ctx.db.get(rows[0]!.participantId))!.kind).toBe("human");
      expect((await ctx.db.get(rows[0]!.participantId))!.userId).toBe(userId);
    }
    await expect(ctx.db.query("users").collect()).resolves.toHaveLength(1);
  });
  await expect(owner.query(api.me.get, {})).resolves.toMatchObject({
    isOwner: true,
    userId,
  });
});

test("rooms.list keeps the fields the phone reads for the owner", async () => {
  const { owner, roomId, otherRoomId } = await setup();
  const rooms = await owner.query(api.rooms.list, {});
  expect(rooms.map((r) => r._id)).toEqual([otherRoomId, roomId]);
  for (const room of rooms) {
    expect(Object.keys(room).sort()).toEqual([
      "_creationTime",
      "_id",
      "cwd",
      "handbook",
      "name",
      "readyReviews",
      "role",
      "runnerId",
    ]);
    expect(room.role).toBe("owner");
    expect(room.readyReviews).toBe(0);
  }
});
