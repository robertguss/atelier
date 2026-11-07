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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Ledger and command payloads are stored untyped; narrow before reading fields.
const payloadOf = (row: { payload?: unknown }) => {
  const { payload } = row;
  assert(isRecord(payload), "the row has a payload object");
  return payload;
};

const heartbeat = async (t: T) =>
  await t.mutation(api.runners.heartbeat, {
    harnesses: HARNESSES,
    machine: "test",
    name: "test",
    secret: SECRET,
  });

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
  const robert = participants.find((p) => p.displayName === "Robert");
  const danaP = participants.find((p) => p.displayName === "Dana");
  assert(claude, "room has a Claude participant");
  assert(codex, "room has a Codex participant");
  assert(pi, "room has a Pi participant");
  assert(robert, "room has Robert");
  assert(danaP, "room has Dana");
  return { claude, codex, dana, danaP, owner, pi, robert, roomId, runnerId, t };
};

const allCommands = async (t: T) =>
  await t.run(async (ctx) => await ctx.db.query("commands").collect());

const commandsOfType = async (t: T, type: string) => {
  const commands = await allCommands(t);
  return commands.filter((c) => c.type === type);
};

const runTurnCommand = async (t: T, turnId: Id<"turns">) => {
  const commands = await allCommands(t);
  const command = commands.find(
    (c) => c.turnId === turnId && c.type === "run_turn"
  );
  assert(command, "the turn has a run_turn command");
  return command;
};

const answerCommand = async (t: T) => {
  const [answer] = await commandsOfType(t, "answer");
  assert(answer, "an answer command was sent");
  return answer;
};

const getTurn = async (t: T, turnId: Id<"turns">) => {
  const turn = await t.run(async (ctx) => await ctx.db.get(turnId));
  assert(turn, "the turn exists");
  return turn;
};

// The fields a card changes on its turn, with an unset field kept as an explicit
// undefined so `toMatchObject` can assert it is unset.
const turnState = async (t: T, turnId: Id<"turns">) => {
  const { status, waitingOnHandId } = await getTurn(t, turnId);
  return { status, waitingOnHandId };
};

const getHand = async (t: T, handId: Id<"hands">) => {
  const hand = await t.run(async (ctx) => await ctx.db.get(handId));
  assert(hand, "the card exists");
  return hand;
};

const findMessage = async (t: T, body: string) => {
  const messages = await t.run(
    async (ctx) => await ctx.db.query("messages").collect()
  );
  const message = messages.find((m) => m.body === body);
  assert(message, "the message was stored");
  return message;
};

const startTurn = async (t: T, turnId: Id<"turns">) => {
  const command = await runTurnCommand(t, turnId);
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
};

const question = (
  id: string,
  text: string,
  labels = ["Option A", "Option B"]
) => ({
  allowFreeText: true,
  header: id.toUpperCase(),
  id,
  multiSelect: false,
  options: labels.map((label) => ({
    description: `${label} described`,
    label,
  })),
  text,
});

const raise = async (
  t: T,
  turnId: Id<"turns">,
  questions = [question("scope", "Which scope?")],
  requestId = "req-1"
) =>
  await t.mutation(api.runner.raiseHand, {
    questions,
    requestId,
    secret: SECRET,
    turnId,
  });

// A running Claude turn waiting on a one-question card.
const waitingClaude = async (
  s: Awaited<ReturnType<typeof setup>>,
  questions?: ReturnType<typeof question>[]
) => {
  const turnId = await s.owner.mutation(api.messages.send, {
    body: "Brainstorm the plan",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  });
  assert(turnId, "the message starts a turn");
  const commandId = await startTurn(s.t, turnId);
  const handId = await raise(s.t, turnId, questions);
  return { commandId, handId, turnId };
};

const ledger = async (t: T, type: string) => {
  const entries = await t.run(
    async (ctx) => await ctx.db.query("ledger").collect()
  );
  return entries.filter((e) => e.type === type);
};

