import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
  process.env.ATELIER_RUNNER_SECRET = "test-secret";
});
afterEach(() => {
  vi.useRealTimers();
});
// Draining the workflow advances the fake clock; a live runner keeps beating.
async function drain(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  await t.mutation(api.runners.heartbeat, {
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
}
async function setup() {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    subject: "owner",
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
    cwd: "/tmp/test",
    name: "test",
    runnerId,
  });
  await owner.mutation(api.rooms.addParticipant, { harness: "pi", roomId });
  const room = await owner.query(api.rooms.get, { roomId });
  const participants = room!.participants.filter((p) => p.kind === "harness");
  const ritualId = await owner.mutation(api.rituals.begin, {
    participantIds: participants.map((p) => p._id),
    request: "Review independently",
    roomId,
  });
  const commands = await t.query(api.runner.pendingCommands, {
    runnerId,
    secret: "test-secret",
  });
  return { commands, owner, participants, ritualId, roomId, runnerId, t };
}

test("sealed progress and answers never reach owner; reveal survives failure and duplicate completion", async () => {
  const { t, owner, roomId, ritualId, commands, participants } = await setup();
  const first = commands[0]!;
  const second = commands[1]!;
  await t.run(async (ctx) => {
    for (const p of participants) {
      await ctx.db.patch(p._id, { harnessSessionId: "ordinary-session" });
    }
  });
  const job = await t.mutation(api.runner.claim, {
    commandId: first._id,
    secret: "test-secret",
  });
  expect(job!.participant.sessionId).toBeUndefined();
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: "test-secret",
    turnId: first.turnId,
  });
  await t.mutation(api.runner.progress, {
    commandId: first._id,
    partialText: "SECRET-PARTIAL",
    secret: "test-secret",
    turnId: first.turnId,
  });
  expect(
    JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
  ).not.toContain("SECRET");
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).not.toContain("SECRET");
  expect(
    JSON.stringify(await owner.query(api.agent.live, { roomId }))
  ).not.toContain("SECRET");
  const finish = {
    commandId: first._id,
    finalText: "SECRET-FINAL",
    secret: "test-secret",
    sessionId: "review-session",
    transcriptRef: "/SECRET-TRANSCRIPT",
    turnId: first.turnId,
  };
  await t.mutation(api.runner.finish, finish);
  await t.mutation(api.runner.finish, finish);
  await t.mutation(api.runner.fail, {
    commandId: first._id,
    error: "Late failure",
    secret: "test-secret",
    turnId: first.turnId,
  });
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).not.toContain("SECRET");
  expect(
    JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
  ).not.toContain("SECRET");
  await expect(t.mutation(internal.rituals.reveal, { ritualId })).resolves.toBe(
    false
  );
  await expect(
    owner.mutation(api.rituals.decide, {
      choice: "too early",
      rationale: "",
      ritualId,
    })
  ).rejects.toThrow();
  await t.mutation(api.runner.fail, {
    commandId: second._id,
    error: "SECRET-ERROR",
    secret: "test-secret",
    turnId: second.turnId,
  });
  expect(
    JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
  ).not.toContain("SECRET");
  await drain(t);
  const revealed = await owner.query(api.rituals.get, { ritualId });
  expect(revealed!.status).toBe("revealed");
  expect(revealed!.turns.map((t) => t.answer)).toContain("SECRET-FINAL");
  expect(revealed!.pushStatus).toBe("skipped");
  expect(
    (await owner.query(api.rooms.get, { roomId }))!.participants
      .filter((p) => p.kind === "harness")
      .map((p) => p.harnessSessionId)
  ).toEqual(["ordinary-session", "ordinary-session"]);
  await owner.mutation(api.rituals.recordCrux, {
    options: ["A", "B"],
    ritualId,
    statement: "Tradeoff",
  });
  await owner.mutation(api.rituals.decide, {
    choice: "A",
    rationale: "Because",
    ritualId,
  });
  const decision = (await owner.query(api.rituals.get, { ritualId }))!
    .decisions[0]!;
  await owner.mutation(api.messages.send, {
    body: "Implement",
    decisionId: decision._id,
    roomId,
    toParticipantId: participants[0]!._id,
  });
  await t.run(async (ctx) => {
    const ledger = await ctx.db.query("ledger").collect();
    expect(ledger.filter((e) => e.type === "ritual.revealed")).toHaveLength(1);
    expect(
      ledger.find((e) => e.type === "message.posted")!.parentLedgerId
    ).toBe(ledger.find((e) => e.type === "decision.recorded")!._id);
    expect(
      (await ctx.db.query("messages").collect()).filter(
        (m) => m.turnId === first.turnId
      )
    ).toHaveLength(1);
  });
});

