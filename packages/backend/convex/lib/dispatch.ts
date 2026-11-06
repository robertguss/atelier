import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findLedger, record } from "./ledger";
import {
  contextBlock,
  loadRoomContext,
  renderMessage,
  roomMembers,
  turnPrompt,
} from "./prompt";

// Each agent has at most one active ordinary turn. Messages sent while it
// works wait as `queued` and go in together, in send order, as the next turn.
// Independent review turns stay outside this queue.

const HEARTBEAT_MS = 15_000;
export const OFFLINE_AFTER_MS = 3 * HEARTBEAT_MS;

export const runnerOnline = (runner: Doc<"runners"> | null) =>
  !!runner && Date.now() - runner.lastHeartbeatAt <= OFFLINE_AFTER_MS;

export const offlineReason = (runner: Doc<"runners"> | null) =>
  `The runner${runner ? ` "${runner.name}"` : ""} is offline: no heartbeat in the last 45 seconds, so agents cannot receive messages.`;

export const requireRunnerOnline = async (
  ctx: QueryCtx,
  room: Doc<"rooms"> | null
): Promise<Doc<"rooms">> => {
  const runner = room ? await ctx.db.get(room.runnerId) : null;
  if (!room || !runnerOnline(runner)) {
    throw new Error(offlineReason(runner));
  }
  return room;
};

export const isActiveTurnStatus = (status: Doc<"turns">["status"]) =>
  status === "queued" || status === "running";

export const activeOrdinaryTurn = async (
  ctx: QueryCtx,
  participantId: Id<"participants">
) => {
  const oldest = async (status: "queued" | "running") =>
    await ctx.db
      .query("turns")
      .withIndex("by_participant_status", (q) =>
        q.eq("participantId", participantId).eq("status", status)
      )
      .filter((q) => q.eq(q.field("ritualId"), undefined))
      .first();
  const queued = await oldest("queued");
  const running = await oldest("running");
  if (queued && running) {
    return queued._creationTime < running._creationTime ? queued : running;
  }
  return queued ?? running;
};

// A steer still in flight waits for the runner's verdict. Once its turn has
// ended and the runner is no longer holding it, the message counts as queued.
const steerIsStale = async (ctx: QueryCtx, message: Doc<"messages">) => {
  if (!message.steering) {
    return true;
  }
  const turn = await ctx.db.get(message.steering.turnId);
  if (turn && isActiveTurnStatus(turn.status)) {
    return false;
  }
  const command = await ctx.db.get(message.steering.commandId);
  return (
    !command || command.status === "pending" || command.status === "failed"
  );
};

const waitingMessages = async (
  ctx: QueryCtx,
  participantId: Id<"participants">
) => {
  const byState = async (delivery: "queued" | "steering") =>
    await ctx.db
      .query("messages")
      .withIndex("by_to_delivery", (q) =>
        q.eq("toParticipantId", participantId).eq("delivery", delivery)
      )
      .collect();
  const queued = await byState("queued");
  const steering = await byState("steering");
  const isStale = await Promise.all(
    steering.map(async (m) => await steerIsStale(ctx, m))
  );
  const stale = steering.filter((_, i) => isStale[i] === true);
  return [...queued, ...stale].toSorted(
    (a, b) => a._creationTime - b._creationTime
  );
};

export const cancelMessage = async (
  ctx: MutationCtx,
  message: Doc<"messages">,
  reason: string,
  actorParticipantId?: Id<"participants">
) => {
  await ctx.db.patch(message._id, {
    cancelReason: reason,
    delivery: "cancelled",
    steering: undefined,
  });
  await record(ctx, {
    actorParticipantId,
    payload: { reason },
    roomId: message.roomId,
    subjectId: message._id,
    type: "message.cancelled",
  });
};

const takeWhile = <T>(items: T[], keep: (item: T) => boolean) => {
  const out = [];
  for (const item of items) {
    if (!keep(item)) {
      break;
    }
    out.push(item);
  }
  return out;
};

