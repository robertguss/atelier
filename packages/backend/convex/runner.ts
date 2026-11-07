import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireRunnerSecret } from "./lib/auth";
import { closeOpenCards, expireUnanswered, withdrawCard } from "./lib/cards";
import {
  dispatchNext,
  isActiveTurnStatus,
  steerRejected,
} from "./lib/dispatch";
import { ensureDocument } from "./lib/document";
import { documentDigest, withDigest } from "./lib/documentDigest";
import { record } from "./lib/ledger";
import { required } from "./lib/required";
import { reviewFinished } from "./lib/review";
import { commitScribe, releaseScribe } from "./lib/scribe";
import { sessionResetAfter } from "./lib/sessions";
import { postComment } from "./lib/threads";
import { setStreamedText } from "./lib/turnActivity";
import { documentMode } from "./lib/visibility";
import { cardQuestion, harnessId } from "./schema";

// Functions the runner calls. Each takes the runner secret instead of a Clerk
// session. See docs/v0-spec.md, "Runner ↔ Convex protocol".

const LEASE_MS = 5 * 60_000;
const LEASE_RENEW_AFTER_MS = 30_000;
const SUMMARY_MAX = 200;

// The document rev a session has seen: the rev the turn was shown when it
// finished. Without one, a session already stored keeps its own, and a
// different session has seen no rev yet.
const revSeenBy = (
  stored: { sessionId?: string; documentRevSeen?: number },
  sessionId: string,
  documentRevSeen?: number
) =>
  documentRevSeen ??
  (stored.sessionId === sessionId ? stored.documentRevSeen : undefined);

const saveFollowUpSession = async (
  ctx: MutationCtx,
  ritualId: Id<"rituals">,
  participantId: Id<"participants">,
  sessionId: string,
  documentRevSeen?: number
) => {
  const ritual = await ctx.db.get(ritualId);
  if (!ritual) {
    return;
  }
  const sessions = ritual.followUpSessions ?? [];
  const stored = sessions.find((s) => s.participantId === participantId) ?? {};
  const others = sessions.filter((s) => s.participantId !== participantId);
  const rev = revSeenBy(stored, sessionId, documentRevSeen);
  await ctx.db.patch(ritualId, {
    followUpSessions: [
      ...others,
      {
        participantId,
        sessionId,
        ...(rev === undefined ? {} : { documentRevSeen: rev }),
      },
    ],
  });
};

// Saves the session a turn ran on, with the document rev the turn was shown
// when it finished.
const saveSession = async (
  ctx: MutationCtx,
  turn: Doc<"turns">,
  sessionId: string,
  documentRevSeen?: number
) => {
  if (turn.followUp?.separateSession === true) {
    await saveFollowUpSession(
      ctx,
      turn.followUp.ritualId,
      turn.participantId,
      sessionId,
      documentRevSeen
    );
  } else if (!(await sessionResetAfter(ctx, turn))) {
    const participant = await ctx.db.get(turn.participantId);
    await ctx.db.patch(turn.participantId, {
      documentRevSeen: revSeenBy(
        {
          documentRevSeen: participant?.documentRevSeen,
          sessionId: participant?.harnessSessionId,
        },
        sessionId,
        documentRevSeen
      ),
      harnessSessionId: sessionId,
    });
  }
};

// A runner that died or restarted will never answer the control commands it
// held for a turn, so its steers in flight go back to the queue.
const abandonControlCommands = async (
  ctx: MutationCtx,
  turn: Doc<"turns">,
  runnerId: Id<"runners">,
  error: string
) => {
  const commands = await ctx.db
    .query("commands")
    .withIndex("by_turn", (q) => q.eq("turnId", turn._id))
    .collect();
  await Promise.all(
    commands
      .filter(
        (c) =>
          c.runnerId === runnerId &&
          (c.status === "pending" || c.status === "claimed") &&
          c.type !== "run_turn"
      )
      .map(async (c) => {
        await ctx.db.patch(c._id, { error, status: "failed" });
      })
  );
  const steering = await ctx.db
    .query("messages")
    .withIndex("by_to_delivery", (q) =>
      q.eq("toParticipantId", turn.participantId).eq("delivery", "steering")
    )
    .collect();
  await Promise.all(
    steering
      .filter((m) => m.steering?.turnId === turn._id)
      .map(async (m) => {
        await ctx.db.patch(m._id, { delivery: "queued", steering: undefined });
      })
  );
};

