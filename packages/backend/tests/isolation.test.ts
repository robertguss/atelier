import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
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

type T = ReturnType<typeof convexTest>;
type Caller = ReturnType<T["withIdentity"]>;

async function setup({ withMember }: { withMember: boolean }) {
  const t = convexTest(schema, modules);
  workflow.register(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    subject: "owner",
    name: "Robert",
  });
  const dana = t.withIdentity({
    email: "dana@example.com",
    subject: "dana",
    name: "Dana",
  });
  const runnerId = await t.mutation(api.runners.heartbeat, {
    secret: SECRET,
    name: "test",
    machine: "test",
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
  });
  const roomId = await owner.mutation(api.rooms.create, {
    name: "Planning",
    runnerId,
    cwd: "/tmp/planning",
  });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: "pi" });
  if (withMember) await addMember(owner, dana, roomId);
  const room = (await owner.query(api.rooms.get, { roomId }))!;
  const claude = room.participants.find((p) => p.harness === "claude")!;
  const pi = room.participants.find((p) => p.harness === "pi")!;
  const ownerHuman = room.participants.find(
    (p) => p.kind === "human" && p.displayName === "Robert"
  )!;
  await t.run(async (ctx) => {
    await ctx.db.patch(claude._id, { harnessSessionId: "ordinary-session" });
  });
  return { t, owner, dana, runnerId, roomId, claude, pi, ownerHuman };
}

async function addMember(
  owner: Caller,
  member: Caller,
  roomId: Id<"rooms">,
  email = "dana@example.com"
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([{ id: "user_1" }]))
  );
  const invite = await owner.action(api.invites.create, { roomId, email });
  await member.mutation(api.invites.accept, {
    token: invite.url.split("/invite/")[1]!,
  });
  vi.unstubAllGlobals();
}

