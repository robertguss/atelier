import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { cardAnswer } from "../schema";
import { activeOrdinaryTurn } from "./dispatch";
import { findLedger, record } from "./ledger";
import { agentName } from "./prompt";

// Question cards. A card is answered whole, once: the first answer wins,
// whether it comes from the card or from a chat message to the waiting agent.
// On the card each question records its own decision; a chat message, given
// to the agent as the answer to every question, records one decision for the
// whole card. Decisions link by id to the team messages posted while the card
// was open. The text of those messages is never copied.

export type CardAnswer = Infer<typeof cardAnswer>;

export const NO_DECISION_MESSAGE =
  "No one answered this question within 2 hours, so no decision was made. Continue without an answer or ask again in plain text.";

// Cards raised by a review turn or a follow-up to one are the owner's alone.
export const ownerOnlyCard = async (ctx: QueryCtx, hand: Doc<"hands">) => {
  const turn = await ctx.db.get(hand.turnId);
  return !turn || !!turn.ritualId || !!turn.followUp;
};

export const closedCardError = async (ctx: QueryCtx, hand: Doc<"hands">) => {
  if (hand.status === "answered") {
    const by = hand.answeredByParticipantId
      ? await ctx.db.get(hand.answeredByParticipantId)
      : null;
    return new Error(
      `Already answered by ${by?.displayName ?? "someone else"}`
    );
  }
  return new Error("This question closed without an answer");
};

export const waitingCard = async (
  ctx: QueryCtx,
  participantId: Id<"participants">
) => {
  const turn = await activeOrdinaryTurn(ctx, participantId);
  if (!turn || turn.status !== "running" || !turn.waitingOnHandId) {
    return null;
  }
  const hand = await ctx.db.get(turn.waitingOnHandId);
  return hand?.status === "raised" ? hand : null;
};

const raisedLedgerId = async (ctx: QueryCtx, hand: Doc<"hands">) => {
  const raised = await findLedger(ctx, hand.roomId, "hand.raised", hand._id);
  return raised?._id;
};

const choiceText = (answer: CardAnswer) => {
  const parts = [...answer.labels];
  const free = answer.freeText?.trim();
  if (free !== undefined && free !== "") {
    parts.push(free);
  }
  return parts.join("; ");
};

// The turn now waits on its next open card, if it raised another, or on none.
const releaseTurn = async (ctx: MutationCtx, hand: Doc<"hands">) => {
  const turn = await ctx.db.get(hand.turnId);
  if (!turn || turn.waitingOnHandId !== hand._id) {
    return;
  }
  const hands = await ctx.db
    .query("hands")
    .withIndex("by_turn", (q) => q.eq("turnId", hand.turnId))
    .collect();
  const next = hands.find((h) => h._id !== hand._id && h.status === "raised");
  await ctx.db.patch(turn._id, { waitingOnHandId: next?._id });
};

const close = async (
  ctx: MutationCtx,
  hand: Doc<"hands">,
  status: "cancelled" | "expired",
  reason: string
) => {
  await ctx.db.patch(hand._id, {
    closeReason: reason,
    closedAt: Date.now(),
    status,
  });
  await record(ctx, {
    actorParticipantId: hand.participantId,
    parentLedgerId: await raisedLedgerId(ctx, hand),
    payload: { reason },
    roomId: hand.roomId,
    subjectId: hand._id,
    type: `hand.${status}`,
  });
  await releaseTurn(ctx, hand);
};

// One decision row and its ledger entry.
const recordDecision = async (
  ctx: MutationCtx,
  hand: Doc<"hands">,
  answerer: Doc<"participants">,
  answeredLedgerId: Id<"ledger">,
  teamMessageIds: Id<"teamMessages">[],
  { choice, questionId }: { choice: string; questionId: string | undefined }
) => {
  const decisionId = await ctx.db.insert("decisions", {
    answeredByParticipantId: answerer._id,
    choice,
    handId: hand._id,
    questionId,
    roomId: hand.roomId,
  });
  await record(ctx, {
    actorParticipantId: answerer._id,
    parentLedgerId: answeredLedgerId,
    payload: { handId: hand._id, questionId, teamMessageIds },
    roomId: hand.roomId,
    subjectId: decisionId,
    type: "decision.recorded",
  });
};

