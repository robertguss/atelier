import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
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
  const runnerId = await heartbeat(t);
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
  const robert = participants.find((p) => p.displayName === "Robert")!;
  const danaP = participants.find((p) => p.displayName === "Dana")!;
  return { claude, codex, dana, danaP, owner, pi, robert, roomId, runnerId, t };
}

async function heartbeat(t: T) {
  return await t.mutation(api.runners.heartbeat, {
    harnesses: HARNESSES,
    machine: "test",
    name: "test",
    secret: SECRET,
  });
}

async function allCommands(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("commands").collect());
}

async function startTurn(t: T, turnId: Id<"turns">) {
  const command = (await allCommands(t)).find(
    (c) => c.turnId === turnId && c.type === "run_turn"
  )!;
  await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId,
  });
  return command._id;
}

function question(id: string, text: string, labels = ["Option A", "Option B"]) {
  return {
    allowFreeText: true,
    header: id.toUpperCase(),
    id,
    multiSelect: false,
    options: labels.map((label) => ({
      label,
      description: `${label} described`,
    })),
    text,
  };
}

async function raise(
  t: T,
  turnId: Id<"turns">,
  questions = [question("scope", "Which scope?")],
  requestId = "req-1"
) {
  return await t.mutation(api.runner.raiseHand, {
    questions,
    requestId,
    secret: SECRET,
    turnId,
  });
}

// A running Claude turn waiting on a one-question card.
async function waitingClaude(
  s: Awaited<ReturnType<typeof setup>>,
  questions?: ReturnType<typeof question>[]
) {
  const turnId = (await s.owner.mutation(api.messages.send, {
    body: "Brainstorm the plan",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  }))!;
  const commandId = await startTurn(s.t, turnId);
  const handId = await raise(s.t, turnId, questions);
  return { commandId, handId, turnId };
}

async function ledger(t: T, type: string) {
  return (await t.run(async (ctx) => ctx.db.query("ledger").collect())).filter(
    (e) => e.type === type
  );
}

async function decisions(t: T) {
  return await t.run(async (ctx) => ctx.db.query("decisions").collect());
}

async function ordinaryTurns(t: T, participantId: Id<"participants">) {
  return (await t.run(async (ctx) => ctx.db.query("turns").collect())).filter(
    (x) => x.participantId === participantId && !x.ritualId
  );
}

test("raising a card shows it in the pane and marks the agent waiting, with the turn still running", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  await expect(
    s.t.run(async (ctx) => ctx.db.get(turnId))
  ).resolves.toMatchObject({
    status: "running",
    waitingOnHandId: handId,
  });
  const pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
  expect(
    pane.agents.find((a: any) => a.participantId === s.claude._id)!.status
  ).toBe("waiting");
  expect(pane.cards).toHaveLength(1);
  expect(pane.cards[0]).toMatchObject({
    id: handId,
    participantId: s.claude._id,
    questions: [
      {
        id: "scope",
        header: "SCOPE",
        text: "Which scope?",
        options: [
          { label: "Option A", description: "Option A described" },
          { label: "Option B", description: "Option B described" },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
    status: "raised",
    turnId,
  });
  await expect(ledger(s.t, "hand.raised")).resolves.toHaveLength(1);
});

test("two answers to one card: the first applies, the second is told who answered and changes nothing", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  await s.owner.mutation(api.hands.answer, {
    answers: [{ questionId: "scope", labels: ["Option A"] }],
    handId,
  });
  await expect(
    s.dana.mutation(api.hands.answer, {
      answers: [{ questionId: "scope", labels: ["Option B"] }],
      handId,
    })
  ).rejects.toThrow(/already answered by Robert/i);

  const hand = (await s.t.run(async (ctx) => ctx.db.get(handId)))!;
  expect(hand).toMatchObject({
    answeredByParticipantId: s.robert._id,
    answers: [{ questionId: "scope", labels: ["Option A"] }],
    status: "answered",
    via: "card",
  });
  expect(
    (await s.t.run(async (ctx) => ctx.db.get(turnId)))!.waitingOnHandId
  ).toBeUndefined();
  await expect(decisions(s.t)).resolves.toHaveLength(1);
  expect((await decisions(s.t))[0]).toMatchObject({
    answeredByParticipantId: s.robert._id,
    choice: "Option A",
    handId,
    questionId: "scope",
  });
  const answers = (await allCommands(s.t)).filter((c) => c.type === "answer");
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    payload: {
      answeredBy: "Robert",
      answers: [
        { questionId: "scope", question: "Which scope?", labels: ["Option A"] },
      ],
      handId,
      requestId: "req-1",
      via: "card",
    },
    status: "pending",
    turnId,
  });
  await expect(ledger(s.t, "hand.answered")).resolves.toHaveLength(1);
  const pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
  expect(pane.cards[0]).toMatchObject({
    answeredByParticipantId: s.robert._id,
    status: "answered",
    via: "card",
  });
  expect(
    pane.agents.find((a: any) => a.participantId === s.claude._id)!.status
  ).toBe("running");
});