// Also releases a scribe run the turn was acting for, leaving the document
// as it was before the run.
export const failTurn = async (
  ctx: MutationCtx,
  turnId: Id<"turns">,
  commandId: Id<"commands">,
  error: string,
  interrupted: boolean,
  transcriptRef?: string,
  { runnerLost = false }: { runnerLost?: boolean } = {}
) => {
  const turn = await ctx.db.get(turnId);
  if (!turn || !isActiveTurnStatus(turn.status)) {
    return;
  }
  const command = await ctx.db.get(commandId);
  if (
    !command ||
    command.turnId !== turnId ||
    !["pending", "claimed"].includes(command.status)
  ) {
    throw new Error("Invalid turn command");
  }
  await ctx.db.patch(commandId, {
    error,
    leaseExpiresAt: undefined,
    status: "failed",
  });
  if (runnerLost) {
    await abandonControlCommands(ctx, turn, command.runnerId, error);
  }
  // A runner that went away expires the turn's open cards; any other failure
  // stopped the turn, which cancels them. Neither records a decision.
  await closeOpenCards(
    ctx,
    turnId,
    runnerLost ? "expired" : "cancelled",
    error
  );
  if (turn.scribeRunId) {
    await releaseScribe(ctx, turn.scribeRunId, "released", error);
  }
  await ctx.db.patch(turnId, {
    endedAt: Date.now(),
    error,
    status: interrupted && !turn.ritualId ? "interrupted" : "failed",
    transcriptRef,
  });
  await reviewFinished(ctx, turn);
  await record(ctx, {
    actorParticipantId: turn.participantId,
    harnessVersion: turn.harnessVersion,
    payload: { error },
    roomId: turn.roomId,
    subjectId: turnId,
    type: interrupted ? "turn.interrupted" : "turn.failed",
  });
  if (!turn.ritualId) {
    await dispatchNext(ctx, turn.participantId);
  }
};

const providerOf = (harness: Doc<"participants">["harness"]) => {
  if (harness === "claude") {
    return "anthropic";
  }
  if (harness === "codex") {
    return "openai";
  }
  return harness;
};

// Fails the turn of one run_turn command whose lease expired. Returns whether
// a turn was failed.
const reclaimLease = async (ctx: MutationCtx, command: Doc<"commands">) => {
  if (command.type !== "run_turn" || command.leaseExpiresAt === undefined) {
    return false;
  }
  const turn = await ctx.db.get(command.turnId);
  if (!turn || !isActiveTurnStatus(turn.status)) {
    await ctx.db.patch(command._id, {
      error: "Lease expired",
      leaseExpiresAt: undefined,
      status: "failed",
    });
    return false;
  }
  await failTurn(
    ctx,
    command.turnId,
    command._id,
    "The runner stopped responding during this turn",
    true,
    undefined,
    { runnerLost: true }
  );
  return true;
};

// Inserts a tool call, or updates it with its result.
const upsertTurnItem = async (
  ctx: MutationCtx,
  turnId: Id<"turns">,
  item: {
    callId: string;
    name: string;
    ok?: boolean;
    seq: number;
    summary: string;
  }
) => {
  const row = { ...item, summary: item.summary.slice(0, SUMMARY_MAX) };
  const existing = await ctx.db
    .query("turnItems")
    .withIndex("by_turn_call", (q) =>
      q.eq("turnId", turnId).eq("callId", item.callId)
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, row);
    return;
  }
  await ctx.db.insert("turnItems", { turnId, ...row });
};

// The id of the message a steer command carried, if it is still a valid id.
const steeredMessageId = (ctx: MutationCtx, payload: unknown) =>
  typeof payload === "object" &&
  payload !== null &&
  "messageId" in payload &&
  typeof payload.messageId === "string"
    ? ctx.db.normalizeId("messages", payload.messageId)
    : null;

export const pendingCommands = query({
  args: { runnerId: v.id("runners"), secret: v.string() },
  handler: async (ctx, { secret, runnerId }) => {
    requireRunnerSecret(secret);
    return await ctx.db
      .query("commands")
      .withIndex("by_runner_status", (q) =>
        q.eq("runnerId", runnerId).eq("status", "pending")
      )
      .collect();
  },
});