export const answerCard = async (
  ctx: MutationCtx,
  hand: Doc<"hands">,
  answerer: Doc<"participants">,
  answers: CardAnswer[],
  via: "card" | "chat",
  messageId?: Id<"messages">
) => {
  if (hand.status !== "raised") {
    throw await closedCardError(ctx, hand);
  }
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const complete =
    answers.length === hand.questions.length &&
    hand.questions.every((q) => {
      const a = byQuestion.get(q.id);
      return !!a && (a.labels.length > 0 || (a.freeText?.trim() ?? "") !== "");
    });
  if (!complete) {
    throw new Error("Answer every question on the card");
  }
  const room = await ctx.db.get(hand.roomId);
  if (!room) {
    throw new Error("Unknown room");
  }

  const now = Date.now();
  const teamMessages = await ctx.db
    .query("teamMessages")
    .withIndex("by_room", (q) =>
      q.eq("roomId", hand.roomId).gt("_creationTime", hand._creationTime)
    )
    .collect();
  const teamMessageIds = teamMessages.map((m) => m._id);

  // Every question has an answer: `complete` checked it above.
  const ordered = hand.questions.map((q) => {
    const answer = byQuestion.get(q.id);
    if (answer === undefined) {
      throw new Error("Answer every question on the card");
    }
    return answer;
  });
  await ctx.db.patch(hand._id, {
    answeredAt: now,
    answeredByParticipantId: answerer._id,
    answers: ordered,
    status: "answered",
    via,
  });
  const answeredLedgerId = await record(ctx, {
    actorParticipantId: answerer._id,
    parentLedgerId: await raisedLedgerId(ctx, hand),
    payload: { messageId, via },
    roomId: hand.roomId,
    subjectId: hand._id,
    type: "hand.answered",
  });
  // A chat answer has no question id: the decision covers the whole card.
  const [firstAnswer] = ordered;
  let decided: { choice: string; questionId: string | undefined }[];
  if (via === "card") {
    decided = ordered.map((a) => ({
      choice: choiceText(a),
      questionId: a.questionId,
    }));
  } else if (firstAnswer === undefined) {
    throw new Error("The card has no questions to answer");
  } else {
    decided = [{ choice: choiceText(firstAnswer), questionId: undefined }];
  }
  for (const decision of decided) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- decision and ledger rows are written in question order, which the ledger and decision lists show
    await recordDecision(
      ctx,
      hand,
      answerer,
      answeredLedgerId,
      teamMessageIds,
      decision
    );
  }

  await ctx.db.insert("commands", {
    payload: {
      answeredBy: agentName(answerer.displayName),
      answers: ordered.map((a) => {
        const question = hand.questions.find((q) => q.id === a.questionId);
        if (question === undefined) {
          throw new Error("Answer for a question not on the card");
        }
        return { ...a, question: question.text };
      }),
      handId: hand._id,
      requestId: hand.requestId,
      via,
    },
    runnerId: room.runnerId,
    status: "pending",
    turnId: hand.turnId,
    type: "answer",
  });
  await releaseTurn(ctx, hand);
};

// The card's ceiling passed: it closes with no decision, and the agent is told
// so through the same answer channel, so its turn can go on.
export const expireUnanswered = async (
  ctx: MutationCtx,
  hand: Doc<"hands">
) => {
  if (hand.status !== "raised") {
    return;
  }
  const room = await ctx.db.get(hand.roomId);
  await close(ctx, hand, "expired", "No answer within 2 hours");
  if (room) {
    await ctx.db.insert("commands", {
      payload: {
        handId: hand._id,
        message: NO_DECISION_MESSAGE,
        noDecision: true,
        requestId: hand.requestId,
      },
      runnerId: room.runnerId,
      status: "pending",
      turnId: hand.turnId,
      type: "answer",
    });
  }
};

// The turn ended under an open card: the card closes with no decision.
// Stopped turns cancel it; a lost runner or a turn that ended otherwise
// expires it.
export const closeOpenCards = async (
  ctx: MutationCtx,
  turnId: Id<"turns">,
  status: "cancelled" | "expired",
  reason: string
) => {
  const hands = await ctx.db
    .query("hands")
    .withIndex("by_turn", (q) => q.eq("turnId", turnId))
    .collect();
  for (const hand of hands) {
    if (hand.status === "raised") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each close moves the turn's wait to the next open card, which the following close reads
      await close(ctx, hand, status, reason);
    }
  }
};
