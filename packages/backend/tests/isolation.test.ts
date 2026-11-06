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
    name: "Robert",
    subject: "owner",
  });
  const dana = t.withIdentity({
    email: "dana@example.com",
    name: "Dana",
    subject: "dana",
  });
  const runnerId = await t.mutation(api.runners.heartbeat, {
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
    machine: "test",
    name: "test",
    secret: SECRET,
  });
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
  await owner.mutation(api.rooms.addParticipant, { harness: "pi", roomId });
  if (withMember) {
    await addMember(owner, dana, roomId);
  }
  const room = (await owner.query(api.rooms.get, { roomId }))!;
  const claude = room.participants.find((p) => p.harness === "claude")!;
  const pi = room.participants.find((p) => p.harness === "pi")!;
  const ownerHuman = room.participants.find(
    (p) => p.kind === "human" && p.displayName === "Robert"
  )!;
  await t.run(async (ctx) => {
    await ctx.db.patch(claude._id, { harnessSessionId: "ordinary-session" });
  });
  return { claude, dana, owner, ownerHuman, pi, roomId, runnerId, t };
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
  const invite = await owner.action(api.invites.create, { email, roomId });
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
    participantIds: [claude, pi],
    request: "Review independently",
    roomId,
  });
  const commands = await t.query(api.runner.pendingCommands, {
    runnerId,
    secret: SECRET,
  });
  const turns = await t.run(
    async (ctx) =>
      await Promise.all(commands.map(async (c) => ctx.db.get(c.turnId)))
  );
  const claudeCommand =
    commands[turns.findIndex((turn) => turn!.participantId === claude)]!;
  const piCommand =
    commands[turns.findIndex((turn) => turn!.participantId === pi)]!;
  await t.mutation(api.runner.claim, {
    commandId: claudeCommand._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.finish, {
    commandId: claudeCommand._id,
    finalText: "REVIEW-ANSWER",
    secret: SECRET,
    sessionId: "review-session",
    transcriptRef: "/review",
    turnId: claudeCommand.turnId,
  });
  await t.mutation(api.runner.fail, {
    commandId: piCommand._id,
    error: "REVIEW-FAILURE",
    secret: SECRET,
    turnId: piCommand.turnId,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  // Draining the workflow advances the fake clock; a live runner keeps beating.
  await t.mutation(api.runners.heartbeat, {
    harnesses: [
      { id: "claude", version: "test" },
      { id: "pi", version: "test" },
    ],
    machine: "test",
    name: "test",
    secret: SECRET,
  });
  return { reviewTurnId: claudeCommand.turnId, ritualId };
}

async function commandFor(t: T, runnerId: Id<"runners">, turnId: Id<"turns">) {
  return (
    await t.query(api.runner.pendingCommands, { runnerId, secret: SECRET })
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
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId,
  });
  await t.mutation(api.runner.finish, {
    commandId: command._id,
    finalText,
    secret: SECRET,
    sessionId,
    transcriptRef: "/turn",
    turnId,
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
    body: "FOLLOWUP-QUESTION",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  const command = await commandFor(t, runnerId, followUpId);
  await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId: followUpId,
  });
  await t.mutation(api.runner.progress, {
    commandId: command._id,
    partialText: "FOLLOWUP-PARTIAL",
    secret: SECRET,
    turnId: followUpId,
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
    commandId: command._id,
    finalText: "FOLLOWUP-REPLY",
    secret: SECRET,
    sessionId: "followup-session",
    transcriptRef: "/f",
    turnId: followUpId,
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
  const decision = (await owner.query(api.rituals.get, { ritualId }))!
    .decisions[0]!;
  const decisionTurnId = await owner.mutation(api.messages.send, {
    body: "DECISION-FOLLOWUP",
    decisionId: decision._id,
    roomId,
    toParticipantId: claude._id,
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
  ]) {
    expect(ownerView).toContain(text);
  }
  const danaView = await dana.query(api.messages.timeline, { roomId });
  for (const text of ["REVIEW", "FOLLOWUP", "DECISION", "independent review"]) {
    expect(JSON.stringify(danaView)).not.toContain(text);
  }

  await expect(
    dana.mutation(api.messages.send, {
      body: "sneak",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    })
  ).rejects.toThrow();
  await expect(
    dana.mutation(api.messages.send, {
      body: "sneak",
      decisionId: decision._id,
      roomId,
      toParticipantId: claude._id,
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
    body: "Expand on it",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  const command = await commandFor(t, runnerId, followUpId);
  await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId: followUpId,
  });
  await t.mutation(api.runner.raiseHand, {
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
    requestId: "req-1",
    secret: SECRET,
    turnId: followUpId,
  });
  await expect(
    owner.mutation(api.messages.send, {
      roomId,
      body: "CARD-CHAT-ANSWER",
      toParticipantId: claude._id,
    })
  ).resolves.toBeNull();

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
    body: "hello",
    roomId,
    toParticipantId: claude._id,
  });
  const items = await dana.query(api.messages.timeline, { roomId });
  expect(items.some((i) => i.kind === "turn")).toBe(true);
  for (const item of items) {
    expect(Object.keys(item)).not.toContain("prompt");
  }
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
    body: "Why?",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get(first))!.followUp).toMatchObject({ ritualId });
  });
  await expect(
    runTurn(t, runnerId, first, "Because", "followup-1")
  ).resolves.toBeUndefined();
  await expect(sessionOf(t, claude._id)).resolves.toBe("ordinary-session");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toEqual([
      { participantId: claude._id, sessionId: "followup-1" },
    ]);
  });

  const second = await owner.mutation(api.messages.send, {
    body: "And then?",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  await expect(
    runTurn(t, runnerId, second, "Then this", "followup-2")
  ).resolves.toBe("followup-1");
  await expect(sessionOf(t, claude._id)).resolves.toBe("ordinary-session");
  await t.run(async (ctx) => {
    expect((await ctx.db.get(ritualId))!.followUpSessions).toEqual([
      { participantId: claude._id, sessionId: "followup-2" },
    ]);
  });

  const ordinary = await dana.mutation(api.messages.send, {
    body: "What did we decide?",
    roomId,
    toParticipantId: claude._id,
  });
  await expect(
    runTurn(t, runnerId, ordinary, "No idea", "ordinary-2")
  ).resolves.toBe("ordinary-session");
  await expect(sessionOf(t, claude._id)).resolves.toBe("ordinary-2");
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
    body: "TEAMMATE-ASK",
    roomId,
    toParticipantId: claude._id,
  }))!;
  await expect(
    owner.mutation(api.messages.send, {
      roomId,
      body: "Expand on it",
      toParticipantId: claude._id,
      reviewTurnId,
    })
  ).resolves.toBeNull();
  await expect(
    dana.mutation(api.messages.send, {
      roomId,
      body: "TEAMMATE-LATER",
      toParticipantId: claude._id,
    })
  ).resolves.toBeNull();
  const ordinaryTurns = async () =>
    (await t.run(async (ctx) => ctx.db.query("turns").collect())).filter(
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
    body: "SOLO-FOLLOWUP",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  await expect(
    runTurn(t, runnerId, followUp, "SOLO-REPLY", "solo-next")
  ).resolves.toBe("ordinary-session");
  await expect(sessionOf(t, claude._id)).resolves.toBe("solo-next");
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
    body: "SOLO-FOLLOWUP",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  await expect(
    runTurn(t, runnerId, followUp, "SOLO-REPLY", "solo-next")
  ).resolves.toBe("ordinary-session");
  await expect(sessionOf(t, claude._id)).resolves.toBe("solo-next");

  await addMember(owner, dana, roomId);
  await expect(sessionOf(t, claude._id)).resolves.toBeFalsy();
  await expect(sessionOf(t, pi._id)).resolves.toBe("pi-ordinary");
  const resets = async () =>
    (await t.run(async (ctx) => ctx.db.query("ledger").collect())).filter(
      (e) => e.type === "participant.session_reset"
    );
  expect((await resets()).map((e) => e.subjectId)).toEqual([claude._id]);

  const ordinary = await dana.mutation(api.messages.send, {
    body: "What did you tell Robert?",
    roomId,
    toParticipantId: claude._id,
  });
  await expect(
    runTurn(t, runnerId, ordinary!, "Nothing I recall", "fresh-1")
  ).resolves.toBeUndefined();
  await expect(sessionOf(t, claude._id)).resolves.toBe("fresh-1");

  const erin = t.withIdentity({
    email: "erin@example.com",
    name: "Erin",
    subject: "erin",
  });
  await addMember(owner, erin, roomId, "erin@example.com");
  await expect(sessionOf(t, claude._id)).resolves.toBe("fresh-1");
  await expect(resets()).resolves.toHaveLength(1);
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
    body: "SOLO-FOLLOWUP",
    reviewTurnId,
    roomId,
    toParticipantId: claude._id,
  });
  const command = await commandFor(t, runnerId, followUp);
  await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId: followUp,
  });

  await addMember(owner, dana, roomId);
  await t.mutation(api.runner.finish, {
    commandId: command._id,
    finalText: "SOLO-REPLY",
    secret: SECRET,
    sessionId: "solo-next",
    transcriptRef: "/f",
    turnId: followUp,
  });
  await expect(sessionOf(t, claude._id)).resolves.toBeFalsy();
});

test("a member cannot cancel a review turn; stopping a turn records who stopped it", async () => {
  const { t, owner, dana, runnerId, roomId, claude, pi, ownerHuman } =
    await setup({ withMember: true });
  await owner.mutation(api.rituals.begin, {
    participantIds: [claude._id, pi._id],
    request: "Review independently",
    roomId,
  });
  const reviewTurns = (
    await t.query(api.runner.pendingCommands, { runnerId, secret: SECRET })
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
    body: "Start something",
    roomId,
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
    body: "hello from Dana",
    roomId,
    toParticipantId: claude._id,
  });
  await owner.mutation(api.messages.send, {
    body: "hello from Robert",
    roomId,
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
      body: "still here?",
      roomId,
      toParticipantId: claude._id,
    })
  ).rejects.toThrow();
});