// The session a claimed turn resumes. A review or a scribe turn never resumes
// one. A follow-up never continues the ordinary session, even alone with the
// owner: that session could later write review content into the document a
// teammate reads. It runs on a session kept on its review, fixed here so
// finish saves to it.
const claimSession = async (
  ctx: MutationCtx,
  turn: Doc<"turns">,
  participant: Doc<"participants">
): Promise<{ sessionId?: string; documentRevSeen?: number }> => {
  if (turn.followUp && !turn.ritualId) {
    await ctx.db.patch(turn._id, {
      followUp: { ...turn.followUp, separateSession: true },
    });
    const ritual = await ctx.db.get(turn.followUp.ritualId);
    return (
      ritual?.followUpSessions?.find(
        (s) => s.participantId === participant._id
      ) ?? {}
    );
  }
  if (!turn.ritualId && !turn.scribeRunId) {
    return {
      documentRevSeen: participant.documentRevSeen,
      sessionId: participant.harnessSessionId,
    };
  }
  return {};
};

// The prompt a claimed turn runs with: the document as it is now, not as it
// was at dispatch. A resumed session is shown what changed since the rev it
// has seen; any other session is shown the whole document. Reviews are shown
// nothing.
const claimPrompt = async (
  ctx: MutationCtx,
  turn: Doc<"turns">,
  participant: Doc<"participants">,
  room: Doc<"rooms">,
  session: { sessionId?: string; documentRevSeen?: number }
) => {
  const mode = documentMode(turn);
  if (mode === "none") {
    return { mode, prompt: turn.prompt };
  }
  const document = required(
    await ctx.db.get(await ensureDocument(ctx, room._id)),
    "document"
  );
  const seenRev =
    session.sessionId === undefined ? undefined : session.documentRevSeen;
  const prompt = withDigest(
    turn.prompt,
    await documentDigest(ctx, document, {
      mode,
      participantId: participant._id,
      seenRev,
    })
  );
  await ctx.db.patch(turn._id, { documentRev: document.rev });
  return { mode, prompt };
};

// Claim a pending command. For run_turn, returns everything the runner needs
// for the turn. A control command (steer, answer, settings, interrupt) is for
// a turn that is already running: it returns the payload and takes no lease,
// and the runner reports back through commandHandled. Returns null if another
// claim got there first or the command no longer applies.
export const claim = mutation({
  args: { commandId: v.id("commands"), secret: v.string() },
  handler: async (ctx, { secret, commandId }) => {
    requireRunnerSecret(secret);
    const command = await ctx.db.get(commandId);
    if (!command || command.status !== "pending") {
      return null;
    }
    if (command.type !== "run_turn") {
      const target = await ctx.db.get(command.turnId);
      if (!target || target.status !== "running") {
        await ctx.db.patch(commandId, {
          error: "Turn is not running",
          status: "failed",
        });
        return null;
      }
      await ctx.db.patch(commandId, { status: "claimed" });
      return {
        commandId,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- the schema stores payload as v.any(), its shape depends on the command type, and the runner reads it through this return type
        payload: command.payload,
        turn: { id: target._id },
        type: command.type,
      };
    }
    await ctx.db.patch(commandId, {
      leaseExpiresAt: Date.now() + LEASE_MS,
      status: "claimed",
    });

    const turn = await ctx.db.get(command.turnId);
    if (!turn || turn.status !== "queued") {
      await ctx.db.patch(commandId, {
        error: "Turn is no longer queued",
        leaseExpiresAt: undefined,
        status: "failed",
      });
      return null;
    }
    const participant = await ctx.db.get(turn.participantId);
    const room = await ctx.db.get(turn.roomId);
    if (!participant || !room || !participant.harness) {
      return null;
    }

    // The turn runs with the switch as it is now, not as it was at dispatch.
    // A scribe never edits files.
    const editsEnabled = !turn.scribeRunId && room.editsEnabled === true;
    if (turn.editsEnabled !== editsEnabled) {
      await ctx.db.patch(turn._id, { editsEnabled });
    }

    const session = await claimSession(ctx, turn, participant);
    const { sessionId } = session;
    const { mode, prompt } = await claimPrompt(
      ctx,
      turn,
      participant,
      room,
      session
    );

    return {
      commandId,
      documentMode: mode,
      participant: {
        harness: participant.harness,
        id: participant._id,
        model: participant.model,
        reasoning: participant.reasoning,
        sessionId,
      },
      room: {
        cwd: room.cwd,
        editsEnabled,
        handbook: room.handbook,
        id: room._id,
        name: room.name,
      },
      turn: {
        id: turn._id,
        independentReview: !!turn.ritualId,
        prompt,
        ritualId: turn.ritualId,
      },
      type: "run_turn" as const,
    };
  },
});

