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
import { defined } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";

type T = TestConvex<typeof schema>;
type Caller = ReturnType<T["withIdentity"]>;

// The texts a view must show but does not.
const absent = (view: string, texts: string[]) =>
  texts.filter((text) => !view.includes(text));

// The texts a view must not show but does.
const present = (view: string, texts: string[]) =>
  texts.filter((text) => view.includes(text));

const runAllTimers = () => {
  vi.runAllTimers();
};

const addMember = async (
  owner: Caller,
  member: Caller,
  roomId: Id<"rooms">,
  email = "dana@example.com"
) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => await Promise.resolve(Response.json([{ id: "user_1" }])))
  );
  const invite = await owner.action(api.invites.create, { email, roomId });
  const [, token] = invite.url.split("/invite/");
  assert(token !== undefined, "invite url has a token");
  await member.mutation(api.invites.accept, { token });
  vi.unstubAllGlobals();
};

const setup = async ({ withMember }: { withMember: boolean }) => {
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
  const room = await owner.query(api.rooms.get, { roomId });
  assert(room, "owner can read the room");
  const claude = room.participants.find((p) => p.harness === "claude");
  const pi = room.participants.find((p) => p.harness === "pi");
  const ownerHuman = room.participants.find(
    (p) => p.kind === "human" && p.displayName === "Robert"
  );
  assert(claude, "room has a Claude participant");
  assert(pi, "room has a Pi participant");
  assert(ownerHuman, "room has Robert");
  await t.run(async (ctx) => {
    await ctx.db.patch(claude._id, { harnessSessionId: "ordinary-session" });
  });
  return { claude, dana, owner, ownerHuman, pi, roomId, runnerId, t };
};

const danaParticipantOf = async (owner: Caller, roomId: Id<"rooms">) => {
  const room = await owner.query(api.rooms.get, { roomId });
  const dana = room?.participants.find((p) => p.displayName === "Dana");
  assert(dana, "room has Dana");
  return dana;
};

// Starts a review with Claude and Pi. Claude answers; Pi fails. Returns once revealed.
const revealedReview = async (
  t: T,
  owner: Caller,
  roomId: Id<"rooms">,
  runnerId: Id<"runners">,
  claude: Id<"participants">,
  pi: Id<"participants">
) => {
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
      await Promise.all(commands.map(async (c) => await ctx.db.get(c.turnId)))
  );
  const claudeCommand =
    commands[turns.findIndex((turn) => turn?.participantId === claude)];
  const piCommand =
    commands[turns.findIndex((turn) => turn?.participantId === pi)];
  assert(claudeCommand, "the review queued a Claude turn");
  assert(piCommand, "the review queued a Pi turn");
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
  await t.finishAllScheduledFunctions(runAllTimers);
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
};

const commandFor = async (
  t: T,
  runnerId: Id<"runners">,
  turnId: Id<"turns">
) => {
  const commands = await t.query(api.runner.pendingCommands, {
    runnerId,
    secret: SECRET,
  });
  const command = commands.find((c) => c.turnId === turnId);
  assert(command, "the turn has a pending command");
  return command;
};

// Claims, streams and finishes one ordinary or follow-up turn. Returns the session id the runner was told to resume.
const runTurn = async (
  t: T,
  runnerId: Id<"runners">,
  turnId: Id<"turns">,
  finalText: string,
  sessionId: string
) => {
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
  assert(job?.participant, "the claim carries its participant");
  return job.participant.sessionId;
};

const sessionOf = async (t: T, participantId: Id<"participants">) =>
  await t.run(async (ctx) => {
    const participant = await ctx.db.get(participantId);
    assert(participant, "the participant exists");
    return participant.harnessSessionId;
  });

const followUpSessionsOf = async (t: T, ritualId: Id<"rituals">) =>
  await t.run(async (ctx) => {
    const ritual = await ctx.db.get(ritualId);
    assert(ritual, "the review exists");
    return ritual.followUpSessions?.map(({ participantId, sessionId }) => ({
      participantId,
      sessionId,
    }));
  });

