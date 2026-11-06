import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireMember } from './lib/auth';
import { answerCard, closedCardError, ownerOnlyCard } from './lib/cards';
import { offlineReason, runnerOnline } from './lib/dispatch';
import { cardAnswer } from './schema';

// Answer an agent's question card. Any member can; the first answer wins and
// a later one is told who answered. Each question becomes a decision.
export const answer = mutation({
  args: { handId: v.id('hands'), answers: v.array(cardAnswer) },
  handler: async (ctx, { handId, answers }) => {
    const hand = await ctx.db.get(handId);
    if (!hand) throw new Error('Unknown question');
    const { participant, isOwner } = await requireMember(ctx, hand.roomId);
    if (!isOwner && (await ownerOnlyCard(ctx, hand))) throw new Error('Only the owner can answer this question');
    if (hand.status !== 'raised') throw await closedCardError(ctx, hand);
    // An answer the runner cannot deliver would record a decision the agent never saw.
    const room = await ctx.db.get(hand.roomId);
    const runner = room ? await ctx.db.get(room.runnerId) : null;
    if (!runnerOnline(runner)) throw new Error(offlineReason(runner));
    await answerCard(ctx, hand, participant, answers, 'card');
  },
});
