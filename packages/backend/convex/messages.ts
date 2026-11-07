import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  answerCard,
  closeOpenCards,
  ownerOnlyCard,
  waitingCard,
} from "./lib/cards";
import {
  activeOrdinaryTurn,
  dispatchNext,
  isActiveTurnStatus,
  requireRunnerOnline,
  steerMessage,
  takesSteer,
} from "./lib/dispatch";
import { findLedger, record } from "./lib/ledger";
import { reviewFinished } from "./lib/review";
import { streamedText } from "./lib/turnActivity";
import { visibleMessage, visibleTurn } from "./lib/visibility";

// The room timeline: visible messages plus every turn that hasn't produced a
// message yet (queued, running, failed, interrupted), so the phone can show
// live progress and errors in place; an active turn's text comes from
// agent.live. Members never see independent reviews, review answers, or
// follow-ups to a review or its decision.
export const timeline = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const { isOwner } = await requireMember(ctx, roomId);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();

    const items = [
      ...messages
        .filter((m) =>
          visibleMessage(m, isOwner, { ownerSeesReviewAnswers: true })
        )
        .map((m) => ({
          at: m._creationTime,
          authorParticipantId: m.authorParticipantId,
          body: m.body,
          id: m._id,
          kind: "message" as const,
        })),
      ...(await Promise.all(
        turns
          .filter((t) => visibleTurn(t, isOwner) && t.status !== "done")
          .map(async (t) => ({
            at: t._creationTime,
            authorParticipantId: t.participantId,
            error: t.error ?? null,
            id: t._id,
            kind: "turn" as const,
            // An active turn's text comes from agent.live, so streaming does not rerun this.
            partialText: isActiveTurnStatus(t.status)
              ? ""
              : await streamedText(ctx, t),
            status: t.status,
          }))
      )),
    ];
    return items.toSorted((a, b) => a.at - b.at);
  },
});

// A message to an agent waiting on its own question card answers that card
// instead, unless the card is owner-only and the author is not the owner.
// Returns whether it answered a card.
const answerWaitingCard = async (
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  human: Doc<"participants">,
  isOwner: boolean,
  target: Doc<"participants">,
  text: string
) => {
  const card = await waitingCard(ctx, target._id);
  if (!card || (!isOwner && (await ownerOnlyCard(ctx, card)))) {
    return false;
  }
  // An answer to a follow-up's card is as owner-only as the follow-up.
  const cardTurn = await ctx.db.get(card.turnId);
  const messageId = await ctx.db.insert("messages", {
    authorParticipantId: human._id,
    body: text,
    deliveredTurnId: card.turnId,
    delivery: "answeredCard",
    followUpRitualId: cardTurn?.followUp?.ritualId,
    roomId,
    toParticipantId: target._id,
    visibility: "room",
  });
  await record(ctx, {
    actorParticipantId: human._id,
    payload: { handId: card._id, to: target._id },
    roomId,
    subjectId: messageId,
    type: "message.posted",
  });
  const answers = card.questions.map((q) => ({
    freeText: text,
    labels: [],
    questionId: q.id,
  }));
  await answerCard(ctx, card, human, answers, "chat", messageId);
  return true;
};

interface FollowUpSource {
  followUpRitualId?: Id<"rituals">;
  parentLedgerId?: Id<"ledger">;
}

// A follow-up to a decision links to the decision's ledger entry.
const decisionSource = async (
  ctx: QueryCtx,
  roomId: Id<"rooms">,
  decisionId: Id<"decisions">
): Promise<FollowUpSource> => {
  const decision = await ctx.db.get(decisionId);
  if (!decision || decision.roomId !== roomId) {
    throw new Error("Invalid decision");
  }
  const recorded = await findLedger(
    ctx,
    roomId,
    "decision.recorded",
    decisionId
  );
  if (!recorded) {
    throw new Error("Decision has no ledger entry");
  }
  return { followUpRitualId: decision.ritualId, parentLedgerId: recorded._id };
};

// A follow-up to a review answer goes to the participant who wrote it, once
// the review has been revealed.
const reviewSource = async (
  ctx: QueryCtx,
  roomId: Id<"rooms">,
  target: Doc<"participants">,
  reviewTurnId: Id<"turns">
): Promise<FollowUpSource> => {
  const source = await ctx.db.get(reviewTurnId);
  const ritual = source?.ritualId ? await ctx.db.get(source.ritualId) : null;
  if (
    !source ||
    source.roomId !== roomId ||
    !ritual ||
    ritual.status === "collecting"
  ) {
    throw new Error("Review is not available for follow-up");
  }
  if (source.participantId !== target._id) {
    throw new Error("Choose the participant who wrote this answer");
  }
  const revealed = await findLedger(ctx, roomId, "ritual.revealed", ritual._id);
  return { followUpRitualId: ritual._id, parentLedgerId: revealed?._id };
};

