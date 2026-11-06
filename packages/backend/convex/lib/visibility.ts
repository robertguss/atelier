import type { Doc } from "../_generated/dataModel";

// Members never see independent reviews, review answers, or follow-ups to a
// review or its decision. Every read path asks these two helpers, so the rule
// lives in one place.

// The timeline shows the owner review answers; the agent pane shows them to
// no one, so it passes `ownerSeesReviewAnswers: false`.
export const visibleMessage = (
  m: Doc<"messages">,
  isOwner: boolean,
  { ownerSeesReviewAnswers }: { ownerSeesReviewAnswers: boolean }
) => {
  if (m.visibility !== "room") {
    return false;
  }
  if (m.ritualId) {
    return isOwner && ownerSeesReviewAnswers;
  }
  return isOwner || !m.followUpRitualId;
};

// Review turns are shown on neither path; follow-up turns only to the owner.
export const visibleTurn = (t: Doc<"turns">, isOwner: boolean) =>
  !t.ritualId && (isOwner || !t.followUp);
