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
  // A thread delivery is a comment, shown in its thread, never in the chat.
  if (m.visibility !== "room" || m.threadId) {
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

// What a model turn may do with the room document. An independent review
// never sees it, so reviews stay blind. A follow-up to a review or its
// decision may read it but never change it, so review content cannot reach a
// document a teammate reads. A scribe turn reads it and changes it only
// through its draft, never with the ordinary write tools. Every other turn
// may write.
export type DocumentMode = "none" | "read" | "write" | "scribe";

export const documentMode = (t: Doc<"turns">): DocumentMode => {
  if (t.ritualId) {
    return "none";
  }
  if (t.scribeRunId) {
    return "scribe";
  }
  if (t.followUp) {
    return "read";
  }
  return "write";
};

export const canWriteDocument = (t: Doc<"turns">) =>
  documentMode(t) === "write";