// Starts a review with Claude and Pi. Claude answers; Pi fails. Returns once revealed.
async function revealedReview(
  t: T,
  owner: Caller,
  roomId: Id<"rooms">,
  runnerId: Id<"runners">,
  claude: Id<"participants">,
  pi: Id<"participants">
) {
  const ritualId = await owner.mutation(api.rituals.begin, {
    roomId,
    request: "Review independently",
    participantIds: [claude, pi],
  });
  const commands = await t.query(api.runner.pendingCommands, {
    secret: SECRET,
    runnerId,
  });
  const turns = await t.run(async (ctx) =>
    Promise.all(commands.map((c) => ctx.db.get(c.turnId)))
  );
  const claudeCommand =
    commands[turns.findIndex((turn) => turn!.participantId === claude)]!;
  const piCommand =
    commands[turns.findIndex((turn) => turn!.participantId === pi)]!;
  await t.mutation(api.runner.claim, {
    secret: SECRET,
    commandId: claudeCommand._id,
  });
  await t.mutation(api.runner.finish, {
    secret: SECRET,
    turnId: claudeCommand.turnId,
    commandId: claudeCommand._id,
    finalText: "REVIEW-ANSWER",
    sessionId: "review-session",
    transcriptRef: "/review",
  });
  await t.mutation(api.runner.fail, {
    secret: SECRET,
    turnId: piCommand.turnId,
    commandId: piCommand._id,
    error: "REVIEW-FAILURE",
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  // Draining the workflow advances the fake clock; a live runner keeps beating.
  await t.mutation(api.runners.heartbeat, {
    secret: SECRET,
    name: "test",
    machine: "test",
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
  });
  return { ritualId, reviewTurnId: claudeCommand.turnId };
}

async function commandFor(t: T, runnerId: Id<"runners">, turnId: Id<"turns">) {
  return (
    await t.query(api.runner.pendingCommands, { secret: SECRET, runnerId })
  ).find((c) => c.turnId === turnId)!;
}

// Claims, streams and finishes one ordinary or follow-up turn. Returns the session id the runner was told to resume.
async function runTurn(
  t: T,
  runnerId: Id<"runners">,
  turnId: Id<"turns">,
  finalText: string,
  sessionId: string
) {
  const command = await commandFor(t, runnerId, turnId);
  const job = await t.mutation(api.runner.claim, {
    secret: SECRET,
    commandId: command._id,
  });
  await t.mutation(api.runner.start, {
    secret: SECRET,
    turnId,
    harnessVersion: "test",
  });
  await t.mutation(api.runner.finish, {
    secret: SECRET,
    turnId,
    commandId: command._id,
    finalText,
    sessionId,
    transcriptRef: "/turn",
  });
  return job!.participant.sessionId;
}

async function sessionOf(t: T, participantId: Id<"participants">) {
  return await t.run(
    async (ctx) => (await ctx.db.get(participantId))!.harnessSessionId
  );
}

test("a member never sees review answers or follow-ups, while the owner still does", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: true,
  });
  const { ritualId, reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).toContain("REVIEW-ANSWER");
  expect(
    JSON.stringify(await dana.query(api.messages.timeline, { roomId }))
  ).not.toContain("REVIEW");

  const followUpId = await owner.mutation(api.messages.send, {
    roomId,
    body: "FOLLOWUP-QUESTION",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  const command = await commandFor(t, runnerId, followUpId);
  await t.mutation(api.runner.claim, {
    secret: SECRET,
    commandId: command._id,
  });
  await t.mutation(api.runner.start, {
    secret: SECRET,
    turnId: followUpId,
    harnessVersion: "test",
  });
  await t.mutation(api.runner.progress, {
    secret: SECRET,
    turnId: followUpId,
    commandId: command._id,
    partialText: "FOLLOWUP-PARTIAL",
  });
  const danaWhileRunning = JSON.stringify(
    await dana.query(api.messages.timeline, { roomId })
  );
  expect(danaWhileRunning).not.toContain("FOLLOWUP");
  expect(danaWhileRunning).not.toContain(followUpId);
  expect(
    JSON.stringify(await dana.query(api.agent.live, { roomId }))
  ).not.toContain("FOLLOWUP");
  expect(
    JSON.stringify(await owner.query(api.agent.live, { roomId }))
  ).toContain("FOLLOWUP-PARTIAL");
  await t.mutation(api.runner.finish, {
    secret: SECRET,
    turnId: followUpId,
    commandId: command._id,
    finalText: "FOLLOWUP-REPLY",
    sessionId: "followup-session",
    transcriptRef: "/f",
  });

  await owner.mutation(api.rituals.recordCrux, {
    ritualId,
    statement: "Tradeoff",
    options: ["A", "B"],
  });
  await owner.mutation(api.rituals.decide, {
    ritualId,
    choice: "A",
    rationale: "Because",
  });
  const decision = (await owner.query(api.rituals.get, { ritualId }))!
    .decisions[0]!;
  const decisionTurnId = await owner.mutation(api.messages.send, {
    roomId,
    body: "DECISION-FOLLOWUP",
    toParticipantId: claude._id,
    decisionId: decision._id,
  });
  await runTurn(
    t,
    runnerId,
    decisionTurnId,
    "DECISION-REPLY",
    "decision-session"
  );

  const ownerView = JSON.stringify(
    await owner.query(api.messages.timeline, { roomId })
  );
  for (const text of [
    "REVIEW-ANSWER",
    "FOLLOWUP-QUESTION",
    "FOLLOWUP-REPLY",
    "DECISION-FOLLOWUP",
    "DECISION-REPLY",
  ])
    expect(ownerView).toContain(text);
  const danaView = await dana.query(api.messages.timeline, { roomId });
  for (const text of ["REVIEW", "FOLLOWUP", "DECISION", "independent review"])
    expect(JSON.stringify(danaView)).not.toContain(text);

  await expect(
    dana.mutation(api.messages.send, {
      roomId,
      body: "sneak",
      toParticipantId: claude._id,
      reviewTurnId,
    })
  ).rejects.toThrow();
  await expect(
    dana.mutation(api.messages.send, {
      roomId,
      body: "sneak",
      toParticipantId: claude._id,
      decisionId: decision._id,
    })
  ).rejects.toThrow();

  expect(
    (await owner.query(api.rooms.list, {})).find((r) => r._id === roomId)!
      .readyReviews
  ).toBe(1);
  expect(Object.keys((await dana.query(api.rooms.list, {}))[0]!)).not.toContain(
    "readyReviews"
  );
});

test("the owner answering a follow-up card by chat stays hidden from a member", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: true,
  });
  const { reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  const followUpId = await owner.mutation(api.messages.send, {
    roomId,
    body: "Expand on it",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  const command = await commandFor(t, runnerId, followUpId);
  await t.mutation(api.runner.claim, {
    secret: SECRET,
    commandId: command._id,
  });
  await t.mutation(api.runner.start, {
    secret: SECRET,
    turnId: followUpId,
    harnessVersion: "test",
  });
  await t.mutation(api.runner.raiseHand, {
    secret: SECRET,
    turnId: followUpId,
    requestId: "req-1",
    questions: [
      {
        id: "q",
        header: "Q",
        text: "Which?",
        options: [{ label: "A", description: "a" }],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  });
  expect(
    await owner.mutation(api.messages.send, {
      roomId,
      body: "CARD-CHAT-ANSWER",
      toParticipantId: claude._id,
    })
  ).toBeNull();

  expect(
    JSON.stringify(await owner.query(api.agent.pane, { roomId }))
  ).toContain("CARD-CHAT-ANSWER");
  expect(
    JSON.stringify(await dana.query(api.agent.pane, { roomId }))
  ).not.toContain("CARD-CHAT-ANSWER");
  expect(
    JSON.stringify(await dana.query(api.messages.timeline, { roomId }))
  ).not.toContain("CARD-CHAT-ANSWER");
});

test("a member never receives turn prompts", async () => {
  const { dana, roomId, claude } = await setup({ withMember: true });
  await dana.mutation(api.messages.send, {
    roomId,
    body: "hello",
    toParticipantId: claude._id,
  });
  const items = await dana.query(api.messages.timeline, { roomId });
  expect(items.some((i) => i.kind === "turn")).toBe(true);
  for (const item of items) expect(Object.keys(item)).not.toContain("prompt");
});

test("in a shared room a follow-up runs on a session stored on its review, never the ordinary one", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: true,
  });
  const { ritualId, reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );

  const first = await owner.mutation(api.messages.send, {
    roomId,
    body: "Why?",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(first))!.followUp).toMatchObject({ ritualId });
  });
  expect(
    await runTurn(t, runnerId, first, "Because", "followup-1")
  ).toBeUndefined();
  expect(await sessionOf(t, claude._id)).toBe("ordinary-session");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toEqual([
      { participantId: claude._id, sessionId: "followup-1" },
    ]);
  });

  const second = await owner.mutation(api.messages.send, {
    roomId,
    body: "And then?",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  expect(await runTurn(t, runnerId, second, "Then this", "followup-2")).toBe(
    "followup-1"
  );
  expect(await sessionOf(t, claude._id)).toBe("ordinary-session");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toEqual([
      { participantId: claude._id, sessionId: "followup-2" },
    ]);
  });

  const ordinary = await dana.mutation(api.messages.send, {
    roomId,
    body: "What did we decide?",
    toParticipantId: claude._id,
  });
  expect(await runTurn(t, runnerId, ordinary, "No idea", "ordinary-2")).toBe(
    "ordinary-session"
  );
  expect(await sessionOf(t, claude._id)).toBe("ordinary-2");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toEqual([
      { participantId: claude._id, sessionId: "followup-2" },
    ]);
  });
});