test("owner cancellation and runner restart release the reveal barrier; unauthorized reads fail", async () => {
  const { t, owner, roomId, runnerId, ritualId, commands } = await setup();
  await expect(t.query(api.rituals.get, { ritualId })).rejects.toThrow();
  await expect(t.query(api.messages.timeline, { roomId })).rejects.toThrow();
  await owner.mutation(api.messages.cancel, { turnId: commands[0]!.turnId });
  await t.mutation(api.runner.claim, {
    commandId: commands[1]!._id,
    secret: "test-secret",
  });
  await t.mutation(api.runner.recover, { runnerId, secret: "test-secret" });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const review = await owner.query(api.rituals.get, { ritualId });
  expect(review!.status).toBe("revealed");
  expect(review!.turns.every((t) => t.status === "failed")).toBe(true);
});

test("snapshot is fixed once and cannot leak through owner queries; participant validation is atomic", async () => {
  const { t, owner, roomId, ritualId, participants } = await setup();
  await expect(
    t.mutation(api.runner.prepareReview, {
      secret: "test-secret",
      ritualId,
      snapshot: "FIRST-SNAPSHOT",
    })
  ).resolves.toBe("FIRST-SNAPSHOT");
  await expect(
    t.mutation(api.runner.prepareReview, {
      secret: "test-secret",
      ritualId,
      snapshot: "SECOND-SNAPSHOT",
    })
  ).resolves.toBe("FIRST-SNAPSHOT");
  expect(
    JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
  ).not.toContain("SNAPSHOT");
  await expect(
    owner.mutation(api.rituals.begin, {
      participantIds: [participants[0]!._id, participants[0]!._id],
      request: "duplicate",
      roomId,
    })
  ).rejects.toThrow();
  await expect(owner.query(api.rituals.list, { roomId })).resolves.toHaveLength(
    1
  );
});

