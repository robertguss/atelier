import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { record } from "./ledger";

// A follow-up to a review or its decision runs on a session of its own, even
// while the owner is alone in the room (see runner.claim). Follow-ups claimed
// before rooms had a document continued the agent's ordinary session when the
// owner was alone. When the first teammate joins, each agent that ran such a
// follow-up since its last reset starts a fresh session, so it cannot repeat
// review content to the teammate.

export const SESSION_RESET = "participant.session_reset";

const lastSessionReset = async (
  ctx: QueryCtx,
  participant: Doc<"participants">
) =>
  await ctx.db
    .query("ledger")
    .withIndex("by_room_type", (q) =>
      q
        .eq("roomId", participant.roomId)
        .eq("type", SESSION_RESET)
        .eq("subjectId", participant._id)
    )
    .order("desc")
    .first();

// Whether the agent ran a follow-up on its ordinary session since its last
// reset.
const ranSoloFollowUp = async (
  ctx: QueryCtx,
  participant: Doc<"participants">
) => {
  const reset = await lastSessionReset(ctx, participant);
  const since = reset?._creationTime ?? 0;
  const turns = await ctx.db
    .query("turns")
    .withIndex("by_participant", (q) => q.eq("participantId", participant._id))
    .filter((q) => q.gt(q.field("_creationTime"), since))
    .collect();
  return turns.some(
    (t) => t.followUp !== undefined && t.followUp.separateSession !== true
  );
};

const resetSession = async (
  ctx: MutationCtx,
  participant: Doc<"participants">,
  parentLedgerId: Id<"ledger">
) => {
  await ctx.db.patch(participant._id, {
    documentRevSeen: undefined,
    harnessSessionId: undefined,
  });
  await record(ctx, {
    parentLedgerId,
    payload: {
      reason:
        "A teammate joined after follow-ups to an independent review ran on this session",
    },
    roomId: participant.roomId,
    subjectId: participant._id,
    type: SESSION_RESET,
  });
};

export const resetSoloFollowUpSessions = async (
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  parentLedgerId: Id<"ledger">
) => {
  const participants = await ctx.db
    .query("participants")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const harnesses = participants.filter((p) => p.kind === "harness");
  const ran = await Promise.all(
    harnesses.map(async (p) => await ranSoloFollowUp(ctx, p))
  );
  const toReset = harnesses.filter((_, i) => ran[i] === true);
  for (const participant of toReset) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- resets are recorded in the ledger in participant order
    await resetSession(ctx, participant, parentLedgerId);
  }
};

// A turn created before its participant's last reset may carry the old
// session, so the session it reports is not kept as the ordinary one.
export const sessionResetAfter = async (ctx: QueryCtx, turn: Doc<"turns">) => {
  const participant = await ctx.db.get(turn.participantId);
  const reset = participant ? await lastSessionReset(ctx, participant) : null;
  return !!reset && reset._creationTime > turn._creationTime;
};