test("a follow-up queued behind a teammate message runs as its own turn", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: true,
  });
  const { ritualId, reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  const teammateTurn = (await dana.mutation(api.messages.send, {
    roomId,
    body: "TEAMMATE-ASK",
    toParticipantId: claude._id,
  }))!;
  expect(
    await owner.mutation(api.messages.send, {
      roomId,
      body: "Expand on it",
      toParticipantId: claude._id,
      reviewTurnId,
    })
  ).toBeNull();
  expect(
    await dana.mutation(api.messages.send, {
      roomId,
      body: "TEAMMATE-LATER",
      toParticipantId: claude._id,
    })
  ).toBeNull();
  const ordinaryTurns = async () =>
    (await t.run((ctx) => ctx.db.query("turns").collect())).filter(
      (x) => !x.ritualId && x.participantId === claude._id
    );

  await runTurn(t, runnerId, teammateTurn, "answer", "ordinary-2");
  const followUpTurn = (await ordinaryTurns())[1]!;
  expect(followUpTurn.followUp).toMatchObject({ ritualId });
  expect(followUpTurn.prompt).toContain("Expand on it");
  expect(followUpTurn.prompt).not.toContain("TEAMMATE");

  await runTurn(t, runnerId, followUpTurn._id, "expanded", "followup-1");
  const later = (await ordinaryTurns())[2]!;
  expect(later.followUp).toBeUndefined();
  expect(later.prompt).toContain("TEAMMATE-LATER");
  expect(later.prompt).not.toContain("Expand on it");
  expect(later.prompt).not.toContain("REVIEW-ANSWER");
  await t.run(async (ctx) => {
    const teammate = (await ctx.db.get(teammateTurn))!;
    expect(teammate.followUp).toBeUndefined();
    expect(teammate.prompt).not.toContain("REVIEW-ANSWER");
  });
});