const decisions = async (t: T) =>
  await t.run(async (ctx) => await ctx.db.query("decisions").collect());

const ordinaryTurns = async (t: T, participantId: Id<"participants">) => {
  const turns = await t.run(
    async (ctx) => await ctx.db.query("turns").collect()
  );
  return turns.filter(
    (x) => x.participantId === participantId && x.ritualId === undefined
  );
};

const nextPrompt = async (
  s: Awaited<ReturnType<typeof setup>>,
  commandId: Id<"commands">,
  turnId: Id<"turns">
) => {
  await s.t.mutation(api.runner.finish, {
    commandId,
    finalText: "ok",
    secret: SECRET,
    transcriptRef: "/t",
    turnId,
  });
  const next = await s.owner.mutation(api.messages.send, {
    body: "Continue",
    roomId: s.roomId,
    toParticipantId: s.claude._id,
  });
  assert(next, "the next message starts a turn");
  const { prompt } = await getTurn(s.t, next);
  return { next, prompt };
};

describe("raised hands", () => {
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

  it("raising a card shows it in the pane and marks the agent waiting, with the turn still running", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await expect(getTurn(s.t, turnId)).resolves.toMatchObject({
      status: "running",
      waitingOnHandId: handId,
    });
    const pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
    expect(
      pane.agents.find((a) => a.participantId === s.claude._id)
    ).toMatchObject({ status: "waiting" });
    expect(pane.cards).toHaveLength(1);
    expect(pane.cards[0]).toMatchObject({
      id: handId,
      participantId: s.claude._id,
      questions: [
        {
          allowFreeText: true,
          header: "SCOPE",
          id: "scope",
          multiSelect: false,
          options: [
            { description: "Option A described", label: "Option A" },
            { description: "Option B described", label: "Option B" },
          ],
          text: "Which scope?",
        },
      ],
      status: "raised",
      turnId,
    });
    await expect(ledger(s.t, "hand.raised")).resolves.toHaveLength(1);
  });

  it("two answers to one card: the first applies, the second is told who answered and changes nothing", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await s.owner.mutation(api.hands.answer, {
      answers: [{ labels: ["Option A"], questionId: "scope" }],
      handId,
    });
    await expect(
      s.dana.mutation(api.hands.answer, {
        answers: [{ labels: ["Option B"], questionId: "scope" }],
        handId,
      })
    ).rejects.toThrow(/already answered by Robert/iu);

    expect({
      answers: await commandsOfType(s.t, "answer"),
      decisions: await decisions(s.t),
      hand: await getHand(s.t, handId),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      answers: [
        {
          payload: {
            answeredBy: "Robert",
            answers: [
              {
                labels: ["Option A"],
                question: "Which scope?",
                questionId: "scope",
              },
            ],
            handId,
            requestId: "req-1",
            via: "card",
          },
          status: "pending",
          turnId,
        },
      ],
      decisions: [
        {
          answeredByParticipantId: s.robert._id,
          choice: "Option A",
          handId,
          questionId: "scope",
        },
      ],
      hand: {
        answeredByParticipantId: s.robert._id,
        answers: [{ labels: ["Option A"], questionId: "scope" }],
        status: "answered",
        via: "card",
      },
      turn: { waitingOnHandId: undefined },
    });
    await expect(ledger(s.t, "hand.answered")).resolves.toHaveLength(1);
    const pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
    expect({
      agent: pane.agents.find((a) => a.participantId === s.claude._id),
      card: pane.cards[0],
    }).toMatchObject({
      agent: { status: "running" },
      card: {
        answeredByParticipantId: s.robert._id,
        status: "answered",
        via: "card",
      },
    });
  });

  it("a decision links the team messages posted while the card was open, and not one posted after", async () => {
    vi.setSystemTime(new Date("2026-11-06T14:00:00Z"));
    const s = await setup();
    vi.setSystemTime(new Date("2026-11-06T14:09:30Z"));
    await heartbeat(s.t);
    const before = await s.dana.mutation(api.team.post, {
      body: "before the question",
      roomId: s.roomId,
    });
    const turnId = await s.owner.mutation(api.messages.send, {
      body: "Plan",
      roomId: s.roomId,
      toParticipantId: s.claude._id,
    });
    assert(turnId, "the message starts a turn");
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
      answers: [{ labels: ["Option A"], questionId: "scope" }],
      handId,
    });
    vi.setSystemTime(new Date("2026-11-06T14:16:00Z"));
    await s.owner.mutation(api.team.post, {
      body: "good call",
      roomId: s.roomId,
    });

    const recorded = await ledger(s.t, "decision.recorded");
    expect(recorded).toHaveLength(1);
    const [entry] = recorded;
    assert(entry, "the decision is in the ledger");
    expect(entry.actorParticipantId).toBe(s.danaP._id);
    const payload = payloadOf(entry);
    expect(payload.teamMessageIds).toStrictEqual([at1411, at1413]);
    expect(payload.teamMessageIds).not.toContain(before);
    expect(JSON.stringify(payload)).not.toMatch(/lean|cheaper|good call/u);
  });

  it("a message to an agent waiting on its card answers the card in chat and starts no turn", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    const result = await s.dana.mutation(api.messages.send, {
      body: "go with option B but keep it short",
      roomId: s.roomId,
      toParticipantId: s.claude._id,
    });
    expect(result).toBeNull();

    const turns = await ordinaryTurns(s.t, s.claude._id);
    const runTurns = await commandsOfType(s.t, "run_turn");
    expect({
      ordinaryTurns: turns.length,
      runTurnCommands: runTurns.length,
    }).toStrictEqual({ ordinaryTurns: 1, runTurnCommands: 1 });
    const [firstDecision] = await decisions(s.t);
    expect({
      answer: await answerCommand(s.t),
      decision: firstDecision,
      hand: await getHand(s.t, handId),
      message: await findMessage(s.t, "go with option B but keep it short"),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      answer: {
        payload: {
          answeredBy: "Dana",
          answers: [
            {
              freeText: "go with option B but keep it short",
              questionId: "scope",
            },
          ],
          via: "chat",
        },
      },
      decision: {
        answeredByParticipantId: s.danaP._id,
        choice: "go with option B but keep it short",
      },
      hand: {
        answeredByParticipantId: s.danaP._id,
        answers: [
          {
            freeText: "go with option B but keep it short",
            labels: [],
            questionId: "scope",
          },
        ],
        status: "answered",
        via: "chat",
      },
      message: {
        deliveredTurnId: turnId,
        delivery: "answeredCard",
      },
      turn: { waitingOnHandId: undefined },
    });
  });

  it("a chat answer to a two-question card records one decision, while the agent gets it as the answer to both questions", async () => {
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
    const answer = await answerCommand(s.t);
    expect(payloadOf(answer).answers).toStrictEqual([
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

    const { prompt } = await nextPrompt(s, commandId, turnId);
    expect(prompt).toMatch(
      /- First\? \(and 1 more\) → ship the small one \(decided by Dana, /u
    );
  });

  it("a four-question card answered once records four decisions sharing the same team message links", async () => {
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
        { labels: ["Option A"], questionId: "q1" },
        { labels: ["Option B"], questionId: "q2" },
        { freeText: "neither", labels: [], questionId: "q3" },
        { freeText: "with a caveat", labels: ["Option A"], questionId: "q4" },
      ],
      handId,
    });
    const rows = await decisions(s.t);
    expect(rows.map((d) => [d.questionId, d.choice])).toStrictEqual([
      ["q1", "Option A"],
      ["q2", "Option B"],
      ["q3", "neither"],
      ["q4", "Option A; with a caveat"],
    ]);
    const recorded = await ledger(s.t, "decision.recorded");
    expect(recorded).toHaveLength(4);
    for (const entry of recorded) {
      expect(payloadOf(entry).teamMessageIds).toStrictEqual([teamId]);
    }
    await expect(commandsOfType(s.t, "answer")).resolves.toHaveLength(1);
  });

  it("a card must be answered whole", async () => {
    const s = await setup();
    const { handId } = await waitingClaude(s, [
      question("q1", "First?"),
      question("q2", "Second?"),
    ]);
    await expect(
      s.owner.mutation(api.hands.answer, {
        answers: [{ labels: ["Option A"], questionId: "q1" }],
        handId,
      })
    ).rejects.toThrow(/every question/iu);
    await expect(getHand(s.t, handId)).resolves.toMatchObject({
      status: "raised",
    });
  });

  it("stopping a turn with an open card cancels the card and records no decision", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await s.dana.mutation(api.messages.cancel, { turnId });
    expect({
      hand: await getHand(s.t, handId),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      hand: { status: "cancelled" },
      turn: { waitingOnHandId: undefined },
    });
    await expect(ledger(s.t, "hand.cancelled")).resolves.toHaveLength(1);
    await expect(decisions(s.t)).resolves.toHaveLength(0);
    await expect(
      s.owner.mutation(api.hands.answer, {
        answers: [{ labels: ["Option A"], questionId: "scope" }],
        handId,
      })
    ).rejects.toThrow(/closed without an answer/iu);
    await expect(commandsOfType(s.t, "answer")).resolves.toHaveLength(0);
  });

  it("a runner restart expires the card, and a later message starts a normal turn", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await s.t.mutation(api.runner.recover, {
      runnerId: s.runnerId,
      secret: SECRET,
    });
    expect({
      hand: await getHand(s.t, handId),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      hand: { status: "expired" },
      turn: { status: "interrupted" },
    });
    await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
    await expect(decisions(s.t)).resolves.toHaveLength(0);

    const next = await s.dana.mutation(api.messages.send, {
      body: "Late answer: option B",
      roomId: s.roomId,
      toParticipantId: s.claude._id,
    });
    expect(next).not.toBeNull();
    await expect(
      findMessage(s.t, "Late answer: option B")
    ).resolves.toMatchObject({
      deliveredTurnId: next,
      delivery: "delivered",
    });
  });

  it("a reclaimed lease expires the open card", async () => {
    const s = await setup();
    const { handId } = await waitingClaude(s);
    vi.advanceTimersByTime(6 * 60_000);
    await s.t.mutation(internal.runner.reclaimExpiredLeases, {});
    await expect(getHand(s.t, handId)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
  });

  it("a card left past the ceiling expires and the agent is told no decision was made", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await s.t.mutation(api.runner.handTimedOut, { handId, secret: SECRET });
    expect({
      hand: await getHand(s.t, handId),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      hand: { status: "expired" },
      turn: { status: "running", waitingOnHandId: undefined },
    });
    const answer = await answerCommand(s.t);
    expect(answer).toMatchObject({
      payload: { handId, noDecision: true, requestId: "req-1" },
      status: "pending",
      turnId,
    });
    expect(payloadOf(answer).message).toMatch(/no decision/iu);
    await expect(decisions(s.t)).resolves.toHaveLength(0);
    await expect(ledger(s.t, "hand.expired")).resolves.toHaveLength(1);
  });

  it("a removed member's answer is rejected", async () => {
    const s = await setup();
    const { handId } = await waitingClaude(s);
    const { members } = await s.owner.query(api.members.list, {
      roomId: s.roomId,
    });
    const member = members.find((m) => m.role === "member");
    assert(member, "Dana is a member");
    await s.owner.mutation(api.members.remove, { memberId: member._id });
    await expect(
      s.dana.mutation(api.hands.answer, {
        answers: [{ labels: ["Option B"], questionId: "scope" }],
        handId,
      })
    ).rejects.toThrow(/no longer a member/iu);
    await expect(getHand(s.t, handId)).resolves.toMatchObject({
      status: "raised",
    });
    await expect(decisions(s.t)).resolves.toHaveLength(0);
  });

  it("the next context block shows a card decision as question, choice and answerer only, and leaves out review decisions", async () => {
    const s = await setup();
    const TOKEN = "TEAM-TOKEN-91b2";
    const { commandId, turnId, handId } = await waitingClaude(s);
    await s.dana.mutation(api.team.post, {
      body: `quietly: ${TOKEN}`,
      roomId: s.roomId,
    });
    await s.dana.mutation(api.hands.answer, {
      answers: [{ labels: ["Option B"], questionId: "scope" }],
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

    const { next, prompt } = await nextPrompt(s, commandId, turnId);
    expect(prompt).toMatch(/- Which scope\? → Option B \(decided by Dana, /u);
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).not.toContain("REVIEW-CHOICE");
    const nextCommand = await runTurnCommand(s.t, next);
    const job = await s.t.mutation(api.runner.claim, {
      commandId: nextCommand._id,
      secret: SECRET,
    });
    expect(JSON.stringify(job)).not.toContain(TOKEN);
    expect(JSON.stringify(await allCommands(s.t))).not.toContain(TOKEN);
  });

  it("the pane says which agents can raise cards, once the runner reports it", async () => {
    const s = await setup();
    let pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
    expect(pane.agents.map((a) => a.canRaiseCards)).toStrictEqual([
      null,
      null,
      null,
    ]);
    await s.t.mutation(api.runner.reportCapabilities, {
      harnesses: [
        { canRaiseCards: true, id: "claude" },
        { canRaiseCards: false, id: "codex" },
        { canRaiseCards: false, id: "pi" },
      ],
      runnerId: s.runnerId,
      secret: SECRET,
    });
    await heartbeat(s.t);
    pane = await s.dana.query(api.agent.pane, { roomId: s.roomId });
    const byId = Object.fromEntries(
      pane.agents.map((a) => [a.participantId, a.canRaiseCards])
    );
    expect(byId).toStrictEqual({
      [s.claude._id]: true,
      [s.codex._id]: false,
      [s.pi._id]: false,
    });
  });
});