// Every document tool call a model can make, against the document's first block.
const everyDocumentTool = async (
  t: T,
  roomId: Id<"rooms">,
  turnId: Id<"turns">,
  text: string
) => {
  const blockId = await t.run(async (ctx) => {
    const blocks = await ctx.db.query("blocks").collect();
    return defined(blocks.find((b) => b.roomId === roomId))._id;
  });
  const s = { secret: SECRET, turnId };
  return {
    read: await t.query(api.documentTools.readDocumentForTurn, s),
    writes: [
      await t.mutation(api.documentTools.addBlockForTurn, {
        ...s,
        kind: "paragraph",
        text,
      }),
      await t.mutation(api.documentTools.updateBlockForTurn, {
        ...s,
        baseRev: 1,
        blockId,
        text,
      }),
      await t.mutation(api.documentTools.deleteBlockForTurn, {
        ...s,
        baseRev: 1,
        blockId,
      }),
      await t.mutation(api.documentTools.commentForTurn, {
        ...s,
        blockId,
        body: text,
        quote: "What",
      }),
    ],
  };
};

const documentRows = async (t: T) =>
  await t.run(async (ctx) => {
    const tables = [
      "documents",
      "blocks",
      "changeSets",
      "blockRevisions",
      "documentCheckpoints",
      "threads",
      "comments",
    ] as const;
    return JSON.stringify(
      await Promise.all(
        tables.map(async (table) => await ctx.db.query(table).collect())
      )
    );
  });

