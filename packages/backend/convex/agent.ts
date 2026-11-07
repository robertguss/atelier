import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  activeOrdinaryTurn,
  dispatchNext,
  isActiveTurnStatus,
  OFFLINE_AFTER_MS,
  requireRunnerOnline,
  steerMessage,
  takesSteer,
} from "./lib/dispatch";
import { activeRoomTurns, streamedText, toolItems } from "./lib/turnActivity";
import { visibleMessage, visibleTurn } from "./lib/visibility";

// "Steer now": put a queued message into the agent's running turn instead of
// waiting for it to end. With no turn running, the message is dispatched as
// usual.
export const steer = mutation({
  args: { messageId: v.id("messages") },
  handler: async (
    ctx,
    { messageId }
  ): Promise<{
    status: "steering" | "delivered" | "queued";
    turnId?: Id<"turns">;
  }> => {
    const message = await ctx.db.get(messageId);
    if (!message) {
      throw new Error("Unknown message");
    }
    const { participant } = await requireMember(ctx, message.roomId);
    if (message.delivery !== "queued" || !message.toParticipantId) {
      throw new Error("This message is no longer waiting");
    }
    if (message.followUpRitualId) {
      throw new Error("A follow-up runs as its own turn");
    }
    if (message.threadId) {
      throw new Error("A mention in a thread runs as its own turn");
    }
    const room = await requireRunnerOnline(
      ctx,
      await ctx.db.get(message.roomId)
    );

    const active = await activeOrdinaryTurn(ctx, message.toParticipantId);
    if (takesSteer(active)) {
      await steerMessage(ctx, message, active, room.runnerId, participant._id);
      return { status: "steering", turnId: active._id };
    }
    const turnId = await dispatchNext(ctx, message.toParticipantId);
    return turnId ? { status: "delivered", turnId } : { status: "queued" };
  },
});

const RECENT_CARDS = 20;
// Turns in one page of agent-pane history. A turn usually brings a message in
// and a reply out, so the message window is wider.
export const PANE_PAGE = 40;
const MAX_TURNS = 400;
const MESSAGES_PER_TURN = 4;

// Deduplicated by id, oldest first.
const oldestFirst = <T extends { _id: string; _creationTime: number }>(
  docs: T[]
): T[] =>
  [...new Map(docs.map((d) => [d._id, d])).values()].toSorted(
    (a, b) => a._creationTime - b._creationTime
  );

const agentStatus = (active: Doc<"turns"> | null) => {
  if (!active) {
    return "idle";
  }
  if (active.status === "queued") {
    return "starting";
  }
  return active.waitingOnHandId ? "waiting" : "running";
};

