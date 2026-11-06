import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  type PendingUserInputQuestion,
} from './pendingUserInput';

/** One question on an agent's question card, as the backend stores it. */
export interface CardQuestion {
  id: string;
  header: string;
  text: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowFreeText: boolean;
}

/** The answer to one question, in the shape `hands.answer` takes. */
export interface CardAnswer {
  questionId: string;
  labels: string[];
  freeText?: string;
}

export type CardDrafts = Record<string, PendingUserInputDraftAnswer>;

export function toPendingQuestion(question: CardQuestion): PendingUserInputQuestion {
  return {
    id: question.id,
    options: question.options.map((o) => ({ label: o.label })),
    multiSelect: question.multiSelect,
    allowCustomAnswer: question.allowFreeText,
  };
}

/**
 * The whole card's answers, or null while any question is unanswered. Free
 * text wins over chosen options, as in the draft helpers, and is sent as
 * free text even when it happens to match an option's label.
 */
export function buildCardAnswers(questions: readonly CardQuestion[], drafts: CardDrafts): CardAnswer[] | null {
  const resolved = buildPendingUserInputAnswers(questions.map(toPendingQuestion), drafts);
  if (resolved === null) return null;
  return questions.map((question) => {
    const answer = resolved[question.id]!;
    if (typeof answer !== 'string') return { questionId: question.id, labels: [...answer] };
    const typed = question.allowFreeText && (drafts[question.id]?.customAnswer ?? '').trim().length > 0;
    return typed ? { questionId: question.id, labels: [], freeText: answer } : { questionId: question.id, labels: [answer] };
  });
}

/** One answer as people read it: chosen labels joined with ", ", then any free text. */
export function describeCardAnswer(answer: CardAnswer): string {
  return [...answer.labels, ...(answer.freeText ? [answer.freeText] : [])].join(', ');
}