// Post a message to one agent (Claude by default). An idle agent starts a
// turn at once; a busy one gets it, with anything else waiting, when its
// current turn ends. Returns the new turn, or null when no turn started.
// Following up a review or decision is the owner's alone. A message to an
// agent waiting on its own question card answers that card instead. With
// `steer`, a message to an agent mid-turn goes into that turn at once, as
// agent.steer does; a follow-up never steers.
export const send = mutation({
  args: {
    body: v.string(),
    decisionId: v.optional(v.id("decisions")),
    reviewTurnId: v.optional(v.id("turns")),
    roomId: v.id("rooms"),
    steer: v.optional(v.boolean()),
    toParticipantId: v.optional(v.id("participants")),
  },
  handler: async (
    ctx,
    { roomId, body, toParticipantId, decisionId, reviewTurnId, steer }
  ): Promise<Id<"turns"> | null> => {
    const { participant: human, isOwner } = await requireMember(ctx, roomId);
    if ((decisionId || reviewTurnId) && !isOwner) {
      throw new Error("Only the owner can follow up a review");
    }
    const text = body.trim();
    if (!text) {
      throw new Error("Empty message");
    }
    const room = await ctx.db.get(roomId);
    if (!room) {
      throw new Error("Unknown room");
    }
    await requireRunnerOnline(ctx, room);

    const participants = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const target = toParticipantId
      ? participants.find((p) => p._id === toParticipantId)
      : participants.find((p) => p.harness === "claude");
    if (!target || target.kind !== "harness") {
      throw new Error("Room has no one to reply");
    }

    const followingUp = decisionId !== undefined || reviewTurnId !== undefined;
    if (
      !followingUp &&
      (await answerWaitingCard(ctx, roomId, human, isOwner, target, text))
    ) {
      return null;
    }

    let source: FollowUpSource = {};
    if (decisionId) {
      source = await decisionSource(ctx, roomId, decisionId);
    }
    if (reviewTurnId) {
      if (decisionId) {
        throw new Error("Choose one follow-up source");
      }
      source = await reviewSource(ctx, roomId, target, reviewTurnId);
    }
    const { followUpRitualId, parentLedgerId } = source;
    const messageId = await ctx.db.insert("messages", {
      authorParticipantId: human._id,
      body: text,
      delivery: "queued",
      followUpDecisionId: decisionId,
      followUpReviewTurnId: reviewTurnId,
      followUpRitualId,
      roomId,
      toParticipantId: target._id,
      visibility: "room",
    });
    await record(ctx, {
      actorParticipantId: human._id,
      parentLedgerId,
      payload: { to: target._id },
      roomId,
      subjectId: messageId,
      type: "message.posted",
    });
    if (steer === true && !followUpRitualId) {
      const active = await activeOrdinaryTurn(ctx, target._id);
      if (takesSteer(active)) {
        const message = await ctx.db.get(messageId);
        if (message === null) {
          throw new Error("The new message is missing");
        }
        await steerMessage(ctx, message, active, room.runnerId, human._id);
        return null;
      }
    }
    return await dispatchNext(ctx, target._id);
  },
});

// Any member can stop an ordinary turn; review turns are the owner's.
export const cancel = mutation({
  args: { turnId: v.id("turns") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) {
      throw new Error("Unknown turn");
    }
    const { participant, isOwner } = await requireMember(ctx, turn.roomId);
    if (turn.ritualId && !isOwner) {
      throw new Error("Only the owner can stop a review");
    }
    if (!isActiveTurnStatus(turn.status)) {
      return;
    }
    const reason = isOwner
      ? "Cancelled by owner"
      : `Cancelled by ${participant.displayName}`;
    await ctx.db.patch(turnId, {
      endedAt: Date.now(),
      error: isOwner ? "Cancelled by you" : reason,
      status: turn.ritualId ? "failed" : "interrupted",
      stoppedByParticipantId: participant._id,
    });
    await closeOpenCards(ctx, turnId, "cancelled", reason);
    await reviewFinished(ctx, turn);
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect();
    await Promise.all(
      commands
        .filter((c) => c.status === "pending" || c.status === "claimed")
        .map(async (c) => {
          await ctx.db.patch(c._id, {
            error: reason,
            leaseExpiresAt: undefined,
            status: "failed",
          });
        })
    );
    await record(ctx, {
      actorParticipantId: participant._id,
      payload: { error: reason },
      roomId: turn.roomId,
      subjectId: turnId,
      type: "turn.interrupted",
    });
    if (!turn.ritualId) {
      await dispatchNext(ctx, turn.participantId);
    }
  },
});
