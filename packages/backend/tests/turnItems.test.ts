import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";

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
  const claude = (await owner.query(api.rooms.get, {
    roomId,
  }))!.participants.find((p) => p.harness === "claude")!;
  return { claude, dana, owner, roomId, t };
}

test("tool activity is stored per call, a result updates its call, and both people see it after the turn ends", async () => {
  const { t, owner, dana, roomId, claude } = await setup();
  const turnId = (await owner.mutation(api.messages.send, {
    body: "Read the plan",
    roomId,
    toParticipantId: claude._id,
  }))!;
  const command = (
    await t.run(async (ctx) => ctx.db.query("commands").collect())
  ).find((c) => c.turnId === turnId && c.type === "run_turn")!;
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
      { callId: "call-1", seq: 0, name: "Read", summary: "docs/plan.md" },
      { callId: "call-2", seq: 1, name: "Grep", summary: "x".repeat(500) },
    ],
    secret: SECRET,
    turnId,
  });
  await t.mutation(api.runner.recordTurnItems, {
    items: [
      {
        callId: "call-1",
        seq: 0,
        name: "Read",
        summary: "docs/plan.md",
        ok: true,
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

  for (const viewer of [owner, dana]) {
    const pane = await viewer.query(api.agent.pane, { roomId });
    expect(pane.turns.find((x) => x.id === turnId)!.items).toEqual([
      { name: "Read", ok: true, summary: "docs/plan.md" },
      { name: "Grep", ok: null, summary: "x".repeat(200) },
    ]);
  }
  await expect(
    t.run(async (ctx) => ctx.db.query("turnItems").collect())
  ).resolves.toHaveLength(2);
});
