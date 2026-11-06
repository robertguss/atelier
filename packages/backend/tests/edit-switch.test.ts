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

const SECRET = "test-secret";
const HARNESSES = [
  { id: "claude" as const, version: "test" },
  { id: "codex" as const, version: "test" },
  { id: "pi" as const, version: "test" },
];

type T = TestConvex<typeof schema>;

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
    vi.fn(async () => await Promise.resolve(Response.json([{ id: "user_1" }])))
  );
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  const [, token] = invite.url.split("/invite/");
  assert(token !== undefined, "invite url has a token");
  await dana.mutation(api.invites.accept, { token });
  vi.unstubAllGlobals();
  const room = await owner.query(api.rooms.get, { roomId });
  assert(room, "owner can read the room");
  const { participants } = room;
  const claude = participants.find((p) => p.harness === "claude");
  const codex = participants.find((p) => p.harness === "codex");
  const pi = participants.find((p) => p.harness === "pi");
  assert(claude, "room has a Claude participant");
  assert(codex, "room has a Codex participant");
  assert(pi, "room has a Pi participant");
  return { claude, codex, dana, owner, pi, roomId, t };
};

const allCommands = async (t: T) =>
  await t.run(async (ctx) => await ctx.db.query("commands").collect());

const runTurnCommand = async (t: T, turnId: Id<"turns">) => {
  const commands = await allCommands(t);
  const command = commands.find(
    (c) => c.turnId === turnId && c.type === "run_turn"
  );
  assert(command, "the turn has a run_turn command");
  return command;
};

const getTurn = async (t: T, turnId: Id<"turns">) => {
  const turn = await t.run(async (ctx) => await ctx.db.get(turnId));
  assert(turn, "the turn exists");
  return turn;
};

const runningTurn = async (
  s: Awaited<ReturnType<typeof setup>>,
  participantId: Id<"participants">
) => {
  const turnId = await s.owner.mutation(api.messages.send, {
    body: "Write the plan file",
    roomId: s.roomId,
    toParticipantId: participantId,
  });
  assert(turnId, "the message starts a turn");
  const command = await runTurnCommand(s.t, turnId);
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
};

const controlCommands = async (t: T, turnId: Id<"turns">) => {
  const commands = await allCommands(t);
  return commands.filter((c) => c.turnId === turnId && c.type !== "run_turn");
};

const controlTypes = async (t: T, turnId: Id<"turns">) => {
  const commands = await controlCommands(t, turnId);
  return commands.map((c) => c.type);
};

const controlTypesAndPayloads = async (t: T, turnId: Id<"turns">) => {
  const commands = await controlCommands(t, turnId);
  return commands.map((c): [string, unknown] => [c.type, c.payload]);
};

describe("room edit switch", () => {
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

  it("only the owner can set the edit switch, and both people see it", async () => {
    const s = await setup();
    await expect(
      s.dana.mutation(api.rooms.setEditsEnabled, { on: true, roomId: s.roomId })
    ).rejects.toThrow(/owner/iu);
    await expect(
      s.dana.query(api.agent.pane, { roomId: s.roomId })
    ).resolves.toMatchObject({ editsEnabled: false });

    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    await expect(
      s.dana.query(api.agent.pane, { roomId: s.roomId })
    ).resolves.toMatchObject({ editsEnabled: true });
    const ledger = await s.t.run(
      async (ctx) => await ctx.db.query("ledger").collect()
    );
    const changes = ledger.filter((e) => e.type === "room.edits_changed");
    expect(changes).toHaveLength(1);
    const [change] = changes;
    assert(change, "the edit change is in the ledger");
    expect(change.payload).toStrictEqual({ editsEnabled: true });
  });

  it("turning edits on mid-turn sends settings to a running Claude turn without interrupting it", async () => {
    const s = await setup();
    const turnId = await runningTurn(s, s.claude._id);
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    await expect(controlTypesAndPayloads(s.t, turnId)).resolves.toStrictEqual([
      ["settings", { editsEnabled: true }],
    ]);
    const [settings] = await controlCommands(s.t, turnId);
    assert(settings, "a settings command was sent");
    const job = await s.t.mutation(api.runner.claim, {
      commandId: settings._id,
      secret: SECRET,
    });
    expect(job).toMatchObject({
      payload: { editsEnabled: true },
      turn: { id: turnId },
      type: "settings",
    });
  });

  it("turning edits off mid-turn interrupts running Codex and Pi turns and sends settings to Claude", async () => {
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
    await expect(controlTypes(s.t, claudeTurn)).resolves.toStrictEqual([
      "settings",
    ]);
    const typesByTurn = await Promise.all(
      [codexTurn, piTurn].map(async (turnId) => await controlTypes(s.t, turnId))
    );
    for (const types of typesByTurn) {
      expect(types).toContain("interrupt");
      expect(types).toContain("settings");
    }
  });

  it("a new turn's edit snapshot matches the room when it is dispatched and claimed", async () => {
    const s = await setup();
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    const turnId = await s.owner.mutation(api.messages.send, {
      body: "Go",
      roomId: s.roomId,
      toParticipantId: s.claude._id,
    });
    assert(turnId, "the message starts a turn");
    const dispatched = await getTurn(s.t, turnId);
    const command = await runTurnCommand(s.t, turnId);
    const job = await s.t.mutation(api.runner.claim, {
      commandId: command._id,
      secret: SECRET,
    });
    assert(job, "the turn is claimed");
    expect({
      claimed: job.room?.editsEnabled,
      dispatched: dispatched.editsEnabled,
    }).toStrictEqual({ claimed: true, dispatched: true });

    // Switched off between dispatch and claim: the claim carries the room's value now.
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: false,
      roomId: s.roomId,
    });
    const second = await s.owner.mutation(api.messages.send, {
      body: "Next",
      roomId: s.roomId,
      toParticipantId: s.pi._id,
    });
    assert(second, "the second message starts a turn");
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    const secondCommand = await runTurnCommand(s.t, second);
    const secondJob = await s.t.mutation(api.runner.claim, {
      commandId: secondCommand._id,
      secret: SECRET,
    });
    assert(secondJob, "the second turn is claimed");
    const claimed = await getTurn(s.t, second);
    expect({
      claimed: secondJob.room?.editsEnabled,
      turn: claimed.editsEnabled,
    }).toStrictEqual({ claimed: true, turn: true });
    // A queued turn gets no control commands; the claim carries the value.
    await expect(controlCommands(s.t, second)).resolves.toHaveLength(0);

    // Switched off between claim and start: start returns the room's value now.
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: false,
      roomId: s.roomId,
    });
    await expect(
      s.t.mutation(api.runner.start, {
        harnessVersion: "test",
        secret: SECRET,
        turnId: second,
      })
    ).resolves.toStrictEqual({ editsEnabled: false });
    await expect(getTurn(s.t, second)).resolves.toMatchObject({
      editsEnabled: false,
    });
  });

  it("a Codex turn that started with edits off is not interrupted when edits go on then off", async () => {
    const s = await setup();
    const codexTurn = await runningTurn(s, s.codex._id);
    await expect(getTurn(s.t, codexTurn)).resolves.toMatchObject({
      editsEnabled: false,
    });
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: false,
      roomId: s.roomId,
    });
    await expect(
      controlTypesAndPayloads(s.t, codexTurn)
    ).resolves.toStrictEqual([
      ["settings", { editsEnabled: true }],
      ["settings", { editsEnabled: false }],
    ]);
  });
});