// Returns the room's edit switch as it is now. A change made between claim
// and start reached no running turn, so the runner applies this value.
export const start = mutation({
  args: {
    harnessVersion: v.string(),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, harnessVersion }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (!turn || !isActiveTurnStatus(turn.status)) {
      return null;
    }
    const room = await ctx.db.get(turn.roomId);
    const editsEnabled = !turn.scribeRunId && room?.editsEnabled === true;
    await ctx.db.patch(turnId, {
      editsEnabled,
      harnessVersion,
      startedAt: Date.now(),
      status: "running",
    });
    await record(ctx, {
      actorParticipantId: turn.participantId,
      harnessVersion,
      roomId: turn.roomId,
      subjectId: turnId,
      type: "turn.started",
    });
    return { editsEnabled };
  },
});

// Throttled by the runner to about two calls a second. Also renews the lease.
export const progress = mutation({
  args: {
    commandId: v.id("commands"),
    partialText: v.string(),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, commandId, partialText }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.status !== "running") {
      return false;
    }
    const command = await ctx.db.get(commandId);
    if (!command || command.turnId !== turnId || command.status !== "claimed") {
      return false;
    }
    await setStreamedText(ctx, turnId, partialText);
    const now = Date.now();
    if ((command.leaseExpiresAt ?? 0) < now + LEASE_MS - LEASE_RENEW_AFTER_MS) {
      await ctx.db.patch(commandId, { leaseExpiresAt: now + LEASE_MS });
    }
    return true;
  },
});

export const finish = mutation({
  args: {
    commandId: v.id("commands"),
    finalText: v.string(),
    model: v.optional(v.string()),
    secret: v.string(),
    sessionId: v.optional(v.string()),
    transcriptRef: v.string(),
    turnId: v.id("turns"),
    usage: v.optional(
      v.object({
        costUsd: v.optional(v.number()),
        inputTokens: v.number(),
        outputTokens: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.secret);
    const turn = await ctx.db.get(args.turnId);
    if (!turn || !isActiveTurnStatus(turn.status)) {
      return;
    }
    const command = await ctx.db.get(args.commandId);
    if (
      !command ||
      command.turnId !== args.turnId ||
      command.status !== "claimed"
    ) {
      throw new Error("Invalid turn command");
    }
    // The streamed text stays on the turn, so the pane can keep showing it.
    await ctx.db.patch(args.turnId, {
      endedAt: Date.now(),
      finalText: args.finalText,
      status: "done",
      transcriptRef: args.transcriptRef,
      usage: args.usage,
    });
    await ctx.db.patch(args.commandId, {
      leaseExpiresAt: undefined,
      status: "done",
    });
    await closeOpenCards(
      ctx,
      args.turnId,
      "cancelled",
      "The turn ended before anyone answered"
    );
    if (
      args.sessionId !== undefined &&
      args.sessionId !== "" &&
      !turn.ritualId &&
      !turn.scribeRunId
    ) {
      await saveSession(ctx, turn, args.sessionId, turn.documentRev);
    }
    // A scribe's draft is applied now, if its run still holds the document.
    if (turn.scribeRunId) {
      await commitScribe(ctx, turn);
    }

    // A turn answering a thread mention replies in the thread, not the chat.
    const participant = await ctx.db.get(turn.participantId);
    const thread = turn.threadId ? await ctx.db.get(turn.threadId) : null;
    const posted =
      thread && participant
        ? {
            commentId: await postComment(
              ctx,
              thread,
              participant,
              args.finalText,
              args.turnId
            ),
          }
        : {
            messageId: await ctx.db.insert("messages", {
              authorParticipantId: turn.participantId,
              body: args.finalText,
              followUpRitualId: turn.followUp?.ritualId,
              ritualId: turn.ritualId,
              roomId: turn.roomId,
              turnId: args.turnId,
              visibility: turn.ritualId ? "sealed" : "room",
            }),
          };
    await reviewFinished(ctx, turn);
    await record(ctx, {
      actorParticipantId: turn.participantId,
      harnessVersion: turn.harnessVersion,
      model: args.model,
      payload: {
        ...posted,
        transcriptRef: args.transcriptRef,
        usage: args.usage,
      },
      provider: providerOf(participant?.harness),
      roomId: turn.roomId,
      subjectId: args.turnId,
      type: "turn.finished",
    });
    if (!turn.ritualId) {
      await dispatchNext(ctx, turn.participantId);
    }
  },
});

export const fail = mutation({
  args: {
    commandId: v.id("commands"),
    error: v.string(),
    interrupted: v.optional(v.boolean()),
    secret: v.string(),
    transcriptRef: v.optional(v.string()),
    turnId: v.id("turns"),
  },
  handler: async (
    ctx,
    { secret, turnId, commandId, error, interrupted, transcriptRef }
  ) => {
    requireRunnerSecret(secret);
    await failTurn(
      ctx,
      turnId,
      commandId,
      error,
      interrupted ?? false,
      transcriptRef
    );
  },
});

// On startup the runner marks its own unfinished work as interrupted.
export const recover = mutation({
  args: { runnerId: v.id("runners"), secret: v.string() },
  handler: async (ctx, { secret, runnerId }) => {
    requireRunnerSecret(secret);
    const claimed = await ctx.db
      .query("commands")
      .withIndex("by_runner_status", (q) =>
        q.eq("runnerId", runnerId).eq("status", "claimed")
      )
      .collect();
    const turns = claimed.filter((c) => c.type === "run_turn");
    for (const command of turns) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each failure records ledger rows and starts the agent's next turn, in command order
      await failTurn(
        ctx,
        command.turnId,
        command._id,
        "Runner restarted during this turn",
        true,
        undefined,
        { runnerLost: true }
      );
    }
    await Promise.all(
      claimed
        .filter((c) => c.type !== "run_turn")
        .map(async (command) => {
          const current = await ctx.db.get(command._id);
          if (current?.status === "claimed") {
            await ctx.db.patch(command._id, {
              error: "Runner restarted",
              status: "failed",
            });
          }
        })
    );
    return turns.length;
  },
});

// Runs every minute. A claimed run_turn whose lease has expired means the
// runner stopped renewing it: fail the turn as interrupted and move the
// agent's queue on. Control commands hold no lease and are never reclaimed.
export const reclaimExpiredLeases = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let reclaimed = 0;
    const expired = await ctx.db
      .query("commands")
      .withIndex("by_status_lease", (q) =>
        q.eq("status", "claimed").lte("leaseExpiresAt", now)
      )
      .collect();
    for (const command of expired) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each failure records ledger rows and starts the agent's next turn, in command order
      if (await reclaimLease(ctx, command)) {
        reclaimed += 1;
      }
    }
    return reclaimed;
  },
});

