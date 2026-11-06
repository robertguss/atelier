import type { api } from '@atelier/backend/api';
import type { FunctionArgs } from 'convex/server';
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  type PendingUserInputQuestion,
} from './pendingUserInput';
import type { PaneCard } from './room';

export type CardQuestion = PaneCard['questions'][number];
export type CardAnswer = FunctionArgs<typeof api.hands.answer>['answers'][number];

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

export function describeCardAnswer(answer: CardAnswer): string {
  return [...answer.labels, ...(answer.freeText ? [answer.freeText] : [])].join(', ');
}