test("push uses generic reveal text, removes invalid devices, and records retryable failure", async () => {
  const { t, owner, ritualId, commands } = await setup();
  await owner.mutation(api.push.register, {
    platform: "ios",
    token: "ExpoPushToken[device_1]",
  });
  await owner.mutation(api.push.register, {
    platform: "ios",
    token: "ExpoPushToken[device_1]",
  });
  await expect(
    t.query(internal.push.recipients, { ritualId })
  ).resolves.toEqual([]);
  for (const c of commands) {
    await t.mutation(api.runner.fail, {
      secret: "test-secret",
      turnId: c.turnId,
      commandId: c._id,
      error: "PRIVATE_FAILURE",
    });
  }
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [{ details: { error: "DeviceNotRegistered" }, status: "error" }],
      }),
      { status: 200 }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1].body).not.toContain("PRIVATE_FAILURE");
    await expect(owner.query(api.push.readiness, {})).resolves.toEqual({
      registered: false,
    });
    await owner.mutation(api.push.register, {
      platform: "ios",
      token: "ExpoPushToken[device_2]",
    });
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    await expect(t.action(internal.push.send, { ritualId })).rejects.toThrow(
      "503"
    );
    expect((await owner.query(api.rituals.get, { ritualId }))!.pushStatus).toBe(
      "failed"
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ordinary turns still stream, resume sessions, and show completed answers", async () => {
  const { t, owner, roomId, runnerId, ritualId, commands, participants } =
    await setup();
  for (const c of commands) {
    await owner.mutation(api.messages.cancel, { turnId: c.turnId });
  }
  await drain(t);
  expect((await owner.query(api.rituals.get, { ritualId }))!.status).toBe(
    "revealed"
  );
  const turnId = await owner.mutation(api.messages.send, {
    body: "ordinary request",
    roomId,
    toParticipantId: participants[0]!._id,
  });
  const c = (
    await t.query(api.runner.pendingCommands, {
      runnerId,
      secret: "test-secret",
    })
  ).find((c) => c.turnId === turnId)!;
  const job = await t.mutation(api.runner.claim, {
    commandId: c._id,
    secret: "test-secret",
  });
  expect(job!.turn.independentReview).toBe(false);
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: "test-secret",
    turnId,
  });
  await t.mutation(api.runner.progress, {
    commandId: c._id,
    partialText: "ordinary stream",
    secret: "test-secret",
    turnId,
  });
  expect(
    JSON.stringify(await owner.query(api.agent.live, { roomId }))
  ).toContain("ordinary stream");
  await t.mutation(api.runner.finish, {
    commandId: c._id,
    finalText: "ordinary answer",
    secret: "test-secret",
    sessionId: "next-session",
    transcriptRef: "/ordinary",
    turnId,
  });
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).toContain("ordinary answer");
  expect(
    (await owner.query(api.rooms.get, { roomId }))!.participants.find(
      (p) => p._id === participants[0]!._id
    )!.harnessSessionId
  ).toBe("next-session");
});

test("review follow-up needs no crux or decision, but cannot expose sealed answers", async () => {
  const { t, owner, roomId, ritualId, commands, participants } = await setup();
  const first = commands[0]!;
  const participant = await t.run(async (ctx) => ctx.db.get(first.turnId));
  const followup = {
    body: "Tell me more",
    reviewTurnId: first.turnId,
    roomId,
    toParticipantId: participant!.participantId,
  };
  await expect(owner.mutation(api.messages.send, followup)).rejects.toThrow(
    "Review is not available"
  );
  await expect(
    owner.mutation(api.rituals.saveTakeaway, { body: "Too early", ritualId })
  ).rejects.toThrow();
  await t.mutation(api.runner.claim, {
    commandId: first._id,
    secret: "test-secret",
  });
  await t.mutation(api.runner.finish, {
    commandId: first._id,
    finalText: "Review evidence",
    secret: "test-secret",
    transcriptRef: "/test",
    turnId: first.turnId,
  });
  await owner.mutation(api.messages.cancel, { turnId: commands[1]!.turnId });
  await drain(t);
  const turnId = await owner.mutation(api.messages.send, followup);
  await t.run(async (ctx) => {
    expect((await ctx.db.get(turnId))!.prompt).toContain("Review evidence");
    const ledger = await ctx.db.query("ledger").collect();
    expect(
      ledger.find((e) => e.type === "message.posted")!.parentLedgerId
    ).toBe(ledger.find((e) => e.type === "ritual.revealed")!._id);
  });
  const wrongParticipant = participants.find(
    (p) => p._id !== participant!.participantId
  )!;
  await expect(
    owner.mutation(api.messages.send, {
      ...followup,
      toParticipantId: wrongParticipant._id,
    })
  ).rejects.toThrow("Choose the participant");
  await owner.mutation(api.rituals.saveTakeaway, {
    body: "Remember this",
    ritualId,
  });
  const review = await owner.query(api.rituals.get, { ritualId });
  expect(review!.status).toBe("revealed");
  expect(review!.takeaways.map((n) => n.body)).toEqual(["Remember this"]);
  expect(review!.cruxes).toHaveLength(0);
  expect(review!.decisions).toHaveLength(0);
});