describe("review isolation in shared rooms", () => {
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

  it("a member never sees review answers or follow-ups, while the owner still does", async () => {
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
    const ownerAfterReveal = JSON.stringify(
      await owner.query(api.messages.timeline, { roomId })
    );
    const danaAfterReveal = JSON.stringify(
      await dana.query(api.messages.timeline, { roomId })
    );

    const followUpId = await owner.mutation(api.messages.send, {
      body: "FOLLOWUP-QUESTION",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(followUpId, "the follow-up starts a turn");
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
    const danaLive = JSON.stringify(
      await dana.query(api.agent.live, { roomId })
    );
    const ownerLive = JSON.stringify(
      await owner.query(api.agent.live, { roomId })
    );
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
    const ritual = await owner.query(api.rituals.get, { ritualId });
    const decision = ritual?.decisions[0];
    assert(decision, "the review has a decision");
    const decisionTurnId = await owner.mutation(api.messages.send, {
      body: "DECISION-FOLLOWUP",
      decisionId: decision._id,
      roomId,
      toParticipantId: claude._id,
    });
    assert(decisionTurnId, "the decision follow-up starts a turn");
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
    const danaView = JSON.stringify(
      await dana.query(api.messages.timeline, { roomId })
    );
    expect({
      afterReveal: absent(ownerAfterReveal, ["REVIEW-ANSWER"]),
      final: absent(ownerView, [
        "REVIEW-ANSWER",
        "FOLLOWUP-QUESTION",
        "FOLLOWUP-REPLY",
        "DECISION-FOLLOWUP",
        "DECISION-REPLY",
      ]),
      live: absent(ownerLive, ["FOLLOWUP-PARTIAL"]),
    }).toStrictEqual({ afterReveal: [], final: [], live: [] });
    expect({
      afterReveal: present(danaAfterReveal, ["REVIEW"]),
      final: present(danaView, [
        "REVIEW",
        "FOLLOWUP",
        "DECISION",
        "independent review",
      ]),
      live: present(danaLive, ["FOLLOWUP"]),
      whileRunning: present(danaWhileRunning, ["FOLLOWUP", followUpId]),
    }).toStrictEqual({
      afterReveal: [],
      final: [],
      live: [],
      whileRunning: [],
    });

    await expect(
      dana.mutation(api.messages.send, {
        body: "sneak",
        reviewTurnId,
        roomId,
        toParticipantId: claude._id,
      })
    ).rejects.toThrow("Only the owner can follow up a review");
    await expect(
      dana.mutation(api.messages.send, {
        body: "sneak",
        decisionId: decision._id,
        roomId,
        toParticipantId: claude._id,
      })
    ).rejects.toThrow("Only the owner can follow up a review");

    const ownerRooms = await owner.query(api.rooms.list, {});
    const [danaRoom] = await dana.query(api.rooms.list, {});
    assert(danaRoom, "Dana can list the room");
    expect({
      memberSeesReadyReviews: Object.keys(danaRoom).includes("readyReviews"),
      ownerReadyReviews: ownerRooms.find((r) => r._id === roomId)?.readyReviews,
    }).toStrictEqual({ memberSeesReadyReviews: false, ownerReadyReviews: 1 });
  });

  it("the owner answering a follow-up card by chat stays hidden from a member", async () => {
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
    assert(followUpId, "the follow-up starts a turn");
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
          allowFreeText: true,
          header: "Q",
          id: "q",
          multiSelect: false,
          options: [{ description: "a", label: "A" }],
          text: "Which?",
        },
      ],
      requestId: "req-1",
      secret: SECRET,
      turnId: followUpId,
    });
    await expect(
      owner.mutation(api.messages.send, {
        body: "CARD-CHAT-ANSWER",
        roomId,
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

  it("a member never receives turn prompts", async () => {
    const { dana, roomId, claude } = await setup({ withMember: true });
    await dana.mutation(api.messages.send, {
      body: "hello",
      roomId,
      toParticipantId: claude._id,
    });
    const items = await dana.query(api.messages.timeline, { roomId });
    expect(items.some((i) => i.kind === "turn")).toBeTruthy();
    for (const item of items) {
      expect(Object.keys(item)).not.toContain("prompt");
    }
  });

  it("in a shared room a follow-up runs on a session stored on its review, never the ordinary one", async () => {
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
    const sessions = async (resumed: string | undefined) => ({
      followUpSessions: await followUpSessionsOf(t, ritualId),
      ordinarySession: await sessionOf(t, claude._id),
      resumed,
    });

    const first = await owner.mutation(api.messages.send, {
      body: "Why?",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(first, "the follow-up starts a turn");
    await t.run(async (ctx) => {
      const turn = await ctx.db.get(first);
      expect(turn?.followUp).toMatchObject({ ritualId });
    });
    await expect(
      sessions(await runTurn(t, runnerId, first, "Because", "followup-1"))
    ).resolves.toStrictEqual({
      followUpSessions: [
        { participantId: claude._id, sessionId: "followup-1" },
      ],
      ordinarySession: "ordinary-session",
      resumed: undefined,
    });

    const second = await owner.mutation(api.messages.send, {
      body: "And then?",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(second, "the second follow-up starts a turn");
    await expect(
      sessions(await runTurn(t, runnerId, second, "Then this", "followup-2"))
    ).resolves.toStrictEqual({
      followUpSessions: [
        { participantId: claude._id, sessionId: "followup-2" },
      ],
      ordinarySession: "ordinary-session",
      resumed: "followup-1",
    });

    const ordinary = await dana.mutation(api.messages.send, {
      body: "What did we decide?",
      roomId,
      toParticipantId: claude._id,
    });
    assert(ordinary, "the teammate message starts a turn");
    await expect(
      sessions(await runTurn(t, runnerId, ordinary, "No idea", "ordinary-2"))
    ).resolves.toStrictEqual({
      followUpSessions: [
        { participantId: claude._id, sessionId: "followup-2" },
      ],
      ordinarySession: "ordinary-2",
      resumed: "ordinary-session",
    });
  });

  it("a follow-up queued behind a teammate message runs as its own turn", async () => {
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
    const teammateTurn = await dana.mutation(api.messages.send, {
      body: "TEAMMATE-ASK",
      roomId,
      toParticipantId: claude._id,
    });
    assert(teammateTurn, "the teammate message starts a turn");
    await expect(
      owner.mutation(api.messages.send, {
        body: "Expand on it",
        reviewTurnId,
        roomId,
        toParticipantId: claude._id,
      })
    ).resolves.toBeNull();
    await expect(
      dana.mutation(api.messages.send, {
        body: "TEAMMATE-LATER",
        roomId,
        toParticipantId: claude._id,
      })
    ).resolves.toBeNull();
    const ordinaryTurns = async () => {
      const turns = await t.run(
        async (ctx) => await ctx.db.query("turns").collect()
      );
      return turns.filter(
        (x) => x.ritualId === undefined && x.participantId === claude._id
      );
    };

    await runTurn(t, runnerId, teammateTurn, "answer", "ordinary-2");
    const [, followUpTurn] = await ordinaryTurns();
    assert(followUpTurn, "the follow-up has its own turn");
    expect({
      followUp: followUpTurn.followUp,
      prompt: present(followUpTurn.prompt, ["Expand on it", "TEAMMATE"]),
    }).toMatchObject({ followUp: { ritualId }, prompt: ["Expand on it"] });

    await runTurn(t, runnerId, followUpTurn._id, "expanded", "followup-1");
    const turnsAfterFollowUp = await ordinaryTurns();
    const later = turnsAfterFollowUp.at(2);
    assert(later, "the later teammate message has its own turn");
    expect({
      followUp: later.followUp,
      prompt: present(later.prompt, [
        "TEAMMATE-LATER",
        "Expand on it",
        "REVIEW-ANSWER",
      ]),
    }).toStrictEqual({ followUp: undefined, prompt: ["TEAMMATE-LATER"] });
    await t.run(async (ctx) => {
      const teammate = await ctx.db.get(teammateTurn);
      assert(teammate, "the teammate turn exists");
      expect({
        followUp: teammate.followUp,
        prompt: present(teammate.prompt, ["REVIEW-ANSWER"]),
      }).toStrictEqual({ followUp: undefined, prompt: [] });
    });
  });

  it("in a solo room with a document a follow-up runs on its own session, never the ordinary one, and stays hidden from a later member", async () => {
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
    const hasDocument =
      (await owner.query(api.documents.get, { roomId })) !== null;
    const followUp = await owner.mutation(api.messages.send, {
      body: "SOLO-FOLLOWUP",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(followUp, "the follow-up starts a turn");
    const firstResumed = await runTurn(
      t,
      runnerId,
      followUp,
      "SOLO-REPLY",
      "solo-next"
    );
    const afterFirst = {
      followUpSessions: await followUpSessionsOf(t, ritualId),
      ordinarySession: await sessionOf(t, claude._id),
    };

    const second = await owner.mutation(api.messages.send, {
      body: "SOLO-AGAIN",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(second, "the second follow-up starts a turn");
    const secondResumed = await runTurn(
      t,
      runnerId,
      second,
      "SOLO-REPLY-2",
      "solo-next-2"
    );
    const ordinary = await owner.mutation(api.messages.send, {
      body: "Back to work",
      roomId,
      toParticipantId: claude._id,
    });
    assert(ordinary, "the ordinary message starts a turn");
    const ordinaryResumed = await runTurn(
      t,
      runnerId,
      ordinary,
      "ok",
      "ordinary-2"
    );

    await addMember(owner, dana, roomId);
    const ownerSees = JSON.stringify(
      await owner.query(api.messages.timeline, { roomId })
    );
    const memberSees = JSON.stringify(
      await dana.query(api.messages.timeline, { roomId })
    );
    expect({
      afterFirst,
      firstResumed,
      hasDocument,
      memberSeesFollowUp: memberSees.includes("SOLO"),
      ordinaryResumed,
      ownerSeesReply: ownerSees.includes("SOLO-REPLY"),
      secondResumed,
    }).toStrictEqual({
      afterFirst: {
        followUpSessions: [
          { participantId: claude._id, sessionId: "solo-next" },
        ],
        ordinarySession: "ordinary-session",
      },
      firstResumed: undefined,
      hasDocument: true,
      memberSeesFollowUp: false,
      ordinaryResumed: "ordinary-session",
      ownerSeesReply: true,
      secondResumed: "solo-next",
    });
  });

  it("the first teammate to join resets the session of each agent that ran a follow-up alone with the owner before rooms had a document", async () => {
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
    assert(followUp, "the follow-up starts a turn");
    await runTurn(t, runnerId, followUp, "SOLO-REPLY", "solo-next");
    // As such a follow-up was claimed then: on the ordinary session.
    await t.run(async (ctx) => {
      const turn = await ctx.db.get(followUp);
      assert(turn?.followUp, "the turn is a follow-up");
      await ctx.db.patch(followUp, {
        followUp: { ...turn.followUp, separateSession: false },
      });
      await ctx.db.patch(claude._id, {
        documentRevSeen: 3,
        harnessSessionId: "solo-next",
      });
    });

    await addMember(owner, dana, roomId);
    await expect(sessionOf(t, claude._id)).resolves.toBeFalsy();
    await t.run(async (ctx) => {
      const awaited = await ctx.db.get(claude._id);
      expect(awaited?.documentRevSeen).toBeUndefined();
    });
    const resets = async () => {
      const entries = await t.run(
        async (ctx) => await ctx.db.query("ledger").collect()
      );
      return entries.filter((e) => e.type === "participant.session_reset");
    };
    const resetsAfterJoin = await resets();
    expect({
      piSession: await sessionOf(t, pi._id),
      resetSubjects: resetsAfterJoin.map((e) => e.subjectId),
    }).toStrictEqual({ piSession: "pi-ordinary", resetSubjects: [claude._id] });

    const ordinary = await dana.mutation(api.messages.send, {
      body: "What did you tell Robert?",
      roomId,
      toParticipantId: claude._id,
    });
    assert(ordinary, "the teammate message starts a turn");
    const freshResumed = await runTurn(
      t,
      runnerId,
      ordinary,
      "Nothing I recall",
      "fresh-1"
    );
    expect({
      resumed: freshResumed,
      session: await sessionOf(t, claude._id),
    }).toStrictEqual({ resumed: undefined, session: "fresh-1" });

    const erin = t.withIdentity({
      email: "erin@example.com",
      name: "Erin",
      subject: "erin",
    });
    await addMember(owner, erin, roomId, "erin@example.com");
    const resetsAfterSecondJoin = await resets();
    expect({
      resets: resetsAfterSecondJoin.length,
      session: await sessionOf(t, claude._id),
    }).toStrictEqual({ resets: 1, session: "fresh-1" });
  });

  it("a follow-up on its own session resets nothing when the first teammate joins, and never saves as the ordinary one", async () => {
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
    assert(followUp, "the follow-up starts a turn");
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
    await expect(sessionOf(t, claude._id)).resolves.toBe("ordinary-session");
    await expect(followUpSessionsOf(t, ritualId)).resolves.toStrictEqual([
      { participantId: claude._id, sessionId: "solo-next" },
    ]);
    const entries = await t.run(
      async (ctx) => await ctx.db.query("ledger").collect()
    );
    expect(
      entries.filter((e) => e.type === "participant.session_reset")
    ).toHaveLength(0);
  });

  it("a member cannot cancel a review turn; stopping a turn records who stopped it", async () => {
    const { t, owner, dana, runnerId, roomId, claude, pi, ownerHuman } =
      await setup({ withMember: true });
    await owner.mutation(api.rituals.begin, {
      participantIds: [claude._id, pi._id],
      request: "Review independently",
      roomId,
    });
    const pending = await t.query(api.runner.pendingCommands, {
      runnerId,
      secret: SECRET,
    });
    const [reviewTurn] = pending.map((c) => c.turnId);
    assert(reviewTurn, "the review queued a turn");
    await expect(
      dana.mutation(api.messages.cancel, { turnId: reviewTurn })
    ).rejects.toThrow("Only the owner can stop a review");
    await t.run(async (ctx) => {
      const turn = await ctx.db.get(reviewTurn);
      expect(turn?.status).toBe("queued");
    });
    await owner.mutation(api.messages.cancel, { turnId: reviewTurn });

    const danaParticipant = await danaParticipantOf(owner, roomId);
    const ordinary = await owner.mutation(api.messages.send, {
      body: "Start something",
      roomId,
      toParticipantId: claude._id,
    });
    assert(ordinary, "the message starts a turn");
    await dana.mutation(api.messages.cancel, { turnId: ordinary });
    await t.run(async (ctx) => {
      const turn = await ctx.db.get(ordinary);
      expect(turn?.status).toBe("interrupted");
      const ledger = await ctx.db.query("ledger").collect();
      const interrupted = ledger.filter((e) => e.type === "turn.interrupted");
      const reviewStop = interrupted.find((e) => e.subjectId === reviewTurn);
      const ordinaryStop = interrupted.find((e) => e.subjectId === ordinary);
      assert(reviewStop, "stopping the review turn is in the ledger");
      assert(ordinaryStop, "stopping the ordinary turn is in the ledger");
      expect(reviewStop.actorParticipantId).toBe(ownerHuman._id);
      expect(ordinaryStop.actorParticipantId).toBe(danaParticipant._id);
    });
  });

  it("a message sent by the teammate is authored by the teammate, and removal ends sending", async () => {
    const { t, owner, dana, roomId, claude, ownerHuman } = await setup({
      withMember: true,
    });
    const danaParticipant = await danaParticipantOf(owner, roomId);
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
      messages.find((m) => m.kind === "message" && m.body === "hello from Dana")
    ).toMatchObject({ authorParticipantId: danaParticipant._id });
    expect(
      messages.find(
        (m) => m.kind === "message" && m.body === "hello from Robert"
      )
    ).toMatchObject({ authorParticipantId: ownerHuman._id });
    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      const posted = ledger.filter((e) => e.type === "message.posted");
      expect(posted.map((e) => e.actorParticipantId)).toStrictEqual([
        danaParticipant._id,
        ownerHuman._id,
      ]);
    });

    const { members } = await owner.query(api.members.list, { roomId });
    const member = members.find((m) => m.role === "member");
    assert(member, "Dana is a member");
    await owner.mutation(api.members.remove, { memberId: member._id });
    await expect(
      dana.mutation(api.messages.send, {
        body: "still here?",
        roomId,
        toParticipantId: claude._id,
      })
    ).rejects.toThrow("You are no longer a member of this room");
  });

  it("with a teammate in the room, neither the review nor its follow-up can change the document, and only the follow-up is shown it", async () => {
    const { t, owner, runnerId, roomId, claude, pi } = await setup({
      withMember: true,
    });
    const before = await documentRows(t);

    await owner.mutation(api.rituals.begin, {
      participantIds: [claude._id, pi._id],
      request: "Review independently",
      roomId,
    });
    const reviewCommands = await t.query(api.runner.pendingCommands, {
      runnerId,
      secret: SECRET,
    });
    for (const command of reviewCommands) {
      const job = defined(
        // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
        await t.mutation(api.runner.claim, {
          commandId: command._id,
          secret: SECRET,
        })
      );
      expect(job.type === "run_turn" && job.documentMode).toBe("none");
      expect(job.type === "run_turn" && job.turn.prompt).not.toContain(
        "room_document"
      );
      expect(job.type === "run_turn" && job.turn.prompt).not.toContain(
        "What's happened"
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      await t.mutation(api.runner.start, {
        harnessVersion: "test",
        secret: SECRET,
        turnId: command.turnId,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      const { writes, read } = await everyDocumentTool(
        t,
        roomId,
        command.turnId,
        "REVIEW-WRITE"
      );
      for (const result of writes) {
        expect(result).toMatchObject({
          ok: false,
          reason: "no_document_access",
        });
      }
      expect(read).toMatchObject({ ok: false, reason: "no_document_access" });
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      await t.mutation(api.runner.finish, {
        commandId: command._id,
        finalText: "REVIEW-ANSWER",
        secret: SECRET,
        sessionId: "review-session",
        transcriptRef: "/r",
        turnId: command.turnId,
      });
    }
    await t.finishAllScheduledFunctions(runAllTimers);
    await t.mutation(api.runners.heartbeat, {
      harnesses: [
        { id: "claude", version: "test" },
        { id: "pi", version: "test" },
      ],
      machine: "test",
      name: "test",
      secret: SECRET,
    });
    const reviewTurnId = defined(reviewCommands[0]).turnId;
    const reviewer = defined(
      await t.run(async (ctx) => await ctx.db.get(reviewTurnId))
    ).participantId;

    const followUp = await owner.mutation(api.messages.send, {
      body: "Expand on it",
      reviewTurnId,
      roomId,
      toParticipantId: reviewer,
    });
    assert(followUp, "the message starts a turn");
    const command = await commandFor(t, runnerId, followUp);
    const job = defined(
      await t.mutation(api.runner.claim, {
        commandId: command._id,
        secret: SECRET,
      })
    );
    const prompt = job.type === "run_turn" ? job.turn.prompt : "";
    expect({
      mode: job.type === "run_turn" && job.documentMode,
      shown: [
        "<room_document",
        "What's happened",
        "Room document: read-only in this turn.",
      ].map((fragment) => prompt.includes(fragment)),
    }).toStrictEqual({ mode: "read", shown: [true, true, true] });
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId: followUp,
    });
    const { writes, read } = await everyDocumentTool(
      t,
      roomId,
      followUp,
      "REVIEW-ANSWER"
    );
    for (const result of writes) {
      expect(result).toMatchObject({ ok: false, reason: "read_only" });
    }
    expect(read).toMatchObject({ ok: true, writable: false });
    await t.mutation(api.runner.finish, {
      commandId: command._id,
      finalText: "FOLLOWUP-REPLY",
      secret: SECRET,
      sessionId: "followup-session",
      transcriptRef: "/f",
      turnId: followUp,
    });

    await expect(documentRows(t)).resolves.toBe(before);
  });

  it("after a solo review and follow-up, an ordinary turn and a teammate joining, the review never reaches the document or its history", async () => {
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
      body: "Expand on it",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(followUp, "the message starts a turn");
    const command = await commandFor(t, runnerId, followUp);
    const job = defined(
      await t.mutation(api.runner.claim, {
        commandId: command._id,
        secret: SECRET,
      })
    );
    expect(
      job.type === "run_turn" && job.participant.sessionId
    ).toBeUndefined();
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId: followUp,
    });
    const { writes } = await everyDocumentTool(
      t,
      roomId,
      followUp,
      "REVIEW-ANSWER, expanded"
    );
    for (const result of writes) {
      expect(result).toMatchObject({ ok: false });
    }
    await t.mutation(api.runner.finish, {
      commandId: command._id,
      finalText: "REVIEW-ANSWER, expanded",
      secret: SECRET,
      sessionId: "followup-session",
      transcriptRef: "/f",
      turnId: followUp,
    });

    const ordinary = await owner.mutation(api.messages.send, {
      body: "Note what we found",
      roomId,
      toParticipantId: claude._id,
    });
    assert(ordinary, "the message starts a turn");
    const ordinaryCommand = await commandFor(t, runnerId, ordinary);
    const ordinaryJob = defined(
      await t.mutation(api.runner.claim, {
        commandId: ordinaryCommand._id,
        secret: SECRET,
      })
    );
    expect({
      leaksReview: JSON.stringify(ordinaryJob).includes("REVIEW-ANSWER"),
      session:
        ordinaryJob.type === "run_turn" && ordinaryJob.participant.sessionId,
    }).toStrictEqual({ leaksReview: false, session: "ordinary-session" });
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId: ordinary,
    });
    const added = await t.mutation(api.documentTools.addBlockForTurn, {
      kind: "paragraph",
      secret: SECRET,
      text: "An ordinary finding.",
      turnId: ordinary,
    });
    expect(added).toMatchObject({ ok: true });
    await t.mutation(api.runner.finish, {
      commandId: ordinaryCommand._id,
      finalText: "Noted",
      secret: SECRET,
      sessionId: "ordinary-session",
      transcriptRef: "/o",
      turnId: ordinary,
    });

    await addMember(owner, dana, roomId);
    const { page } = await dana.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 50 },
      roomId,
    });
    const versions = await Promise.all(
      page.map(
        async (c: { _id: Id<"changeSets"> }) =>
          await dana.query(api.history.version, { changeSetId: c._id })
      )
    );
    const seen = JSON.stringify([
      await dana.query(api.documents.get, { roomId }),
      await dana.query(api.threads.list, { roomId }),
      versions,
      await t.run(async (ctx) => [
        await ctx.db.query("blockRevisions").collect(),
        await ctx.db.query("comments").collect(),
      ]),
    ]);
    expect({
      leaksReview: seen.includes("REVIEW-ANSWER"),
      shown: seen.includes("An ordinary finding."),
    }).toStrictEqual({ leaksReview: false, shown: true });
  });

  it("an ordinary turn after a shared-room follow-up is shown what changed since its own session last saw the document", async () => {
    const { t, owner, dana, runnerId, roomId, claude, pi } = await setup({
      withMember: true,
    });
    const { blocks } = defined(
      await owner.query(api.documents.get, { roomId })
    );
    const edit = async (index: number, text: string) => {
      await dana.mutation(api.blocks.startEdit, {
        blockId: defined(blocks[index])._id,
      });
      await dana.mutation(api.blocks.save, {
        baseRev: defined(blocks[index]).rev,
        blockId: defined(blocks[index])._id,
        text,
      });
      await dana.mutation(api.blocks.stopEdit, {
        blockId: defined(blocks[index])._id,
      });
    };
    const first = await owner.mutation(api.messages.send, {
      body: "Start",
      roomId,
      toParticipantId: claude._id,
    });
    assert(first, "the message starts a turn");
    await runTurn(t, runnerId, first, "ok", "ordinary-session");
    await edit(0, "EDIT-BEFORE-FOLLOWUP");

    const { reviewTurnId } = await revealedReview(
      t,
      owner,
      roomId,
      runnerId,
      claude._id,
      pi._id
    );
    const followUp = await owner.mutation(api.messages.send, {
      body: "Why?",
      reviewTurnId,
      roomId,
      toParticipantId: claude._id,
    });
    assert(followUp, "the message starts a turn");
    const followUpCommand = await commandFor(t, runnerId, followUp);
    const followUpJob = defined(
      await t.mutation(api.runner.claim, {
        commandId: followUpCommand._id,
        secret: SECRET,
      })
    );
    // A session the follow-up has never used gets the whole document.
    expect(
      followUpJob.type === "run_turn" && followUpJob.turn.prompt
    ).toContain('view="full"');
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId: followUp,
    });
    await t.mutation(api.runner.finish, {
      commandId: followUpCommand._id,
      finalText: "Because",
      secret: SECRET,
      sessionId: "followup-session",
      transcriptRef: "/f",
      turnId: followUp,
    });
    await edit(1, "EDIT-AFTER-FOLLOWUP");

    const next = await owner.mutation(api.messages.send, {
      body: "Carry on",
      roomId,
      toParticipantId: claude._id,
    });
    assert(next, "the message starts a turn");
    const command = await commandFor(t, runnerId, next);
    const job = defined(
      await t.mutation(api.runner.claim, {
        commandId: command._id,
        secret: SECRET,
      })
    );
    const prompt = job.type === "run_turn" ? job.turn.prompt : "";
    expect({
      session: job.type === "run_turn" && job.participant.sessionId,
      shown: [
        'view="changes"',
        "EDIT-BEFORE-FOLLOWUP",
        "EDIT-AFTER-FOLLOWUP",
        "Open questions",
      ].map((fragment) => prompt.includes(fragment)),
    }).toStrictEqual({
      session: "ordinary-session",
      shown: [true, true, true, false],
    });
  });
});