test("in a solo room a follow-up continues the ordinary session, and stays hidden from a later member", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: false,
  });
  const { ritualId, reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  const followUp = await owner.mutation(api.messages.send, {
    roomId,
    body: "SOLO-FOLLOWUP",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  expect(await runTurn(t, runnerId, followUp, "SOLO-REPLY", "solo-next")).toBe(
    "ordinary-session"
  );
  expect(await sessionOf(t, claude._id)).toBe("solo-next");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toBeUndefined();
  });

  await addMember(owner, dana, roomId);
  expect(
    JSON.stringify(await owner.query(api.messages.timeline, { roomId }))
  ).toContain("SOLO-REPLY");
  expect(
    JSON.stringify(await dana.query(api.messages.timeline, { roomId }))
  ).not.toContain("SOLO");
});

test("the first teammate to join resets the session of each agent that ran a follow-up alone with the owner", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: false,
  });
  const { reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(pi._id, { harnessSessionId: "pi-ordinary" });
  });
  const followUp = await owner.mutation(api.messages.send, {
    roomId,
    body: "SOLO-FOLLOWUP",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  expect(await runTurn(t, runnerId, followUp, "SOLO-REPLY", "solo-next")).toBe(
    "ordinary-session"
  );
  expect(await sessionOf(t, claude._id)).toBe("solo-next");

  await addMember(owner, dana, roomId);
  expect(await sessionOf(t, claude._id)).toBeFalsy();
  expect(await sessionOf(t, pi._id)).toBe("pi-ordinary");
  const resets = async () =>
    (await t.run((ctx) => ctx.db.query("ledger").collect())).filter(
      (e) => e.type === "participant.session_reset"
    );
  expect((await resets()).map((e) => e.subjectId)).toEqual([claude._id]);

  const ordinary = await dana.mutation(api.messages.send, {
    roomId,
    body: "What did you tell Robert?",
    toParticipantId: claude._id,
  });
  expect(
    await runTurn(t, runnerId, ordinary!, "Nothing I recall", "fresh-1")
  ).toBeUndefined();
  expect(await sessionOf(t, claude._id)).toBe("fresh-1");

  const erin = t.withIdentity({
    email: "erin@example.com",
    subject: "erin",
    name: "Erin",
  });
  await addMember(owner, erin, roomId, "erin@example.com");
  expect(await sessionOf(t, claude._id)).toBe("fresh-1");
  expect(await resets()).toHaveLength(1);
});

