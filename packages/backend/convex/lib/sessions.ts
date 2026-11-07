import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { record } from './ledger';

// While the owner is alone in a room, a follow-up to a review or its decision
// continues the agent's ordinary session. When the first teammate joins, each
// agent that ran such a follow-up since its last reset starts a fresh session,
// so it cannot repeat review content to the teammate.

export const SESSION_RESET = 'participant.session_reset';

export async function resetSoloFollowUpSessions(ctx: MutationCtx, roomId: Id<'rooms'>, parentLedgerId: Id<'ledger'>) {
  const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
  for (const participant of participants) {
    if (participant.kind !== 'harness') continue;
    const since = (await lastSessionReset(ctx, participant))?._creationTime ?? 0;
    const turns = await ctx.db
      .query('turns')
      .withIndex('by_participant', (q) => q.eq('participantId', participant._id))
      .filter((q) => q.gt(q.field('_creationTime'), since))
      .collect();
    if (!turns.some((t) => t.followUp && t.followUp.separateSession !== true)) continue;
    await ctx.db.patch(participant._id, { harnessSessionId: undefined });
    await record(ctx, {
      roomId,
      type: SESSION_RESET,
      subjectId: participant._id,
      parentLedgerId,
      payload: { reason: 'A teammate joined after follow-ups to an independent review ran on this session' },
    });
  }
}

// A turn created before its participant's last reset may carry the old
// session, so the session it reports is not kept as the ordinary one.
export async function sessionResetAfter(ctx: QueryCtx, turn: Doc<'turns'>) {
  const participant = await ctx.db.get(turn.participantId);
  const reset = participant ? await lastSessionReset(ctx, participant) : null;
  return !!reset && reset._creationTime > turn._creationTime;
}

async function lastSessionReset(ctx: QueryCtx, participant: Doc<'participants'>) {
  return await ctx.db
    .query('ledger')
    .withIndex('by_room_type', (q) => q.eq('roomId', participant.roomId).eq('type', SESSION_RESET).eq('subjectId', participant._id))
    .order('desc')
    .first();
}