// Start the agent's next turn from everything waiting for it, if it is idle.
// A follow-up to a review or decision always runs alone. With the runner
// offline, the waiting messages are cancelled instead. Returns the new turn.
export const dispatchNext = async (
  ctx: MutationCtx,
  participantId: Id<"participants">
): Promise<Id<"turns"> | null> => {
  const participant = await ctx.db.get(participantId);
  if (!participant || participant.kind !== "harness") {
    return null;
  }
  if (await activeOrdinaryTurn(ctx, participantId)) {
    return null;
  }
  const waiting = await waitingMessages(ctx, participantId);
  const [first] = waiting;
  if (first === undefined) {
    return null;
  }

  const room = await ctx.db.get(participant.roomId);
  const runner = room ? await ctx.db.get(room.runnerId) : null;
  if (!room || !runnerOnline(runner)) {
    for (const m of waiting) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- cancellations are recorded in the ledger in send order
      await cancelMessage(ctx, m, "runner offline");
    }
    return null;
  }

  const batch = first.followUpRitualId
    ? [first]
    : takeWhile(waiting, (m) => !m.followUpRitualId);
  const members = await roomMembers(ctx, room._id);
  const messages = await Promise.all(
    batch.map(async (m) => await renderMessage(ctx, m, "queued", members))
  );
  const previous = await ctx.db
    .query("turns")
    .withIndex("by_participant", (q) => q.eq("participantId", participantId))
    .order("desc")
    .filter((q) => q.eq(q.field("ritualId"), undefined))
    .first();
  const stopper =
    previous?.status === "interrupted" && previous.stoppedByParticipantId
      ? await ctx.db.get(previous.stoppedByParticipantId)
      : null;
  const prompt = turnPrompt({
    context: contextBlock(await loadRoomContext(ctx, room, members)),
    messages,
    stoppedBy: stopper?.displayName,
  });

  const turnId = await ctx.db.insert("turns", {
    editsEnabled: room.editsEnabled === true,
    followUp: first.followUpRitualId
      ? {
          decisionId: first.followUpDecisionId,
          ritualId: first.followUpRitualId,
        }
      : undefined,
    participantId,
    prompt,
    requestedByParticipantIds: [
      ...new Set(batch.map((m) => m.authorParticipantId)),
    ],
    roomId: room._id,
    status: "queued",
  });
  await ctx.db.insert("commands", {
    runnerId: room.runnerId,
    status: "pending",
    turnId,
    type: "run_turn",
  });
  const postedLedgerIds = await Promise.all(
    batch.map(async (m) => {
      await ctx.db.patch(m._id, {
        deliveredTurnId: turnId,
        delivery: "delivered",
        steering: undefined,
      });
      const posted = await findLedger(ctx, m.roomId, "message.posted", m._id);
      return posted?._id;
    })
  );
  const messageLedgerIds = postedLedgerIds.filter((id) => id !== undefined);
  await record(ctx, {
    actorParticipantId: participantId,
    model: participant.model,
    parentLedgerId: messageLedgerIds[0],
    payload: { messageLedgerIds },
    roomId: room._id,
    subjectId: turnId,
    type: "turn.queued",
  });
  return turnId;
};

// Only a running ordinary turn takes a steer. A follow-up to a review or
// decision always runs as its own turn, so it neither takes nor gives one.
export const takesSteer = (turn: Doc<"turns"> | null): turn is Doc<"turns"> =>
  turn?.status === "running" && !turn.followUp;

// "Steer now": hand a waiting message to the runner for the agent's running
// turn. The runner reports the harness's verdict through steerResult.
export const steerMessage = async (
  ctx: MutationCtx,
  message: Doc<"messages">,
  turn: Doc<"turns">,
  runnerId: Id<"runners">,
  actorParticipantId: Id<"participants">
) => {
  const commandId = await ctx.db.insert("commands", {
    payload: {
      messageId: message._id,
      text: await renderMessage(ctx, message, "steered"),
    },
    runnerId,
    status: "pending",
    turnId: turn._id,
    type: "steer",
  });
  await ctx.db.patch(message._id, {
    delivery: "steering",
    steering: { commandId, turnId: turn._id },
  });
  await record(ctx, {
    actorParticipantId,
    payload: { turnId: turn._id },
    roomId: message.roomId,
    subjectId: message._id,
    type: "message.steer_requested",
  });
};

// The runner could not put a steered message into the running turn. It goes
// back to the queue, and starts a turn now if the agent is already idle.
export const steerRejected = async (
  ctx: MutationCtx,
  message: Doc<"messages">
) => {
  if (message.delivery !== "steering" || !message.toParticipantId) {
    return;
  }
  await ctx.db.patch(message._id, { delivery: "queued", steering: undefined });
  await record(ctx, {
    roomId: message.roomId,
    subjectId: message._id,
    type: "message.steer_rejected",
  });
  await dispatchNext(ctx, message.toParticipantId);
};