test("a decision links the team messages posted while the card was open, and not one posted after", async () => {
  vi.setSystemTime(new Date("2026-11-06T14:00:00Z"));
  const s = await setup();
  vi.setSystemTime(new Date("2026-11-06T14:09:30Z"));
  await heartbeat(s.t);
  const before = await s.dana.mutation(api.team.post, {
    body: "before the question",
    roomId: s.roomId,
  });
  const turnId = (await s.owner.mutation(api.messages.send, {
    body: "Plan",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  }))!;
  await startTurn(s.t, turnId);
  vi.setSystemTime(new Date("2026-11-06T14:10:00Z"));
  const handId = await raise(s.t, turnId);
  vi.setSystemTime(new Date("2026-11-06T14:11:00Z"));
  const at1411 = await s.dana.mutation(api.team.post, {
    body: "I lean towards A",
    roomId: s.roomId,
  });
  vi.setSystemTime(new Date("2026-11-06T14:13:00Z"));
  const at1413 = await s.owner.mutation(api.team.post, {
    body: "A is cheaper",
    roomId: s.roomId,
  });
  vi.setSystemTime(new Date("2026-11-06T14:15:00Z"));
  await heartbeat(s.t);
  await s.dana.mutation(api.hands.answer, {
    answers: [{ questionId: "scope", labels: ["Option A"] }],
    handId,
  });
  vi.setSystemTime(new Date("2026-11-06T14:16:00Z"));
  await s.owner.mutation(api.team.post, {
    body: "good call",
    roomId: s.roomId,
  });

  const recorded = await ledger(s.t, "decision.recorded");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.actorParticipantId).toBe(s.danaP._id);
  expect(recorded[0]!.payload.teamMessageIds).toEqual([at1411, at1413]);
  expect(recorded[0]!.payload.teamMessageIds).not.toContain(before);
  expect(JSON.stringify(recorded[0]!.payload)).not.toMatch(
    /lean|cheaper|good call/
  );
});

test("a message to an agent waiting on its card answers the card in chat and starts no turn", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  const result = await s.dana.mutation(api.messages.send, {
    body: "go with option B but keep it short",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  });
  expect(result).toBeNull();

  await expect(ordinaryTurns(s.t, s.claude._id)).resolves.toHaveLength(1);
  expect(
    (await allCommands(s.t)).filter((c) => c.type === "run_turn")
  ).toHaveLength(1);
  const message = (
    await s.t.run(async (ctx) => ctx.db.query("messages").collect())
  ).find((m) => m.body === "go with option B but keep it short")!;
  expect(message).toMatchObject({
    deliveredTurnId: turnId,
    delivery: "answeredCard",
  });
  await expect(
    s.t.run(async (ctx) => ctx.db.get(handId))
  ).resolves.toMatchObject({
    answeredByParticipantId: s.danaP._id,
    answers: [
      {
        questionId: "scope",
        labels: [],
        freeText: "go with option B but keep it short",
      },
    ],
    status: "answered",
    via: "chat",
  });
  expect(
    (await s.t.run(async (ctx) => ctx.db.get(turnId)))!.waitingOnHandId
  ).toBeUndefined();
  const answer = (await allCommands(s.t)).find((c) => c.type === "answer")!;
  expect(answer.payload).toMatchObject({
    answeredBy: "Dana",
    answers: [
      { questionId: "scope", freeText: "go with option B but keep it short" },
    ],
    via: "chat",
  });
  expect((await decisions(s.t))[0]).toMatchObject({
    answeredByParticipantId: s.danaP._id,
    choice: "go with option B but keep it short",
  });
});