describe("cards an agent stopped waiting on", () => {
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

  it("a withdrawn card closes as cancelled with no decision, and a later message to the agent is not taken as its answer", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    await s.t.mutation(api.runner.handWithdrawn, { handId, secret: SECRET });
    const [cancelled] = await ledger(s.t, "hand.cancelled");
    assert(cancelled, "the withdrawal is in the ledger");
    expect({
      hand: await getHand(s.t, handId),
      reason: payloadOf(cancelled),
      turn: await turnState(s.t, turnId),
    }).toMatchObject({
      hand: { closeReason: "The agent stopped waiting", status: "cancelled" },
      reason: { reason: "The agent stopped waiting" },
      turn: { status: "running", waitingOnHandId: undefined },
    });
    await expect(decisions(s.t)).resolves.toHaveLength(0);

    await s.owner.mutation(api.messages.send, {
      body: "use option A",
      roomId: s.roomId,
      toParticipantId: s.claude._id,
    });
    await expect(findMessage(s.t, "use option A")).resolves.toMatchObject({
      delivery: "queued",
    });
    await expect(commandsOfType(s.t, "answer")).resolves.toHaveLength(0);
  });

  it("withdrawing one of two open cards moves the turn's wait to the other", async () => {
    const s = await setup();
    const { turnId, handId } = await waitingClaude(s);
    const second = await raise(
      s.t,
      turnId,
      [question("depth", "How deep?")],
      "req-2"
    );
    await s.t.mutation(api.runner.handWithdrawn, { handId, secret: SECRET });
    await expect(turnState(s.t, turnId)).resolves.toMatchObject({
      waitingOnHandId: second,
    });
  });

  it("withdrawing a card that was already answered changes nothing", async () => {
    const s = await setup();
    const { handId } = await waitingClaude(s);
    await s.owner.mutation(api.hands.answer, {
      answers: [{ labels: ["Option A"], questionId: "scope" }],
      handId,
    });
    await s.t.mutation(api.runner.handWithdrawn, { handId, secret: SECRET });
    await expect(getHand(s.t, handId)).resolves.toMatchObject({
      status: "answered",
    });
    await expect(decisions(s.t)).resolves.toHaveLength(1);
    await expect(ledger(s.t, "hand.cancelled")).resolves.toHaveLength(0);
  });
});

