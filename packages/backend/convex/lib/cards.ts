import type { Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { cardAnswer } from '../schema';
import { activeOrdinaryTurn } from './dispatch';
import { findLedger, record } from './ledger';
import { agentName } from './prompt';

// Question cards. A card is answered whole, once: the first answer wins,
// whether it comes from the card or from a chat message to the waiting agent.
// Each question records its own decision, linked by id to the team messages
// posted while the card was open. The text of those messages is never copied.

export type CardAnswer = Infer<typeof cardAnswer>;

export const NO_DECISION_MESSAGE = 'No one answered this question within 2 hours, so no decision was made. Continue without an answer or ask again in plain text.';

// Cards raised by a review turn or a follow-up to one are the owner's alone.
export async function ownerOnlyCard(ctx: QueryCtx, hand: Doc<'hands'>) {
  const turn = await ctx.db.get(hand.turnId);
  return !turn || !!turn.ritualId || !!turn.followUp;
}

export async function closedCardError(ctx: QueryCtx, hand: Doc<'hands'>) {
  if (hand.status === 'answered') {
    const by = hand.answeredByParticipantId ? await ctx.db.get(hand.answeredByParticipantId) : null;
    return new Error(`Already answered by ${by?.displayName ?? 'someone else'}`);
  }
  return new Error('This question closed without an answer');
}

export async function waitingCard(ctx: QueryCtx, participantId: Id<'participants'>) {
  const turn = await activeOrdinaryTurn(ctx, participantId);
  if (!turn || turn.status !== 'running' || !turn.waitingOnHandId) return null;
  const hand = await ctx.db.get(turn.waitingOnHandId);
  return hand?.status === 'raised' ? hand : null;
}

export async function answerCard(
  ctx: MutationCtx,
  hand: Doc<'hands'>,
  answerer: Doc<'participants'>,
  answers: CardAnswer[],
  via: 'card' | 'chat',
  messageId?: Id<'messages'>,
) {
  if (hand.status !== 'raised') throw await closedCardError(ctx, hand);
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const complete =
    answers.length === hand.questions.length &&
    hand.questions.every((q) => {
      const a = byQuestion.get(q.id);
      return !!a && (a.labels.length > 0 || !!a.freeText?.trim());
    });
  if (!complete) throw new Error('Answer every question on the card');
  const room = await ctx.db.get(hand.roomId);
  if (!room) throw new Error('Unknown room');

  const now = Date.now();
  const teamMessageIds = (
    await ctx.db
      .query('teamMessages')
      .withIndex('by_room', (q) => q.eq('roomId', hand.roomId).gt('_creationTime', hand._creationTime))
      .collect()
  ).map((m) => m._id);

  const ordered = hand.questions.map((q) => byQuestion.get(q.id)!);
  await ctx.db.patch(hand._id, { status: 'answered', answers: ordered, answeredByParticipantId: answerer._id, answeredAt: now, via });
  const answeredLedgerId = await record(ctx, {
    roomId: hand.roomId,
    type: 'hand.answered',
    actorParticipantId: answerer._id,
    subjectId: hand._id,
    parentLedgerId: await raisedLedgerId(ctx, hand),
    payload: { via, messageId },
  });
  for (const answer of ordered) {
    const decisionId = await ctx.db.insert('decisions', {
      roomId: hand.roomId,
      choice: choiceText(answer),
      handId: hand._id,
      questionId: answer.questionId,
      answeredByParticipantId: answerer._id,
    });
    await record(ctx, {
      roomId: hand.roomId,
      type: 'decision.recorded',
      actorParticipantId: answerer._id,
      subjectId: decisionId,
      parentLedgerId: answeredLedgerId,
      payload: { handId: hand._id, questionId: answer.questionId, teamMessageIds },
    });
  }

  await ctx.db.insert('commands', {
    runnerId: room.runnerId,
    type: 'answer',
    turnId: hand.turnId,
    status: 'pending',
    payload: {
      handId: hand._id,
      requestId: hand.requestId,
      answeredBy: agentName(answerer.displayName),
      via,
      answers: ordered.map((a) => ({ ...a, question: hand.questions.find((q) => q.id === a.questionId)!.text })),
    },
  });
  await releaseTurn(ctx, hand);
}

// The card's ceiling passed: it closes with no decision, and the agent is told
// so through the same answer channel, so its turn can go on.
export async function expireUnanswered(ctx: MutationCtx, hand: Doc<'hands'>) {
  if (hand.status !== 'raised') return;
  const room = await ctx.db.get(hand.roomId);
  await close(ctx, hand, 'expired', 'No answer within 2 hours');
  if (room) {
    await ctx.db.insert('commands', {
      runnerId: room.runnerId,
      type: 'answer',
      turnId: hand.turnId,
      status: 'pending',
      payload: { handId: hand._id, requestId: hand.requestId, noDecision: true, message: NO_DECISION_MESSAGE },
    });
  }
}

// The turn ended under an open card: the card closes with no decision.
// Stopped turns cancel it; a lost runner or a turn that ended otherwise
// expires it.
export async function closeOpenCards(ctx: MutationCtx, turnId: Id<'turns'>, status: 'cancelled' | 'expired', reason: string) {
  const hands = await ctx.db.query('hands').withIndex('by_turn', (q) => q.eq('turnId', turnId)).collect();
  for (const hand of hands) if (hand.status === 'raised') await close(ctx, hand, status, reason);
}

async function close(ctx: MutationCtx, hand: Doc<'hands'>, status: 'cancelled' | 'expired', reason: string) {
  await ctx.db.patch(hand._id, { status, closedAt: Date.now(), closeReason: reason });
  await record(ctx, {
    roomId: hand.roomId,
    type: `hand.${status}`,
    actorParticipantId: hand.participantId,
    subjectId: hand._id,
    parentLedgerId: await raisedLedgerId(ctx, hand),
    payload: { reason },
  });
  await releaseTurn(ctx, hand);
}

// The turn now waits on its next open card, if it raised another, or on none.
async function releaseTurn(ctx: MutationCtx, hand: Doc<'hands'>) {
  const turn = await ctx.db.get(hand.turnId);
  if (!turn || turn.waitingOnHandId !== hand._id) return;
  const next = (await ctx.db.query('hands').withIndex('by_turn', (q) => q.eq('turnId', hand.turnId)).collect()).find(
    (h) => h._id !== hand._id && h.status === 'raised',
  );
  await ctx.db.patch(turn._id, { waitingOnHandId: next?._id });
}

async function raisedLedgerId(ctx: QueryCtx, hand: Doc<'hands'>) {
  return (await findLedger(ctx, hand.roomId, 'hand.raised', hand._id))?._id;
}

function choiceText(answer: CardAnswer) {
  const parts = [...answer.labels];
  const free = answer.freeText?.trim();
  if (free) parts.push(free);
  return parts.join('; ');
}
