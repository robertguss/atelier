import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import * as team from "../convex/team";

const modules = import.meta.glob("../convex/**/*.ts");

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
    vi.fn(async () => Response.json([{ id: "user_1" }]))
  );
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await dana.mutation(api.invites.accept, {
    token: invite.url.split("/invite/")[1]!,
  });
  const { participants } = (await owner.query(api.rooms.get, { roomId }))!;
  const robert = participants.find((p) => p.displayName === "Robert")!;
  const danaParticipant = participants.find((p) => p.displayName === "Dana")!;
  return { dana, danaParticipant, eve, owner, robert, roomId, t };
}

test("the owner and a member can post and both read the team chat, with authors and a ledger row per post", async () => {
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

  for (const caller of [owner, dana]) {
    const list = await caller.query(api.team.list, { roomId });
    expect(list.map((m) => [m._id, m.authorParticipantId, m.body])).toEqual([
      [first, robert._id, "between us, is this too big?"],
      [second, danaParticipant._id, "TEAM-ONLY-TOKEN yes"],
    ]);
  }

  await t.run(async (ctx) => {
    const posted = (await ctx.db.query("ledger").collect()).filter(
      (e) => e.type === "team_message.posted"
    );
    expect(
      posted.map((e) => [e.actorParticipantId, e.subjectId, e.payload])
    ).toEqual([
      [robert._id, first, { messageId: first }],
      [danaParticipant._id, second, { messageId: second }],
    ]);
    expect(JSON.stringify(posted)).not.toContain("TEAM-ONLY-TOKEN");
    expect(
      JSON.stringify(await ctx.db.query("messages").collect())
    ).not.toContain("TEAM-ONLY-TOKEN");
    expect(JSON.stringify(await ctx.db.query("turns").collect())).not.toContain(
      "TEAM-ONLY-TOKEN"
    );
    const row = (await ctx.db.get(second))!;
    expect(row.authorUserId).toBe(danaParticipant.userId);
  });
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).not.toContain("TEAM-ONLY-TOKEN");
});

test("a non-member and a removed member can neither post nor read", async () => {
  const { owner, dana, eve, roomId } = await setup();
  await owner.mutation(api.team.post, { body: "hello", roomId });
  await expect(eve.query(api.team.list, { roomId })).rejects.toThrow();
  await expect(
    eve.mutation(api.team.post, { body: "let me in", roomId })
  ).rejects.toThrow();

  const { members } = await owner.query(api.members.list, { roomId });
  await owner.mutation(api.members.remove, {
    memberId: members.find((m) => m.role === "member")!._id,
  });
  await expect(dana.query(api.team.list, { roomId })).rejects.toThrow();
  await expect(
    dana.mutation(api.team.post, { body: "still here?", roomId })
  ).rejects.toThrow();
  expect(
    (await owner.query(api.team.list, { roomId })).map((m) => m.body)
  ).toEqual(["hello"]);
});

test("an empty or whitespace-only post is rejected", async () => {
  const { owner, dana, roomId } = await setup();
  await expect(
    owner.mutation(api.team.post, { body: "", roomId })
  ).rejects.toThrow();
  await expect(
    dana.mutation(api.team.post, { body: " \n\t ", roomId })
  ).rejects.toThrow();
  await expect(owner.query(api.team.list, { roomId })).resolves.toEqual([]);
});

test("team messages cannot be edited or deleted: only list and post exist", () => {
  expect(Object.keys(team).sort()).toEqual(["list", "post"]);
});