// A running Codex turn, the turn kind that reads these tools most.
const runningCodex = async (s: Awaited<ReturnType<typeof setup>>) => {
  const turnId = await s.owner.mutation(api.messages.send, {
    body: "Look around",
    roomId: s.roomId,
    toParticipantId: s.codex._id,
  });
  assert(turnId, "the message starts a turn");
  const commandId = await startTurn(s.t, turnId);
  return { commandId, turnId };
};

const insertDecisions = async (
  s: Awaited<ReturnType<typeof setup>>,
  count: number
) => {
  for (let n = 1; n <= count; n += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- decisions are inserted in order, so creation time orders them
    await s.t.run(async (ctx) => {
      await ctx.db.insert("decisions", {
        answeredByParticipantId: s.robert._id,
        choice: `choice ${n}`,
        roomId: s.roomId,
      });
    });
  }
};

describe("asking the room", () => {
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

  it("Codex and Pi are told to ask through raise_hand; Claude, which asks through its own question tool, is not", async () => {
    const s = await setup();
    const promptFor = async (participantId: Id<"participants">) => {
      const turnId = await s.owner.mutation(api.messages.send, {
        body: "Pick a database",
        roomId: s.roomId,
        toParticipantId: participantId,
      });
      assert(turnId, "the message starts a turn");
      const { prompt } = await getTurn(s.t, turnId);
      return prompt;
    };
    const [codex, pi, claude] = [
      await promptFor(s.codex._id),
      await promptFor(s.pi._id),
      await promptFor(s.claude._id),
    ];
    expect(codex).toMatch(/call the raise_hand tool/u);
    expect(pi).toMatch(/call the raise_hand tool/u);
    expect(claude).not.toMatch(/raise_hand/u);
  });
});

