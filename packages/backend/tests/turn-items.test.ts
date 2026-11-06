/// <reference types="vite/client" />
import { register as registerWorkflow } from "@convex-dev/workflow/test";
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

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";

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
    harnesses: [{ id: "claude", version: "test" }],
    machine: "test",
    name: "test",
    secret: SECRET,
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
  vi.unstubAllGlobals();
  const room = await owner.query(api.rooms.get, { roomId });
  assert(room, "owner can read the room");
  const claude = room.participants.find((p) => p.harness === "claude");
  assert(claude, "room has a Claude participant");
  return { claude, dana, owner, roomId, t };
};

describe("turn items", () => {
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

  it("tool activity is stored per call, a result updates its call, and both people see it after the turn ends", async () => {
    const { t, owner, dana, roomId, claude } = await setup();
    const turnId = await owner.mutation(api.messages.send, {
      body: "Read the plan",
      roomId,
      toParticipantId: claude._id,
    });
    assert(turnId, "the message starts a turn");
    const commands = await t.run(
      async (ctx) => await ctx.db.query("commands").collect()
    );
    const command = commands.find(
      (c) => c.turnId === turnId && c.type === "run_turn"
    );
    assert(command, "the turn has a run_turn command");
    await t.mutation(api.runner.claim, {
      commandId: command._id,
      secret: SECRET,
    });
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId,
    });

    await t.mutation(api.runner.recordTurnItems, {
      items: [
        { callId: "call-1", name: "Read", seq: 0, summary: "docs/plan.md" },
        { callId: "call-2", name: "Grep", seq: 1, summary: "x".repeat(500) },
      ],
      secret: SECRET,
      turnId,
    });
    await t.mutation(api.runner.recordTurnItems, {
      items: [
        {
          callId: "call-1",
          name: "Read",
          ok: true,
          seq: 0,
          summary: "docs/plan.md",
        },
      ],
      secret: SECRET,
      turnId,
    });
    await t.mutation(api.runner.finish, {
      commandId: command._id,
      finalText: "Done",
      secret: SECRET,
      transcriptRef: "/tmp/t.ndjson",
      turnId,
    });

    const panes = await Promise.all(
      [owner, dana].map(
        async (viewer) => await viewer.query(api.agent.pane, { roomId })
      )
    );
    for (const pane of panes) {
      expect(pane.turns.find((x) => x.id === turnId)?.items).toStrictEqual([
        { name: "Read", ok: true, summary: "docs/plan.md" },
        { name: "Grep", ok: null, summary: "x".repeat(200) },
      ]);
    }
    await expect(
      t.run(async (ctx) => await ctx.db.query("turnItems").collect())
    ).resolves.toHaveLength(2);
  });
});