// The agent pane's history: the latest `limit` turns (PANE_PAGE by default)
// with what was said around them, plus every active turn and waiting message
// however old. Active turns come without text or tool calls, which `live`
// carries, so the runner's streaming writes never rerun this query.
// Members never see reviews, follow-ups to them, or any turn's prompt.
export const pane = query({
  args: { limit: v.optional(v.number()), roomId: v.id("rooms") },
  handler: async (ctx, { roomId, limit }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const room = await ctx.db.get(roomId);
    if (room === null) {
      throw new Error("Unknown room");
    }
    const runner = await ctx.db.get(room.runnerId);
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const harnesses = participants.filter((p) => p.kind === "harness");

    const turnLimit = Math.min(
      Math.max(Math.floor(limit ?? PANE_PAGE), 1),
      MAX_TURNS
    );
    const messageLimit = turnLimit * MESSAGES_PER_TURN;
    const recentTurns = await ctx.db
      .query("turns")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .take(turnLimit + 1);
    const recentMessages = await ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .take(messageLimit + 1);
    const moreTurns = recentTurns.length > turnLimit;
    const moreMessages = recentMessages.length > messageLimit;
    // Start both lists where the shorter-reaching one starts, so the timeline has no gaps.
    const oldestTurn = moreTurns ? recentTurns[turnLimit - 1] : undefined;
    const oldestMessage = moreMessages
      ? recentMessages[messageLimit - 1]
      : undefined;
    const since = Math.max(
      oldestTurn?._creationTime ?? 0,
      oldestMessage?._creationTime ?? 0
    );
    const waitingLists = await Promise.all(
      harnesses.flatMap((p) =>
        (["queued", "steering"] as const).map(
          async (delivery) =>
            await ctx.db
              .query("messages")
              .withIndex("by_to_delivery", (q) =>
                q.eq("toParticipantId", p._id).eq("delivery", delivery)
              )
              .collect()
        )
      )
    );
    const waiting = waitingLists.flat();
    const messages = oldestFirst([
      ...recentMessages.filter((m) => m._creationTime >= since),
      ...waiting,
    ]).filter((m) =>
      visibleMessage(m, isOwner, { ownerSeesReviewAnswers: false })
    );
    const turns = oldestFirst([
      ...recentTurns.filter((t) => t._creationTime >= since),
      ...(await activeRoomTurns(ctx, roomId)),
    ]).filter((t) => visibleTurn(t, isOwner));

    const activeTurns = await Promise.all(
      harnesses.map(async (p) => await activeOrdinaryTurn(ctx, p._id))
    );
    const agents = harnesses.map((p, i) => {
      const active = activeTurns[i] ?? null;
      const status = agentStatus(active);
      return {
        activeTurnId:
          active && visibleTurn(active, isOwner) ? active._id : null,
        // Null until the runner reports it. An agent that cannot raise cards asks in plain text.
        canRaiseCards:
          runner?.harnessCapabilities?.find((c) => c.id === p.harness)
            ?.canRaiseCards ?? null,
        displayName: p.displayName,
        harness: p.harness ?? null,
        participantId: p._id,
        queued: messages.filter(
          (m) =>
            m.toParticipantId === p._id &&
            (m.delivery === "queued" || m.delivery === "steering")
        ).length,
        status,
      };
    });

    // Open cards, then the most recent closed ones, only on turns the caller can see.
    const visibleTurnIds = new Set(turns.map((t) => t._id));
    const roomHands = await ctx.db
      .query("hands")
      .withIndex("by_room_status", (q) => q.eq("roomId", roomId))
      .collect();
    const hands = roomHands
      .filter((h) => visibleTurnIds.has(h.turnId))
      .toSorted((a, b) => a.raisedAt - b.raisedAt);
    const cards = [
      ...hands.filter((h) => h.status === "raised"),
      ...hands.filter((h) => h.status !== "raised").slice(-RECENT_CARDS),
    ];

    return {
      agents,
      cards: cards.map((h) => ({
        answeredAt: h.answeredAt ?? null,
        answeredByParticipantId: h.answeredByParticipantId ?? null,
        answers: h.answers ?? null,
        closeReason: h.closeReason ?? null,
        closedAt: h.closedAt ?? null,
        id: h._id,
        participantId: h.participantId,
        questions: h.questions,
        raisedAt: h.raisedAt,
        status: h.status,
        turnId: h.turnId,
        via: h.via ?? null,
      })),
      editsEnabled: room.editsEnabled === true,
      hasOlder: moreTurns || moreMessages,
      messages: messages.map((m) => ({
        at: m._creationTime,
        authorParticipantId: m.authorParticipantId,
        body: m.body,
        cancelReason: m.cancelReason ?? null,
        deliveredTurnId: m.deliveredTurnId ?? null,
        delivery: m.delivery ?? null,
        id: m._id,
        toParticipantId: m.toParticipantId ?? null,
        // Set on an agent's reply.
        turnId: m.turnId ?? null,
      })),
      runner: {
        lastHeartbeatAt: runner?.lastHeartbeatAt ?? 0,
        offlineAfterMs: OFFLINE_AFTER_MS,
      },
      turns: await Promise.all(
        turns.map(async (t) => {
          const ended = !isActiveTurnStatus(t.status);
          return {
            at: t._creationTime,
            endedAt: t.endedAt ?? null,
            error: t.error ?? null,
            id: t._id,
            items: ended ? await toolItems(ctx, t._id) : [],
            partialText: ended ? await streamedText(ctx, t) : "",
            participantId: t.participantId,
            requestedByParticipantIds: t.requestedByParticipantIds ?? [],
            startedAt: t.startedAt ?? null,
            status: t.status,
            stoppedByParticipantId: t.stoppedByParticipantId ?? null,
            // Set on a turn answering a thread mention; its reply is in that thread.
            threadId: t.threadId ?? null,
            waitingOnHandId: t.waitingOnHandId ?? null,
          };
        })
      ),
    };
  },
});

// Streamed text and tool calls of the room's active turns. Small, so it can
// rerun on every runner write.
export const live = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const active = await activeRoomTurns(ctx, roomId);
    const turns = active.filter((t) => visibleTurn(t, isOwner));
    return await Promise.all(
      turns.map(async (t) => ({
        id: t._id,
        items: await toolItems(ctx, t._id),
        partialText: await streamedText(ctx, t),
      }))
    );
  },
});
