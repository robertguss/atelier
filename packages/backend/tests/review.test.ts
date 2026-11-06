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

import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

type T = TestConvex<typeof schema>;

const runAllTimers = () => {
  vi.runAllTimers();
};

// Draining the workflow advances the fake clock; a live runner keeps beating.
const drain = async (t: T) => {
  await t.finishAllScheduledFunctions(runAllTimers);
  await t.mutation(api.runners.heartbeat, {
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
};

const setup = async () => {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
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
  assert(room, "owner can read the room");
  const participants = room.participants.filter((p) => p.kind === "harness");
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
};

describe("independent review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
    process.env.ATELIER_RUNNER_SECRET = "test-secret";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sealed progress and answers never reach owner; reveal survives failure and duplicate completion", async () => {
    const { t, owner, roomId, ritualId, commands, participants } =
      await setup();
    const [first, second] = commands;
    assert(first, "the review queued a first turn");
    assert(second, "the review queued a second turn");
    await t.run(async (ctx) => {
      await Promise.all(
        participants.map(async (p) => {
          await ctx.db.patch(p._id, { harnessSessionId: "ordinary-session" });
        })
      );
    });
    const job = await t.mutation(api.runner.claim, {
      commandId: first._id,
      secret: "test-secret",
    });
    assert(job, "the first review turn is claimed");
    const claimedParticipant = job.participant;
    assert(claimedParticipant, "the claim carries its participant");
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
    // Each owner view, captured at the moment it must still be sealed.
    const sealedViews = [
      JSON.stringify(await owner.query(api.rituals.get, { ritualId })),
      JSON.stringify(await owner.query(api.messages.timeline, { roomId })),
      JSON.stringify(await owner.query(api.agent.live, { roomId })),
    ];
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
    sealedViews.push(
      JSON.stringify(await owner.query(api.messages.timeline, { roomId })),
      JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
    );
    await expect(
      t.mutation(internal.rituals.reveal, { ritualId })
    ).resolves.toBeFalsy();
    await expect(
      owner.mutation(api.rituals.decide, {
        choice: "too early",
        rationale: "",
        ritualId,
      })
    ).rejects.toThrow("A revealed review and decision are required");
    await t.mutation(api.runner.fail, {
      commandId: second._id,
      error: "SECRET-ERROR",
      secret: "test-secret",
      turnId: second.turnId,
    });
    sealedViews.push(
      JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
    );
    expect(sealedViews.join("\n")).not.toContain("SECRET");
    await drain(t);
    const revealed = await owner.query(api.rituals.get, { ritualId });
    assert(revealed, "owner can read the revealed review");
    const room = await owner.query(api.rooms.get, { roomId });
    assert(room, "owner can read the room");
    expect({
      answeredFinal: revealed.turns.some(
        (turn) => turn.answer === "SECRET-FINAL"
      ),
      claimedSessionId: claimedParticipant.sessionId,
      ordinarySessions: room.participants
        .filter((p) => p.kind === "harness")
        .map((p) => p.harnessSessionId),
      pushStatus: revealed.pushStatus,
      status: revealed.status,
    }).toStrictEqual({
      answeredFinal: true,
      claimedSessionId: undefined,
      ordinarySessions: ["ordinary-session", "ordinary-session"],
      pushStatus: "skipped",
      status: "revealed",
    });
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
    const decided = await owner.query(api.rituals.get, { ritualId });
    const decision = decided?.decisions[0];
    assert(decision, "the review has a decision");
    const [firstParticipant] = participants;
    assert(firstParticipant, "the review has a participant");
    await owner.mutation(api.messages.send, {
      body: "Implement",
      decisionId: decision._id,
      roomId,
      toParticipantId: firstParticipant._id,
    });
    const recorded = await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      const posted = ledger.find((e) => e.type === "message.posted");
      const decisionEntry = ledger.find((e) => e.type === "decision.recorded");
      assert(posted, "the follow-up message is in the ledger");
      assert(decisionEntry, "the decision is in the ledger");
      const messages = await ctx.db.query("messages").collect();
      return {
        decisionLedgerId: decisionEntry._id,
        postedParent: posted.parentLedgerId,
        revealedEntries: ledger.filter((e) => e.type === "ritual.revealed")
          .length,
        reviewMessages: messages.filter((m) => m.turnId === first.turnId)
          .length,
      };
    });
    expect(recorded).toStrictEqual({
      decisionLedgerId: recorded.decisionLedgerId,
      postedParent: recorded.decisionLedgerId,
      revealedEntries: 1,
      reviewMessages: 1,
    });
  });

  it("owner cancellation and runner restart release the reveal barrier; unauthorized reads fail", async () => {
    const { t, owner, roomId, runnerId, ritualId, commands } = await setup();
    await expect(t.query(api.rituals.get, { ritualId })).rejects.toThrow(
      "Not signed in as the Atelier owner"
    );
    await expect(t.query(api.messages.timeline, { roomId })).rejects.toThrow(
      "Not a member of this room"
    );
    const [first, second] = commands;
    assert(first, "the review queued a first turn");
    assert(second, "the review queued a second turn");
    await owner.mutation(api.messages.cancel, { turnId: first.turnId });
    await t.mutation(api.runner.claim, {
      commandId: second._id,
      secret: "test-secret",
    });
    await t.mutation(api.runner.recover, { runnerId, secret: "test-secret" });
    await t.finishAllScheduledFunctions(runAllTimers);
    const review = await owner.query(api.rituals.get, { ritualId });
    assert(review, "owner can read the review");
    expect({
      allFailed: review.turns.every((turn) => turn.status === "failed"),
      status: review.status,
    }).toStrictEqual({ allFailed: true, status: "revealed" });
  });

  it("snapshot is fixed once and cannot leak through owner queries; participant validation is atomic", async () => {
    const { t, owner, roomId, ritualId, participants } = await setup();
    await expect(
      t.mutation(api.runner.prepareReview, {
        ritualId,
        secret: "test-secret",
        snapshot: "FIRST-SNAPSHOT",
      })
    ).resolves.toBe("FIRST-SNAPSHOT");
    await expect(
      t.mutation(api.runner.prepareReview, {
        ritualId,
        secret: "test-secret",
        snapshot: "SECOND-SNAPSHOT",
      })
    ).resolves.toBe("FIRST-SNAPSHOT");
    expect(
      JSON.stringify(await owner.query(api.rituals.get, { ritualId }))
    ).not.toContain("SNAPSHOT");
    const [participant] = participants;
    assert(participant, "the review has a participant");
    await expect(
      owner.mutation(api.rituals.begin, {
        participantIds: [participant._id, participant._id],
        request: "duplicate",
        roomId,
      })
    ).rejects.toThrow("Choose participants and enter a request");
    await expect(
      owner.query(api.rituals.list, { roomId })
    ).resolves.toHaveLength(1);
  });

  it("push uses generic reveal text, removes invalid devices, and records retryable failure", async () => {
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
    ).resolves.toStrictEqual([]);
    for (const c of commands) {
      // oxlint-disable-next-line no-await-in-loop -- each failure is its own runner mutation and the reveal barrier is driven by the order they land
      await t.mutation(api.runner.fail, {
        commandId: c._id,
        error: "PRIVATE_FAILURE",
        secret: "test-secret",
        turnId: c.turnId,
      });
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: [
            { details: { error: "DeviceNotRegistered" }, status: "error" },
          ],
        },
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await t.finishAllScheduledFunctions(runAllTimers);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [firstCall] = fetchMock.mock.calls;
      assert(firstCall, "push was sent");
      const [, init] = firstCall;
      expect(init?.body).not.toContain("PRIVATE_FAILURE");
      const readiness = await owner.query(api.push.readiness, {});
      await owner.mutation(api.push.register, {
        platform: "ios",
        token: "ExpoPushToken[device_2]",
      });
      fetchMock.mockResolvedValue(new Response("", { status: 503 }));
      await expect(t.action(internal.push.send, { ritualId })).rejects.toThrow(
        "503"
      );
      const review = await owner.query(api.rituals.get, { ritualId });
      expect({
        pushStatus: review?.pushStatus,
        readiness,
      }).toStrictEqual({
        pushStatus: "failed",
        readiness: { registered: false },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ordinary turns still stream, resume sessions, and show completed answers", async () => {
    const { t, owner, roomId, runnerId, ritualId, commands, participants } =
      await setup();
    for (const c of commands) {
      // oxlint-disable-next-line no-await-in-loop -- each cancel is its own mutation and the reveal barrier is driven by the order they land
      await owner.mutation(api.messages.cancel, { turnId: c.turnId });
    }
    await drain(t);
    await expect(
      owner.query(api.rituals.get, { ritualId })
    ).resolves.toMatchObject({ status: "revealed" });
    const [participant] = participants;
    assert(participant, "the room has a harness participant");
    const turnId = await owner.mutation(api.messages.send, {
      body: "ordinary request",
      roomId,
      toParticipantId: participant._id,
    });
    assert(turnId, "the message starts a turn");
    const pending = await t.query(api.runner.pendingCommands, {
      runnerId,
      secret: "test-secret",
    });
    const command = pending.find((c) => c.turnId === turnId);
    assert(command, "the turn has a pending command");
    await expect(
      t.mutation(api.runner.claim, {
        commandId: command._id,
        secret: "test-secret",
      })
    ).resolves.toMatchObject({ turn: { independentReview: false } });
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: "test-secret",
      turnId,
    });
    await t.mutation(api.runner.progress, {
      commandId: command._id,
      partialText: "ordinary stream",
      secret: "test-secret",
      turnId,
    });
    expect(
      JSON.stringify(await owner.query(api.agent.live, { roomId }))
    ).toContain("ordinary stream");
    await t.mutation(api.runner.finish, {
      commandId: command._id,
      finalText: "ordinary answer",
      secret: "test-secret",
      sessionId: "next-session",
      transcriptRef: "/ordinary",
      turnId,
    });
    expect(
      JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
    ).toContain("ordinary answer");
    const room = await owner.query(api.rooms.get, { roomId });
    expect(
      room?.participants.find((p) => p._id === participant._id)
    ).toMatchObject({ harnessSessionId: "next-session" });
  });

  it("review follow-up needs no crux or decision, but cannot expose sealed answers", async () => {
    const { t, owner, roomId, ritualId, commands, participants } =
      await setup();
    const [first, second] = commands;
    assert(first, "the review queued a first turn");
    assert(second, "the review queued a second turn");
    const reviewTurn = await t.run(
      async (ctx) => await ctx.db.get(first.turnId)
    );
    assert(reviewTurn, "the review turn exists");
    const followup = {
      body: "Tell me more",
      reviewTurnId: first.turnId,
      roomId,
      toParticipantId: reviewTurn.participantId,
    };
    await expect(owner.mutation(api.messages.send, followup)).rejects.toThrow(
      "Review is not available"
    );
    await expect(
      owner.mutation(api.rituals.saveTakeaway, { body: "Too early", ritualId })
    ).rejects.toThrow("Wait until the review finishes");
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
    await owner.mutation(api.messages.cancel, { turnId: second.turnId });
    await drain(t);
    const turnId = await owner.mutation(api.messages.send, followup);
    assert(turnId, "the follow-up starts a turn");
    const followUp = await t.run(async (ctx) => {
      const turn = await ctx.db.get(turnId);
      assert(turn, "the follow-up turn exists");
      const ledger = await ctx.db.query("ledger").collect();
      const posted = ledger.find((e) => e.type === "message.posted");
      const revealedEntry = ledger.find((e) => e.type === "ritual.revealed");
      assert(posted, "the follow-up message is in the ledger");
      assert(revealedEntry, "the reveal is in the ledger");
      return {
        postedParent: posted.parentLedgerId,
        promptHasEvidence: turn.prompt.includes("Review evidence"),
        revealedLedgerId: revealedEntry._id,
      };
    });
    expect(followUp).toStrictEqual({
      postedParent: followUp.revealedLedgerId,
      promptHasEvidence: true,
      revealedLedgerId: followUp.revealedLedgerId,
    });
    const wrongParticipant = participants.find(
      (p) => p._id !== reviewTurn.participantId
    );
    assert(wrongParticipant, "the review has another participant");
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
    assert(review, "owner can read the review");
    expect({
      cruxes: review.cruxes,
      decisions: review.decisions,
      status: review.status,
      takeaways: review.takeaways.map((n) => n.body),
    }).toStrictEqual({
      cruxes: [],
      decisions: [],
      status: "revealed",
      takeaways: ["Remember this"],
    });
  });
});