test("a chat answer to a two-question card records one decision, while the agent gets it as the answer to both questions", async () => {
  const s = await setup();
  const { turnId, commandId, handId } = await waitingClaude(s, [
    question("q1", "First?"),
    question("q2", "Second?"),
  ]);
  await s.dana.mutation(api.messages.send, {
    body: "ship the small one",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  });

  const rows = await decisions(s.t);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    answeredByParticipantId: s.danaP._id,
    choice: "ship the small one",
    handId,
  });
  await expect(ledger(s.t, "decision.recorded")).resolves.toHaveLength(1);
  const answer = (await allCommands(s.t)).find((c) => c.type === "answer")!;
  expect(answer.payload.answers).toEqual([
    {
      freeText: "ship the small one",
      labels: [],
      question: "First?",
      questionId: "q1",
    },
    {
      freeText: "ship the small one",
      labels: [],
      question: "Second?",
      questionId: "q2",
    },
  ]);

  await s.t.mutation(api.runner.finish, {
    commandId,
    finalText: "ok",
    secret: SECRET,
    transcriptRef: "/t",
    turnId,
  });
  const next = (await s.owner.mutation(api.messages.send, {
    body: "Continue",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  }))!;
  const { prompt } = (await s.t.run(async (ctx) => ctx.db.get(next)))!;
  expect(prompt).toMatch(
    /- First\? \(and 1 more\) → ship the small one \(decided by Dana, /
  );
});

test("a four-question card answered once records four decisions sharing the same team message links", async () => {
  const s = await setup();
  const questions = [
    question("q1", "First?"),
    question("q2", "Second?"),
    question("q3", "Third?"),
    question("q4", "Fourth?"),
  ];
  const { handId } = await waitingClaude(s, questions);
  const teamId = await s.dana.mutation(api.team.post, {
    body: "thoughts",
    roomId: s.roomId,
  });
  await s.owner.mutation(api.hands.answer, {
    answers: [
      { questionId: "q1", labels: ["Option A"] },
      { questionId: "q2", labels: ["Option B"] },
      { questionId: "q3", labels: [], freeText: "neither" },
      { questionId: "q4", labels: ["Option A"], freeText: "with a caveat" },
    ],
    handId,
  });
  const rows = await decisions(s.t);
  expect(rows.map((d) => [d.questionId, d.choice])).toEqual([
    ["q1", "Option A"],
    ["q2", "Option B"],
    ["q3", "neither"],
    ["q4", "Option A; with a caveat"],
  ]);
  const recorded = await ledger(s.t, "decision.recorded");
  expect(recorded).toHaveLength(4);
  for (const entry of recorded) {
    expect(entry.payload.teamMessageIds).toEqual([teamId]);
  }
  expect(
    (await allCommands(s.t)).filter((c) => c.type === "answer")
  ).toHaveLength(1);
});

test("a card must be answered whole", async () => {
  const s = await setup();
  const { handId } = await waitingClaude(s, [
    question("q1", "First?"),
    question("q2", "Second?"),
  ]);
  await expect(
    s.owner.mutation(api.hands.answer, {
      answers: [{ questionId: "q1", labels: ["Option A"] }],
      handId,
    })
  ).rejects.toThrow(/every question/i);
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "raised"
  );
});

test("stopping a turn with an open card cancels the card and records no decision", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  await s.dana.mutation(api.messages.cancel, { turnId });
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "cancelled"
  );
  expect(
    (await s.t.run(async (ctx) => ctx.db.get(turnId)))!.waitingOnHandId
  ).toBeUndefined();
  await expect(ledger(s.t, "hand.cancelled")).resolves.toHaveLength(1);
  await expect(decisions(s.t)).resolves.toHaveLength(0);
  await expect(
    s.owner.mutation(api.hands.answer, {
      answers: [{ questionId: "scope", labels: ["Option A"] }],
      handId,
    })
  ).rejects.toThrow(/closed without an answer/i);
  expect(
    (await allCommands(s.t)).filter((c) => c.type === "answer")
  ).toHaveLength(0);
});

test("a runner restart expires the card, and a later message starts a normal turn", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  await s.t.mutation(api.runner.recover, {
    runnerId: s.runnerId,
    secret: SECRET,
  });
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "expired"
  );
  expect((await s.t.run(async (ctx) => ctx.db.get(turnId)))!.status).toBe(
    "interrupted"
  );
  await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
  await expect(decisions(s.t)).resolves.toHaveLength(0);

  const next = await s.dana.mutation(api.messages.send, {
    body: "Late answer: option B",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  });
  expect(next).not.toBeNull();
  const message = (
    await s.t.run(async (ctx) => ctx.db.query("messages").collect())
  ).find((m) => m.body === "Late answer: option B")!;
  expect(message).toMatchObject({
    deliveredTurnId: next,
    delivery: "delivered",
  });
});

