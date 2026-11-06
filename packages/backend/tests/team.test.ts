import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
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
import schema from "../convex/schema";
import * as team from "../convex/team";

const modules = import.meta.glob("../convex/**/*.ts");

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
    harnesses: [{ id: "claude", version: "test" }],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => await Promise.resolve(Response.json([{ id: "user_1" }])))
  );
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const [, token] = invite.url.split("/invite/");
  assert(token !== undefined, "invite url has a token");
  await dana.mutation(api.invites.accept, { token });
  const room = await owner.query(api.rooms.get, { roomId });
  assert(room, "owner can read the room");
  const robert = room.participants.find((p) => p.displayName === "Robert");
  const danaParticipant = room.participants.find(
    (p) => p.displayName === "Dana"
  );
  assert(robert, "Robert has a participant");
  assert(danaParticipant, "Dana has a participant");
  return { dana, danaParticipant, eve, owner, robert, roomId, t };
};

describe("team chat", () => {
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

  it("the owner and a member can post and both read the team chat, with authors and a ledger row per post", async () => {
    const { t, owner, dana, roomId, robert, danaParticipant } = await setup();
    const first = await owner.mutation(api.team.post, {
      body: "  between us, is this too big?  ",
      roomId,
    });
    vi.advanceTimersByTime(1000);
    const second = await dana.mutation(api.team.post, {
      body: "TEAM-ONLY-TOKEN yes",
      roomId,
    });

    const lists = await Promise.all(
      [owner, dana].map(
        async (caller) => await caller.query(api.team.list, { roomId })
      )
    );
    const expected = [
      [first, robert._id, "between us, is this too big?"],
      [second, danaParticipant._id, "TEAM-ONLY-TOKEN yes"],
    ];
    expect(
      lists.map((list) =>
        list.map((m) => [m._id, m.authorParticipantId, m.body])
      )
    ).toStrictEqual([expected, expected]);

    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      const posted = ledger.filter((e) => e.type === "team_message.posted");
      expect(
        posted.map((e): unknown[] => [
          e.actorParticipantId,
          e.subjectId,
          e.payload,
        ])
      ).toStrictEqual([
        [robert._id, first, { messageId: first }],
        [danaParticipant._id, second, { messageId: second }],
      ]);
      expect(JSON.stringify(posted)).not.toContain("TEAM-ONLY-TOKEN");
      const messages = await ctx.db.query("messages").collect();
      expect(JSON.stringify(messages)).not.toContain("TEAM-ONLY-TOKEN");
      const turns = await ctx.db.query("turns").collect();
      expect(JSON.stringify(turns)).not.toContain("TEAM-ONLY-TOKEN");
      const row = await ctx.db.get(second);
      assert(row, "the second team message exists");
      expect(row.authorUserId).toBe(danaParticipant.userId);
    });
    const timeline = await owner.query(api.messages.timeline, { roomId });
    expect(JSON.stringify(timeline)).not.toContain("TEAM-ONLY-TOKEN");
  });

  it("a non-member and a removed member can neither post nor read", async () => {
    const { owner, dana, eve, roomId } = await setup();
    await owner.mutation(api.team.post, { body: "hello", roomId });
    await expect(eve.query(api.team.list, { roomId })).rejects.toThrow(
      "Not a member of this room"
    );
    await expect(
      eve.mutation(api.team.post, { body: "let me in", roomId })
    ).rejects.toThrow("Not a member of this room");

    const { members } = await owner.query(api.members.list, { roomId });
    const member = members.find((m) => m.role === "member");
    assert(member, "Dana is listed as a member");
    await owner.mutation(api.members.remove, { memberId: member._id });
    await expect(dana.query(api.team.list, { roomId })).rejects.toThrow(
      "You are no longer a member of this room"
    );
    await expect(
      dana.mutation(api.team.post, { body: "still here?", roomId })
    ).rejects.toThrow("You are no longer a member of this room");
    const list = await owner.query(api.team.list, { roomId });
    expect(list.map((m) => m.body)).toStrictEqual(["hello"]);
  });

  it("an empty or whitespace-only post is rejected", async () => {
    const { owner, dana, roomId } = await setup();
    await expect(
      owner.mutation(api.team.post, { body: "", roomId })
    ).rejects.toThrow("Empty message");
    await expect(
      dana.mutation(api.team.post, { body: " \n\t ", roomId })
    ).rejects.toThrow("Empty message");
    await expect(owner.query(api.team.list, { roomId })).resolves.toStrictEqual(
      []
    );
  });

  it("team messages cannot be edited or deleted: only list and post exist", () => {
    expect(Object.keys(team).toSorted()).toStrictEqual(["list", "post"]);
  });
});