describe("room context tools", () => {
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

  it("the handbook tool returns the room's handbook as it is now, including an edit made after the turn was queued", async () => {
    const s = await setup();
    const { turnId } = await runningCodex(s);
    const read = async () =>
      await s.t.query(api.documentTools.readHandbookForTurn, {
        secret: SECRET,
        turnId,
      });
    await expect(read()).resolves.toStrictEqual({ handbook: "", ok: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.roomId, { handbook: "1. Ship small." });
    });
    await expect(read()).resolves.toStrictEqual({
      handbook: "1. Ship small.",
      ok: true,
    });
  });

  it("the decisions tool returns the latest ten agent-visible decisions, oldest first, as the context block writes them", async () => {
    const s = await setup();
    const { turnId } = await runningCodex(s);
    await insertDecisions(s, 12);
    const result = await s.t.query(api.documentTools.recentDecisionsForTurn, {
      secret: SECRET,
      turnId,
    });
    assert(result.ok, "a running turn reads decisions");
    expect(result.lines).toHaveLength(10);
    expect(result.lines[0]).toMatch(
      /^- choice 3 \(decided by Robert, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/u
    );
    expect(result.lines[9]).toMatch(/^- choice 12 /u);
  });

  it("the decisions tool honours a limit between 1 and 50", async () => {
    const s = await setup();
    const { turnId } = await runningCodex(s);
    await insertDecisions(s, 55);
    const count = async (limit: number) => {
      const result = await s.t.query(api.documentTools.recentDecisionsForTurn, {
        limit,
        secret: SECRET,
        turnId,
      });
      assert(result.ok, "a running turn reads decisions");
      return result.lines.length;
    };
    await expect(count(3)).resolves.toBe(3);
    await expect(count(500)).resolves.toBe(50);
    await expect(count(0)).resolves.toBe(1);
  });

  it("the decisions tool leaves out review decisions and their rationale", async () => {
    const s = await setup();
    const { turnId } = await runningCodex(s);
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
    await insertDecisions(s, 2);
    const result = await s.t.query(api.documentTools.recentDecisionsForTurn, {
      secret: SECRET,
      turnId,
    });
    assert(result.ok, "a running turn reads decisions");
    expect(result.lines).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/REVIEW-/u);
  });

  it("both tools refuse once the turn has ended", async () => {
    const s = await setup();
    const { commandId, turnId } = await runningCodex(s);
    await s.t.mutation(api.runner.finish, {
      commandId,
      finalText: "ok",
      secret: SECRET,
      transcriptRef: "/t",
      turnId,
    });
    const args = { secret: SECRET, turnId };
    await expect(
      s.t.query(api.documentTools.readHandbookForTurn, args)
    ).resolves.toMatchObject({ ok: false, reason: "turn_ended" });
    await expect(
      s.t.query(api.documentTools.recentDecisionsForTurn, args)
    ).resolves.toMatchObject({ ok: false, reason: "turn_ended" });
    await expect(
      s.t.query(api.documentTools.readHandbookForTurn, {
        ...args,
        secret: "wrong",
      })
    ).rejects.toThrow(/Bad runner secret/u);
  });
});