test("a follow-up still running when the first teammate joins does not save its session as the ordinary one", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
    withMember: false,
  });
  const { reviewTurnId } = await revealedReview(
    t,
    owner,
    roomId,
    runnerId,
    claude._id,
    pi._id
  );
  const followUp = await owner.mutation(api.messages.send, {
    roomId,
    body: "SOLO-FOLLOWUP",
    toParticipantId: claude._id,
    reviewTurnId,
  });
  const command = await commandFor(t, runnerId, followUp);
  await t.mutation(api.runner.claim, {
    secret: SECRET,
    commandId: command._id,
  });
  await t.mutation(api.runner.start, {
    secret: SECRET,
    turnId: followUp,
    harnessVersion: "test",
  });

  await addMember(owner, dana, roomId);
  await t.mutation(api.runner.finish, {
    secret: SECRET,
    turnId: followUp,
    commandId: command._id,
    finalText: "SOLO-REPLY",
    sessionId: "solo-next",
    transcriptRef: "/f",
  });
  expect(await sessionOf(t, claude._id)).toBeFalsy();
});

test("a member cannot cancel a review turn; stopping a turn records who stopped it", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi, ownerHuman } =
    await setup({ withMember: true });
  await owner.mutation(api.rituals.begin, {
    roomId,
    request: "Review independently",
    participantIds: [claude._id, pi._id],
  });
  const reviewTurns = (
    await t.query(api.runner.pendingCommands, { secret: SECRET, runnerId })
  ).map((c) => c.turnId);
  await expect(
    dana.mutation(api.messages.cancel, { turnId: reviewTurns[0]! })
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    expect((await ctx.db.get(reviewTurns[0]!))!.status).toBe("queued");
  });
  await owner.mutation(api.messages.cancel, { turnId: reviewTurns[0]! });

  const danaParticipant = (await owner.query(api.rooms.get, {
    roomId,
  }))!.participants.find((p) => p.displayName === "Dana")!;
  const ordinary = await owner.mutation(api.messages.send, {
    roomId,
    body: "Start something",
    toParticipantId: claude._id,
  });
  await dana.mutation(api.messages.cancel, { turnId: ordinary });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ordinary))!.status).toBe("interrupted");
    const interrupted = (await ctx.db.query("ledger").collect()).filter(
      (e) => e.type === "turn.interrupted"
    );
    expect(
      interrupted.find((e) => e.subjectId === reviewTurns[0])!
        .actorParticipantId
    ).toBe(ownerHuman._id);
    expect(
      interrupted.find((e) => e.subjectId === ordinary)!.actorParticipantId
    ).toBe(danaParticipant._id);
  });
});

test("a message sent by the teammate is authored by the teammate, and removal ends sending", async () => {
  const { t, owner, dana, roomId, claude, ownerHuman } = await setup({
    withMember: true,
  });
  const danaParticipant = (await owner.query(api.rooms.get, {
    roomId,
  }))!.participants.find((p) => p.displayName === "Dana")!;
  await dana.mutation(api.messages.send, {
    roomId,
    body: "hello from Dana",
    toParticipantId: claude._id,
  });
  await owner.mutation(api.messages.send, {
    roomId,
    body: "hello from Robert",
    toParticipantId: claude._id,
  });
  const items = await owner.query(api.messages.timeline, { roomId });
  const messages = items.filter((i) => i.kind === "message");
  expect(
    messages.find((m) => m.kind === "message" && m.body === "hello from Dana")!
      .authorParticipantId
  ).toBe(danaParticipant._id);
  expect(
    messages.find(
      (m) => m.kind === "message" && m.body === "hello from Robert"
    )!.authorParticipantId
  ).toBe(ownerHuman._id);
  await t.run(async (ctx) => {
    const posted = (await ctx.db.query("ledger").collect()).filter(
      (e) => e.type === "message.posted"
    );
    expect(posted.map((e) => e.actorParticipantId)).toEqual([
      danaParticipant._id,
      ownerHuman._id,
    ]);
  });

  const { members } = await owner.query(api.members.list, { roomId });
  await owner.mutation(api.members.remove, {
    memberId: members.find((m) => m.role === "member")!._id,
  });
  await expect(
    dana.mutation(api.messages.send, {
      roomId,
      body: "still here?",
      toParticipantId: claude._id,
    })
  ).rejects.toThrow();
});
