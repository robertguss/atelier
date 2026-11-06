import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";
const HARNESSES = [
  { id: "claude" as const, version: "test" },
  { id: "codex" as const, version: "test" },
  { id: "pi" as const, version: "test" },
];

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
  process.env.ATELIER_RUNNER_SECRET = SECRET;
  process.env.CLERK_SECRET_KEY = "sk_test";
  process.env.ATELIER_WEB_URL = "https://atelier.example.com/";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof convexTest>;

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
  const runnerId = await t.mutation(api.runners.heartbeat, {
    harnesses: HARNESSES,
    machine: "test",
    name: "test",
    secret: SECRET,
  });
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
  await owner.mutation(api.rooms.addParticipant, { harness: "codex", roomId });
  await owner.mutation(api.rooms.addParticipant, { harness: "pi", roomId });
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
  vi.unstubAllGlobals();
  const { participants } = (await owner.query(api.rooms.get, { roomId }))!;
  const claude = participants.find((p) => p.harness === "claude")!;
  const codex = participants.find((p) => p.harness === "codex")!;
  const pi = participants.find((p) => p.harness === "pi")!;
  return { claude, codex, dana, owner, pi, roomId, t };
}

async function allCommands(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("commands").collect());
}

async function runningTurn(
  s: Awaited<ReturnType<typeof setup>>,
  participantId: Id<"participants">
) {
  const turnId = (await s.owner.mutation(api.messages.send, {
    body: "Write the plan file",
    roomId: s.roomId,
    toParticipantId: participantId,
  }))!;
  const command = (await allCommands(s.t)).find(
    (c) => c.turnId === turnId && c.type === "run_turn"
  )!;
  await s.t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await s.t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId,
  });
  return turnId;
}

async function controlCommands(t: T, turnId: Id<"turns">) {
  return (await allCommands(t)).filter(
    (c) => c.turnId === turnId && c.type !== "run_turn"
  );
}

test("only the owner can set the edit switch, and both people see it", async () => {
  const s = await setup();
  await expect(
    s.dana.mutation(api.rooms.setEditsEnabled, { on: true, roomId: s.roomId })
  ).rejects.toThrow(/owner/i);
  expect(
    (await s.dana.query(api.agent.pane, { roomId: s.roomId })).editsEnabled
  ).toBe(false);

  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  expect(
    (await s.dana.query(api.agent.pane, { roomId: s.roomId })).editsEnabled
  ).toBe(true);
  const changes = (
    await s.t.run(async (ctx) => ctx.db.query("ledger").collect())
  ).filter((e) => e.type === "room.edits_changed");
  expect(changes).toHaveLength(1);
  expect(changes[0]!.payload).toEqual({ editsEnabled: true });
});

test("turning edits on mid-turn sends settings to a running Claude turn without interrupting it", async () => {
  const s = await setup();
  const turnId = await runningTurn(s, s.claude._id);
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  const commands = await controlCommands(s.t, turnId);
  expect(commands.map((c) => [c.type, c.payload])).toEqual([
    ["settings", { editsEnabled: true }],
  ]);
  const job = await s.t.mutation(api.runner.claim, {
    commandId: commands[0]!._id,
    secret: SECRET,
  });
  expect(job).toMatchObject({
    payload: { editsEnabled: true },
    turn: { id: turnId },
    type: "settings",
  });
});

test("turning edits off mid-turn interrupts running Codex and Pi turns and sends settings to Claude", async () => {
  const s = await setup();
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  const claudeTurn = await runningTurn(s, s.claude._id);
  const codexTurn = await runningTurn(s, s.codex._id);
  const piTurn = await runningTurn(s, s.pi._id);

  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: false,
    roomId: s.roomId,
  });
  expect((await controlCommands(s.t, claudeTurn)).map((c) => c.type)).toEqual([
    "settings",
  ]);
  for (const turnId of [codexTurn, piTurn]) {
    const types = (await controlCommands(s.t, turnId)).map((c) => c.type);
    expect(types).toContain("interrupt");
    expect(types).toContain("settings");
  }
});

test("a new turn's edit snapshot matches the room when it is dispatched and claimed", async () => {
  const s = await setup();
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  const turnId = (await s.owner.mutation(api.messages.send, {
    body: "Go",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  }))!;
  expect((await s.t.run(async (ctx) => ctx.db.get(turnId)))!.editsEnabled).toBe(
    true
  );
  const command = (await allCommands(s.t)).find(
    (c) => c.turnId === turnId && c.type === "run_turn"
  )!;
  const job = await s.t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  expect(job!.room.editsEnabled).toBe(true);

  // Switched off between dispatch and claim: the claim carries the room's value now.
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: false,
    roomId: s.roomId,
  });
  const second = (await s.owner.mutation(api.messages.send, {
    body: "Next",
    roomId: s.roomId,
    toParticipantId: s.pi._id,
  }))!;
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  const secondCommand = (await allCommands(s.t)).find(
    (c) => c.turnId === second && c.type === "run_turn"
  )!;
  const secondJob = await s.t.mutation(api.runner.claim, {
    commandId: secondCommand._id,
    secret: SECRET,
  });
  expect(secondJob!.room.editsEnabled).toBe(true);
  expect((await s.t.run(async (ctx) => ctx.db.get(second)))!.editsEnabled).toBe(
    true
  );
  // A queued turn gets no control commands; the claim carries the value.
  await expect(controlCommands(s.t, second)).resolves.toHaveLength(0);

  // Switched off between claim and start: start returns the room's value now.
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: false,
    roomId: s.roomId,
  });
  await expect(
    s.t.mutation(api.runner.start, {
      secret: SECRET,
      turnId: second,
      harnessVersion: "test",
    })
  ).resolves.toEqual({ editsEnabled: false });
  expect((await s.t.run(async (ctx) => ctx.db.get(second)))!.editsEnabled).toBe(
    false
  );
});

test("a Codex turn that started with edits off is not interrupted when edits go on then off", async () => {
  const s = await setup();
  const codexTurn = await runningTurn(s, s.codex._id);
  expect(
    (await s.t.run(async (ctx) => ctx.db.get(codexTurn)))!.editsEnabled
  ).toBe(false);
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: true,
    roomId: s.roomId,
  });
  await s.owner.mutation(api.rooms.setEditsEnabled, {
    on: false,
    roomId: s.roomId,
  });
  expect(
    (await controlCommands(s.t, codexTurn)).map((c) => [c.type, c.payload])
  ).toEqual([
    ["settings", { editsEnabled: true }],
    ["settings", { editsEnabled: false }],
  ]);
});