test("a reclaimed lease expires the open card", async () => {
  const s = await setup();
  const { handId } = await waitingClaude(s);
  vi.advanceTimersByTime(6 * 60_000);
  await s.t.mutation(internal.runner.reclaimExpiredLeases, {});
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "expired"
  );
  await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
});

test("a card left past the ceiling expires and the agent is told no decision was made", async () => {
  const s = await setup();
  const { turnId, handId } = await waitingClaude(s);
  await s.t.mutation(api.runner.handTimedOut, { handId, secret: SECRET });
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "expired"
  );
  const turn = (await s.t.run(async (ctx) => ctx.db.get(turnId)))!;
  expect(turn.status).toBe("running");
  expect(turn.waitingOnHandId).toBeUndefined();
  const answer = (await allCommands(s.t)).find((c) => c.type === "answer")!;
  expect(answer).toMatchObject({
    payload: { handId, noDecision: true, requestId: "req-1" },
    status: "pending",
    turnId,
  });
  expect(answer.payload.message).toMatch(/no decision/i);
  await expect(decisions(s.t)).resolves.toHaveLength(0);
  await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
});

test("a removed member's answer is rejected", async () => {
  const s = await setup();
  const { handId } = await waitingClaude(s);
  const { members } = await s.owner.query(api.members.list, {
    roomId: s.roomId,
  });
  await s.owner.mutation(api.members.remove, {
    memberId: members.find((m) => m.role === "member")!._id,
  });
  await expect(
    s.dana.mutation(api.hands.answer, {
      answers: [{ questionId: "scope", labels: ["Option B"] }],
      handId,
    })
  ).rejects.toThrow(/no longer a member/i);
  expect((await s.t.run(async (ctx) => ctx.db.get(handId)))!.status).toBe(
    "raised"
  );
  await expect(decisions(s.t)).resolves.toHaveLength(0);
});

test("the next context block shows a card decision as question, choice and answerer only, and leaves out review decisions", async () => {
  const s = await setup();
  const TOKEN = "TEAM-TOKEN-91b2";
  const { commandId, turnId, handId } = await waitingClaude(s);
  await s.dana.mutation(api.team.post, {
    body: `quietly: ${TOKEN}`,
    roomId: s.roomId,
  });
  await s.dana.mutation(api.hands.answer, {
    answers: [{ questionId: "scope", labels: ["Option B"] }],
    handId,
  });
  await s.t.run(async (ctx) => {
    const ritualId = await ctx.db.insert("rituals", {
      participantIds: [],
      request: "r",
      roomId: s.roomId,
      status: "decided",
      type: "independent_review",
    });
    await ctx.db.insert("decisions", {
      choice: "REVIEW-CHOICE",
      rationale: "REVIEW-RATIONALE",
      ritualId,
      roomId: s.roomId,
    });
  });
  await s.t.mutation(api.runner.finish, {
    commandId,
    finalText: "ok",
    secret: SECRET,
    transcriptRef: "/t",
    turnId,
  });

  const next = (await s.owner.mutation(api.messages.send, {
    body: "Continue",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  }))!;
  const { prompt } = (await s.t.run(async (ctx) => ctx.db.get(next)))!;
  expect(prompt).toMatch(/- Which scope\? → Option B \(decided by Dana, /);
  expect(prompt).not.toContain(TOKEN);
  expect(prompt).not.toContain("REVIEW-CHOICE");
  const job = await s.t.mutation(api.runner.claim, {
    commandId: (await allCommands(s.t)).find(
      (c) => c.turnId === next && c.type === "run_turn"
    )!._id,
    secret: SECRET,
  });
  expect(JSON.stringify(job)).not.toContain(TOKEN);
  expect(JSON.stringify(await allCommands(s.t))).not.toContain(TOKEN);
});

test("the pane says which agents can raise cards, once the runner reports it", async () => {
  const s = await setup();
  let pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
  expect(pane.agents.map((a: any) => a.canRaiseCards)).toEqual([
    null,
    null,
    null,
  ]);
  await s.t.mutation(api.runner.reportCapabilities, {
    harnesses: [
      { id: "claude", canRaiseCards: true },
      { id: "codex", canRaiseCards: false },
      { id: "pi", canRaiseCards: false },
    ],
    runnerId: s.runnerId,
    secret: SECRET,
  });
  await heartbeat(s.t);
  pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
  const byId = Object.fromEntries(
    pane.agents.map((a: any) => [a.participantId, a.canRaiseCards])
  );
  expect(byId).toEqual({
    [s.claude._id]: true,
    [s.codex._id]: false,
    [s.pi._id]: false,
  });
});