export const commandHandled = mutation({
  args: {
    commandId: v.id("commands"),
    error: v.optional(v.string()),
    ok: v.boolean(),
    secret: v.string(),
  },
  handler: async (ctx, { secret, commandId, ok, error }) => {
    requireRunnerSecret(secret);
    const command = await ctx.db.get(commandId);
    if (
      !command ||
      command.type === "run_turn" ||
      command.status !== "claimed"
    ) {
      return;
    }
    await ctx.db.patch(
      commandId,
      ok
        ? { status: "done" }
        : {
            error: error ?? "Turn is not running on the runner",
            status: "failed",
          }
    );
    if (!ok && command.type === "steer") {
      const messageId = steeredMessageId(ctx, command.payload);
      const message = messageId === null ? null : await ctx.db.get(messageId);
      if (message) {
        await steerRejected(ctx, message);
      }
    }
  },
});

// The harness either took a steered message into the running turn or
// rejected it. A rejected message returns to the queue.
export const steerResult = mutation({
  args: {
    messageId: v.id("messages"),
    outcome: v.union(v.literal("steered"), v.literal("rejected")),
    secret: v.string(),
  },
  handler: async (ctx, { secret, messageId, outcome }) => {
    requireRunnerSecret(secret);
    const message = await ctx.db.get(messageId);
    if (!message || message.delivery !== "steering" || !message.steering) {
      return;
    }
    if (outcome === "rejected") {
      await steerRejected(ctx, message);
      return;
    }
    const { turnId } = message.steering;
    await ctx.db.patch(messageId, {
      deliveredTurnId: turnId,
      delivery: "steered",
      steering: undefined,
    });
    const turn = await ctx.db.get(turnId);
    if (
      turn &&
      !(turn.requestedByParticipantIds ?? []).includes(
        message.authorParticipantId
      )
    ) {
      await ctx.db.patch(turnId, {
        requestedByParticipantIds: [
          ...(turn.requestedByParticipantIds ?? []),
          message.authorParticipantId,
        ],
      });
    }
    await record(ctx, {
      actorParticipantId: message.authorParticipantId,
      payload: { turnId },
      roomId: message.roomId,
      subjectId: messageId,
      type: "message.steered",
    });
  },
});