describe("push for a raised card", () => {
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

  it("raising a card schedules one push for it", async () => {
    const s = await setup();
    const { handId } = await waitingClaude(s);
    const scheduled = await s.t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(
      scheduled
        .filter((f) => f.name.startsWith("push:"))
        .map((f) => ({ args: f.args, name: f.name }))
    ).toStrictEqual([{ args: [{ handId }], name: "push:sendHand" }]);
  });

  it("the push names the agent and the room, never the question, and drops devices Expo says are gone", async () => {
    const s = await setup();
    await s.owner.mutation(api.push.register, {
      platform: "ios",
      token: "ExpoPushToken[device_1]",
    });
    const { handId } = await waitingClaude(s, [
      question("scope", "SECRET-QUESTION-TEXT"),
    ]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ details: { error: "DeviceNotRegistered" }, status: "error" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await s.t.action(internal.push.sendHand, { handId });
    const [firstCall] = fetchMock.mock.calls;
    assert(firstCall, "the push was sent");
    const sent = firstCall[1]?.body;
    assert(typeof sent === "string", "the push body is JSON text");
    const body = sent;
    expect(body).not.toContain("SECRET-QUESTION-TEXT");
    expect(JSON.parse(body)).toStrictEqual([
      {
        body: "Claude has a question. Open Atelier to answer it.",
        data: { participantId: s.claude._id, roomId: s.roomId },
        sound: "default",
        title: "Question waiting",
        to: "ExpoPushToken[device_1]",
      },
    ]);
    await expect(s.owner.query(api.push.readiness, {})).resolves.toStrictEqual({
      registered: false,
    });
  });

  it("a card closed before the push goes out sends nothing", async () => {
    const s = await setup();
    await s.owner.mutation(api.push.register, {
      platform: "ios",
      token: "ExpoPushToken[device_1]",
    });
    const { handId } = await waitingClaude(s);
    await s.owner.mutation(api.hands.answer, {
      answers: [{ labels: ["Option A"], questionId: "scope" }],
      handId,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      s.t.query(internal.push.handPush, { handId })
    ).resolves.toBeNull();
    await s.t.action(internal.push.sendHand, { handId });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
