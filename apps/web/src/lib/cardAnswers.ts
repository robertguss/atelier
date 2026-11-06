import type { api } from "@atelier/backend/api";
import type { FunctionArgs } from "convex/server";

import { buildPendingUserInputAnswers } from "./pendingUserInput";
import type {
  PendingUserInputDraftAnswer,
  PendingUserInputQuestion,
} from "./pendingUserInput";
import type { PaneCard } from "./room";

export type CardQuestion = PaneCard["questions"][number];
export type CardAnswer = FunctionArgs<
  typeof api.hands.answer
>["answers"][number];

export type CardDrafts = Record<string, PendingUserInputDraftAnswer>;

export const toPendingQuestion = (
  question: CardQuestion
): PendingUserInputQuestion => ({
  allowCustomAnswer: question.allowFreeText,
  id: question.id,
  multiSelect: question.multiSelect,
  options: question.options.map((o) => ({ label: o.label })),
});

/**
 * The whole card's answers, or null while any question is unanswered. Free
 * text wins over chosen options, as in the draft helpers, and is sent as
 * free text even when it happens to match an option's label.
 */
export const buildCardAnswers = (
  questions: readonly CardQuestion[],
  drafts: CardDrafts
): CardAnswer[] | null => {
  const resolved = buildPendingUserInputAnswers(
    questions.map(toPendingQuestion),
    drafts
  );
  if (resolved === null) {
    return null;
  }
  return questions.map((question) => {
    const answer = resolved[question.id];
    if (answer === undefined) {
      throw new Error(`No answer was resolved for question ${question.id}`);
    }
    if (typeof answer !== "string") {
      return { labels: [...answer], questionId: question.id };
    }
    const typed =
      question.allowFreeText &&
      (drafts[question.id]?.customAnswer ?? "").trim().length > 0;
    return typed
      ? { freeText: answer, labels: [], questionId: question.id }
      : { labels: [answer], questionId: question.id };
  });
};

export const describeCardAnswer = (answer: CardAnswer): string =>
  [
    ...answer.labels,
    ...(answer.freeText !== undefined && answer.freeText !== ""
      ? [answer.freeText]
      : []),
  ].join(", ");
