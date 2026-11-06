import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
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
            kind: "turn" as const,
            id: t._id,
            at: t._creationTime,
            authorParticipantId: t.participantId,
            status: t.status,
            // An active turn's text comes from agent.live, so streaming does not rerun this.
            partialText: isActiveTurnStatus(t.status)
              ? ""
              : await streamedText(ctx, t),
            error: t.error ?? null,
          }))
      )),
    ];
    return items.sort((a, b) => a.at - b.at);
  },
});

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

    const card =
      decisionId || reviewTurnId ? null : await waitingCard(ctx, target._id);
    if (card && (isOwner || !(await ownerOnlyCard(ctx, card)))) {
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
      return null;
    }

    let parentLedgerId: Id<"ledger"> | undefined;
    let followUpRitualId: Id<"rituals"> | undefined;
    if (decisionId) {
      const decision = await ctx.db.get(decisionId);
      if (!decision || decision.roomId !== roomId) {
        throw new Error("Invalid decision");
      }
      followUpRitualId = decision.ritualId;
      parentLedgerId = (
        await findLedger(ctx, roomId, "decision.recorded", decisionId)
      )?._id;
      if (!parentLedgerId) {
        throw new Error("Decision has no ledger entry");
      }
    }
    if (reviewTurnId) {
      if (decisionId) {
        throw new Error("Choose one follow-up source");
      }
      const source = await ctx.db.get(reviewTurnId);
      const ritual = source?.ritualId
        ? await ctx.db.get(source.ritualId)
        : null;
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
      followUpRitualId = ritual._id;
      parentLedgerId = (
        await findLedger(ctx, roomId, "ritual.revealed", ritual._id)
      )?._id;
    }
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
    if (steer && !followUpRitualId) {
      const active = await activeOrdinaryTurn(ctx, target._id);
      if (takesSteer(active)) {
        await steerMessage(
          ctx,
          (await ctx.db.get(messageId))!,
          active,
          room.runnerId,
          human._id
        );
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
    for (const command of await ctx.db
      .query("commands")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect()) {
      if (command.status === "pending" || command.status === "claimed") {
        await ctx.db.patch(command._id, {
          status: "failed",
          error: reason,
          leaseExpiresAt: undefined,
        });
      }
    }
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