// Saves the harness session id as soon as the runner sees it, so a turn
// interrupted before it finishes can still be resumed. Follows the same rules
// as finish: reviews and scribe turns never save a session, and a follow-up
// saves to its review. Only finish records the document rev the session has seen.
export const sessionStarted = mutation({
  args: { secret: v.string(), sessionId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { secret, turnId, sessionId }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (
      !turn ||
      turn.ritualId ||
      turn.scribeRunId ||
      !isActiveTurnStatus(turn.status)
    ) {
      return;
    }
    await saveSession(ctx, turn, sessionId);
  },
});

// The agent asked a question through its harness's question prompt. The card
// shows in the agent pane, and the turn stays running while it waits.
export const raiseHand = mutation({
  args: {
    questions: v.array(cardQuestion),
    requestId: v.string(),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, requestId, questions }) => {
    requireRunnerSecret(secret);
    if (questions.length < 1 || questions.length > 4) {
      throw new Error("A card holds one to four questions");
    }
    if (new Set(questions.map((q) => q.id)).size !== questions.length) {
      throw new Error("Question ids must be unique on a card");
    }
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.status !== "running") {
      throw new Error("Turn is not running");
    }
    const handId = await ctx.db.insert("hands", {
      participantId: turn.participantId,
      questions,
      raisedAt: Date.now(),
      requestId,
      roomId: turn.roomId,
      status: "raised",
      turnId,
    });
    if (!turn.waitingOnHandId) {
      await ctx.db.patch(turnId, { waitingOnHandId: handId });
    }
    await record(ctx, {
      actorParticipantId: turn.participantId,
      payload: { questionCount: questions.length, requestId, turnId },
      roomId: turn.roomId,
      subjectId: handId,
      type: "hand.raised",
    });
    return handId;
  },
});

export const handTimedOut = mutation({
  args: { handId: v.id("hands"), secret: v.string() },
  handler: async (ctx, { secret, handId }) => {
    requireRunnerSecret(secret);
    const hand = await ctx.db.get(handId);
    if (hand) {
      await expireUnanswered(ctx, hand);
    }
  },
});

// The agent's question tool call ended without an answer while its turn
// went on, so the card closes rather than wait on an agent that moved on.
export const handWithdrawn = mutation({
  args: { handId: v.id("hands"), secret: v.string() },
  handler: async (ctx, { secret, handId }) => {
    requireRunnerSecret(secret);
    const hand = await ctx.db.get(handId);
    if (hand) {
      await withdrawCard(ctx, hand);
    }
  },
});

// Tool calls the running turn made, or results for them, since the last call.
// Each item is keyed by the harness's call id, so a result updates its call.
export const recordTurnItems = mutation({
  args: {
    items: v.array(
      v.object({
        callId: v.string(),
        name: v.string(),
        ok: v.optional(v.boolean()),
        seq: v.number(),
        summary: v.string(),
      })
    ),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, items }) => {
    requireRunnerSecret(secret);
    // A turn stopped from the room still keeps the activity of its last moments.
    if (!(await ctx.db.get(turnId))) {
      return;
    }
    for (const item of items) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a call and its result can arrive in one batch, and the result must find the row the call inserted
      await upsertTurnItem(ctx, turnId, item);
    }
  },
});

export const reportCapabilities = mutation({
  args: {
    harnesses: v.array(v.object({ canRaiseCards: v.boolean(), id: harnessId })),
    runnerId: v.id("runners"),
    secret: v.string(),
  },
  handler: async (ctx, { secret, runnerId, harnesses }) => {
    requireRunnerSecret(secret);
    await ctx.db.patch(runnerId, { harnessCapabilities: harnesses });
  },
});

export const prepareReview = mutation({
  args: { ritualId: v.id("rituals"), secret: v.string(), snapshot: v.string() },
  handler: async (ctx, { secret, ritualId, snapshot }) => {
    requireRunnerSecret(secret);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status !== "collecting") {
      throw new Error("Review is no longer collecting");
    }
    const existing = await ctx.db
      .query("reviewSnapshots")
      .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
      .unique();
    if (existing) {
      return existing.text;
    }
    if (ritual.snapshot !== undefined) {
      // Early development rituals.
      return ritual.snapshot;
    }
    if (snapshot.length > 400_000) {
      throw new Error("Review snapshot too large");
    }
    await ctx.db.insert("reviewSnapshots", { ritualId, text: snapshot });
    return snapshot;
  },
});
