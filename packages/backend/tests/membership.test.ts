/// <reference types="vite/client" />
import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const DAY = 24 * 60 * 60 * 1000;

type T = TestConvex<typeof schema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The message a call was rejected with, or "resolved" if it was not rejected.
const rejectionOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    assert(error instanceof Error, "the call rejected with an Error");
    return error.message;
  }
  return "resolved";
};

// A fake Clerk Backend API. `existing` lists emails that already have accounts.
const mockClerk = (existing: string[] = []) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn<
    (input: string | URL, init?: RequestInit) => Promise<Response>
  >(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    calls.push({
      body:
        typeof rawBody === "string" && rawBody !== ""
          ? (JSON.parse(rawBody) as unknown)
          : undefined,
      method,
      url,
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer sk_test"
    );
    if (method === "GET" && url.startsWith("https://api.clerk.com/v1/users?")) {
      const email = new URL(url).searchParams.get("email_address");
      return await Promise.resolve(
        Response.json(
          email !== null && existing.includes(email) ? [{ id: "user_1" }] : []
        )
      );
    }
    if (method === "POST" && url === "https://api.clerk.com/v1/invitations") {
      return await Promise.resolve(
        Response.json({ id: `inv_${calls.length}` })
      );
    }
    if (method === "POST" && /\/v1\/invitations\/[^/]+\/revoke$/u.test(url)) {
      return await Promise.resolve(Response.json({ status: "revoked" }));
    }
    return await Promise.resolve(new Response("unexpected", { status: 500 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

const setup = async () => {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
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
};

const tokenOf = (url: string) => {
  const [, token] = url.split("/invite/");
  assert(token !== undefined, "invite url has a token");
  return token;
};

const getInvite = async (t: T, inviteId: Id<"roomInvites">) => {
  const invite = await t.run(async (ctx) => await ctx.db.get(inviteId));
  assert(invite, "the invite exists");
  return invite;
};

describe("room membership", () => {
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

  it("an invited teammate joins one room, sees only it, and has no owner powers", async () => {
    const { t, owner, dana, runnerId, roomId, otherRoomId } = await setup();
    const calls = mockClerk();
    const roomsBefore = await dana.query(api.rooms.list, {});
    const accessBefore = await dana.query(api.rooms.access, { roomId });

    const invite = await owner.action(api.invites.create, {
      email: " Dana@Example.com ",
      roomId,
    });
    const clerkInvite = calls.find((c) => c.method === "POST");
    assert(clerkInvite, "a Clerk invitation was created");
    const token = tokenOf(invite.url);
    const storedRow = await t.run(async (ctx) => {
      const [row] = await ctx.db.query("roomInvites").collect();
      assert(row, "the invite is stored");
      return {
        expiresIn: row.expiresAt - Date.now(),
        leaksToken: JSON.stringify(row).includes(token),
      };
    });
    expect({
      before: { access: accessBefore, rooms: roomsBefore },
      clerkBody: clerkInvite.body,
      emailed: invite.emailed,
      storedRow,
      urlIsInviteLink:
        /^https:\/\/atelier\.example\.com\/invite\/[\w-]{40,}$/u.test(
          invite.url
        ),
    }).toMatchObject({
      before: { access: "none", rooms: [] },
      clerkBody: {
        email_address: "dana@example.com",
        redirect_url: invite.url,
      },
      emailed: true,
      storedRow: { expiresIn: 7 * DAY, leaksToken: false },
      urlIsInviteLink: true,
    });

    const lookupBefore = await dana.query(api.invites.lookup, { token });
    const accepted = await dana.mutation(api.invites.accept, { token });
    const lookupAfter = await dana.query(api.invites.lookup, { token });

    const list = await dana.query(api.rooms.list, {});
    const danaRoom = await dana.query(api.rooms.get, { roomId });
    const room = await owner.query(api.rooms.get, { roomId });
    assert(room, "owner can read the room");
    const human = room.participants.find(
      (p) => p.kind === "human" && p.displayName === "Dana"
    );
    assert(human, "Dana has a participant");
    const me = await dana.query(api.me.get, {});
    expect({ lookupAfter, lookupBefore, me }).toMatchObject({
      lookupAfter: { status: "accepted" },
      lookupBefore: {
        email: "d***@example.com",
        matches: true,
        roomName: "Planning",
        status: "pending",
      },
      me: { isOwner: false, signedIn: true, userId: human.userId },
    });
    const claude = room.participants.find((p) => p.harness === "claude");
    assert(claude, "room has a Claude participant");
    const joined = await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      return ledger
        .filter((e) => e.type === "member.joined")
        .map((e) => e.actorParticipantId);
    });
    expect({
      accepted,
      access: {
        invalid: await dana.query(api.rooms.access, { roomId: "not-an-id" }),
        member: await dana.query(api.rooms.access, { roomId }),
        other: await dana.query(api.rooms.access, { roomId: otherRoomId }),
        owner: await owner.query(api.rooms.access, { roomId }),
      },
      joined,
      list: list.map((r) => [r._id, r.role]),
      roomName: danaRoom?.room.name,
    }).toStrictEqual({
      accepted: { ok: true, roomId },
      access: {
        invalid: "none",
        member: "member",
        other: "none",
        owner: "owner",
      },
      joined: [human._id],
      list: [[roomId, "member"]],
      roomName: "Planning",
    });

    const refusals = [
      await rejectionOf(dana.query(api.rooms.get, { roomId: otherRoomId })),
      await rejectionOf(
        dana.mutation(api.rooms.addParticipant, { harness: "pi", roomId })
      ),
      await rejectionOf(
        dana.mutation(api.rituals.begin, {
          participantIds: [claude._id],
          request: "Review",
          roomId,
        })
      ),
      await rejectionOf(
        dana.action(api.invites.create, { email: "friend@example.com", roomId })
      ),
      await rejectionOf(
        dana.mutation(api.rooms.create, { cwd: "/tmp", name: "Mine", runnerId })
      ),
    ];
    expect(refusals).toStrictEqual([
      "Not a member of this room",
      "Not signed in as the Atelier owner",
      "Not signed in as the Atelier owner",
      "Not signed in as the Atelier owner",
      "Not signed in as the Atelier owner",
    ]);
  });

  it("the join notice is stored by version on the member row", async () => {
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
    ).rejects.toThrow("The notice has changed; read it again");
    await dana.mutation(api.members.acceptNotice, {
      roomId,
      version: before.currentVersion,
    });
    await expect(
      dana.query(api.members.notice, { roomId })
    ).resolves.toStrictEqual({
      acceptedVersion: before.currentVersion,
      currentVersion: before.currentVersion,
    });
  });

  it("a teammate who accepted the first notice must accept the current one before entering", async () => {
    const { t, owner, dana, roomId } = await setup();
    mockClerk();
    const invite = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("roomMembers").collect();
      const row = rows.find((m) => m.role === "member");
      assert(row, "the teammate has a member row");
      await ctx.db.patch(row._id, {
        noticeAcceptedAt: Date.now(),
        noticeVersion: 1,
      });
    });

    await expect(
      dana.query(api.members.notice, { roomId })
    ).resolves.toStrictEqual({ acceptedVersion: 1, currentVersion: 2 });
    await expect(
      dana.mutation(api.members.acceptNotice, { roomId, version: 1 })
    ).rejects.toThrow(/notice has changed/u);
    await dana.mutation(api.members.acceptNotice, { roomId, version: 2 });
    await expect(
      dana.query(api.members.notice, { roomId })
    ).resolves.toStrictEqual({ acceptedVersion: 2, currentVersion: 2 });
  });

  it("an invite for another address shows the masked address and cannot be accepted", async () => {
    const { t, owner, eve, roomId } = await setup();
    mockClerk();
    const invite = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    const token = tokenOf(invite.url);
    await expect(
      eve.query(api.invites.lookup, { token })
    ).resolves.toMatchObject({
      email: "d***@example.com",
      matches: false,
      roomName: "Planning",
      status: "pending",
    });
    await expect(
      eve.mutation(api.invites.accept, { token })
    ).resolves.toStrictEqual({
      ok: false,
      reason: "email_mismatch",
    });
    await expect(eve.query(api.rooms.access, { roomId })).resolves.toBe("none");
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("roomInvites").collect();
      expect(row?.status).toBe("pending");
    });
  });

  it("an unknown token reveals nothing", async () => {
    const { owner, dana, roomId } = await setup();
    mockClerk();
    await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    await expect(
      dana.query(api.invites.lookup, { token: "made-up-token" })
    ).resolves.toBeNull();
    await expect(
      dana.mutation(api.invites.accept, { token: "made-up-token" })
    ).resolves.toStrictEqual({ ok: false, reason: "not_found" });
  });

  it("expired and revoked invites are rejected and the row says why", async () => {
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
    const clerkRevoke = calls.find((c) => c.url.endsWith("/revoke"));
    assert(clerkRevoke, "Clerk was asked to revoke");
    const clerkInvites = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/invitations")
    );
    const [, revokedClerkInvite] = clerkInvites;
    assert(revokedClerkInvite, "the second invite reached Clerk");
    expect({
      clerkInvites: clerkInvites.length,
      revokeUrl: clerkRevoke.url,
    }).toStrictEqual({
      clerkInvites: 2,
      revokeUrl: `https://api.clerk.com/v1/invitations/inv_${calls.indexOf(revokedClerkInvite) + 1}/revoke`,
    });
    const lookupRevoked = await dana.query(api.invites.lookup, {
      token: tokenOf(revoked.url),
    });
    const acceptRevoked = await dana.mutation(api.invites.accept, {
      token: tokenOf(revoked.url),
    });

    vi.setSystemTime(Date.now() + 7 * DAY + 1);
    const lookupExpired = await dana.query(api.invites.lookup, {
      token: tokenOf(expiring.url),
    });
    const acceptExpired = await dana.mutation(api.invites.accept, {
      token: tokenOf(expiring.url),
    });
    expect({ lookupExpired, lookupRevoked }).toMatchObject({
      lookupExpired: { status: "expired" },
      lookupRevoked: { status: "revoked" },
    });

    const stored = await t.run(async (ctx) => {
      const rows = await ctx.db.query("roomInvites").collect();
      const members = await ctx.db.query("roomMembers").collect();
      return {
        expiring: rows.find((r) => r._id === expiring.inviteId)?.status,
        members: members.length,
        revoked: rows.find((r) => r._id === revoked.inviteId)?.status,
      };
    });
    expect({
      acceptExpired,
      acceptRevoked,
      danaRooms: await dana.query(api.rooms.list, {}),
      stored,
    }).toStrictEqual({
      acceptExpired: { ok: false, reason: "expired" },
      acceptRevoked: { ok: false, reason: "revoked" },
      danaRooms: [],
      stored: { expiring: "expired", members: 2, revoked: "revoked" },
    });
  });

  it("a second-room invite for an existing account adds a member row without a Clerk invitation", async () => {
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
    expect({
      first: first.emailed,
      second: second.emailed,
    }).toStrictEqual({ first: false, second: false });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await dana.mutation(api.invites.accept, { token: tokenOf(first.url) });
    await dana.mutation(api.invites.accept, { token: tokenOf(second.url) });
    const rooms = await dana.query(api.rooms.list, {});
    expect(rooms.map((r) => r.role)).toStrictEqual(["member", "member"]);
    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      const danaUser = users.find((u) => u.email === "dana@example.com");
      assert(danaUser, "Dana has a user row");
      await expect(
        ctx.db
          .query("roomMembers")
          .withIndex("by_user", (q) => q.eq("userId", danaUser._id))
          .collect()
      ).resolves.toHaveLength(2);
    });
  });

  it("removing a member ends access at once and keeps their messages", async () => {
    const { t, owner, dana, roomId } = await setup();
    mockClerk();
    const invite = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    await dana.mutation(api.invites.accept, { token: tokenOf(invite.url) });
    const { members } = await owner.query(api.members.list, { roomId });
    const member = members.find((m) => m.role === "member");
    assert(member, "Dana is a member");
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        authorParticipantId: member.participantId,
        body: "Dana was here",
        roomId,
        visibility: "room",
      });
    });
    const memberRemove = await rejectionOf(
      dana.mutation(api.members.remove, { memberId: member._id })
    );

    await owner.mutation(api.members.remove, { memberId: member._id });
    const removedGet = await rejectionOf(dana.query(api.rooms.get, { roomId }));
    expect({
      access: await dana.query(api.rooms.access, { roomId }),
      rooms: await dana.query(api.rooms.list, {}),
    }).toStrictEqual({ access: "removed", rooms: [] });
    expect(
      JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
    ).toContain("Dana was here");
    const afterRemoval = await owner.query(api.members.list, { roomId });
    const removed = await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      return ledger
        .filter((e) => e.type === "member.removed")
        .map((e) => e.subjectId);
    });
    expect({
      removed,
      roles: afterRemoval.members.map((m) => m.role),
    }).toStrictEqual({ removed: [member._id], roles: ["owner"] });
    const [ownerMember] = afterRemoval.members;
    assert(ownerMember, "the owner is still a member");
    const ownerRemove = await rejectionOf(
      owner.mutation(api.members.remove, { memberId: ownerMember._id })
    );
    expect({ memberRemove, ownerRemove, removedGet }).toStrictEqual({
      memberRemove: "Not signed in as the Atelier owner",
      ownerRemove: "The owner cannot be removed",
      removedGet: "You are no longer a member of this room",
    });
  });

  it("a removed teammate rejoins through a new invite, and a repeat accept only lets her back in", async () => {
    const { t, owner, dana, roomId } = await setup();
    mockClerk();
    const first = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    await dana.mutation(api.invites.accept, { token: tokenOf(first.url) });
    const { members } = await owner.query(api.members.list, { roomId });
    const member = members.find((m) => m.role === "member");
    assert(member, "Dana is a member");
    await owner.mutation(api.members.remove, { memberId: member._id });
    await owner.mutation(api.members.remove, { memberId: member._id });
    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      expect(ledger.filter((e) => e.type === "member.removed")).toHaveLength(1);
    });

    const second = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    expect({
      accepted: await dana.mutation(api.invites.accept, {
        token: tokenOf(second.url),
      }),
      access: await dana.query(api.rooms.access, { roomId }),
    }).toStrictEqual({ accepted: { ok: true, roomId }, access: "member" });
    await t.run(async (ctx) => {
      const roomMembers = await ctx.db
        .query("roomMembers")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .collect();
      const rows = roomMembers.filter((m) => m.role === "member");
      const ledger = await ctx.db.query("ledger").collect();
      const joined = ledger.filter(
        (e) =>
          e.type === "member.joined" &&
          isRecord(e.payload) &&
          e.payload.inviteId === second.inviteId
      );
      expect({
        joined: joined.map((e) => e.subjectId),
        removedAt: rows.map((m) => m.removedAt),
      }).toStrictEqual({ joined: [member._id], removedAt: [undefined] });
    });

    const repeatAccept = await dana.mutation(api.invites.accept, {
      token: tokenOf(second.url),
    });
    const otherDana = t.withIdentity({
      email: "dana@example.com",
      name: "Other Dana",
      subject: "dana-2",
    });
    expect({
      otherAccept: await otherDana.mutation(api.invites.accept, {
        token: tokenOf(second.url),
      }),
      otherAccess: await otherDana.query(api.rooms.access, { roomId }),
      repeatAccept,
    }).toStrictEqual({
      otherAccept: { ok: false, reason: "accepted" },
      otherAccess: "none",
      repeatAccept: { ok: true, roomId },
    });
  });

  it("a revoke whose Clerk call failed can be retried until Clerk revokes the invitation", async () => {
    const { t, owner, roomId } = await setup();
    const calls = mockClerk();
    const clerkFetch = globalThis.fetch;
    const invite = await owner.action(api.invites.create, {
      email: "dana@example.com",
      roomId,
    });
    const { clerkInvitationId } = await getInvite(t, invite.inviteId);
    assert(
      clerkInvitationId !== undefined && clerkInvitationId !== "",
      "the invite has a Clerk invitation id"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => await Promise.resolve(new Response("down", { status: 503 }))
      )
    );
    await expect(
      owner.action(api.invites.revoke, { inviteId: invite.inviteId })
    ).rejects.toThrow(/503/u);
    await expect(getInvite(t, invite.inviteId)).resolves.toMatchObject({
      clerkInvitationId,
      status: "revoked",
    });

    vi.stubGlobal("fetch", clerkFetch);
    await owner.action(api.invites.revoke, { inviteId: invite.inviteId });
    const revokedRow = await getInvite(t, invite.inviteId);
    const revokedEntries = await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      return ledger.filter((e) => e.type === "invite.revoked").length;
    });
    expect({
      clerkInvitationId: revokedRow.clerkInvitationId,
      clerkRevokes: calls.filter(
        (c) =>
          c.url ===
          `https://api.clerk.com/v1/invitations/${clerkInvitationId}/revoke`
      ).length,
      revokedEntries,
    }).toStrictEqual({
      clerkInvitationId: undefined,
      clerkRevokes: 1,
      revokedEntries: 1,
    });
  });

  it("the owner backfill links existing rooms once, however often it runs", async () => {
    const t = convexTest(schema, modules);
    registerWorkflow(t);
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
      const seedRoom = async (name: string) => {
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
        return roomId;
      };
      const legacyA = await seedRoom("Legacy A");
      const legacyB = await seedRoom("Legacy B");
      return [legacyA, legacyB];
    });
    await expect(owner.query(api.rooms.list, {})).resolves.toStrictEqual([]);
    const userId = await owner.mutation(api.users.ensure, {});
    await expect(owner.mutation(api.users.ensure, {})).resolves.toBe(userId);
    await t.run(async (ctx) => {
      const linked = await Promise.all(
        roomIds.map(async (roomId) => {
          const rows = await ctx.db
            .query("roomMembers")
            .withIndex("by_room", (q) => q.eq("roomId", roomId))
            .collect();
          const [row] = rows;
          assert(row, "the room has a member row");
          const participant = await ctx.db.get(row.participantId);
          return { participant, rows };
        })
      );
      expect(linked).toMatchObject(
        roomIds.map(() => ({
          participant: { kind: "human", userId },
          rows: [{ role: "owner", userId }],
        }))
      );
      await expect(ctx.db.query("users").collect()).resolves.toHaveLength(1);
    });
    await expect(owner.query(api.me.get, {})).resolves.toMatchObject({
      isOwner: true,
      userId,
    });
  });

  it("rooms.list keeps the fields the phone reads for the owner", async () => {
    const { owner, roomId, otherRoomId } = await setup();
    const rooms = await owner.query(api.rooms.list, {});
    expect(rooms.map((r) => r._id)).toStrictEqual([otherRoomId, roomId]);
    for (const room of rooms) {
      expect(Object.keys(room).toSorted()).toStrictEqual([
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
});
