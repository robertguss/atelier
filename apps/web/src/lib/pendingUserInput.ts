// Copied from T3 Code (https://github.com/pingdotgg/t3code), packages/client-runtime/src/state/pendingUserInput.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/** The question fields answer handling reads. Web and mobile question types both fit it. */
export interface PendingUserInputQuestion {
  readonly id: string;
  readonly options: readonly {
    readonly label: string;
    readonly value?: string | undefined;
  }[];
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly initialAnswer?: string | undefined;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: readonly string[];
  readonly customAnswer?: string;
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

export type PendingUserInputAnswer = string | readonly string[];

const normalizeDraftAnswer = (value: string | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Provider option values stay exact, including whitespace. Only options without a value match by label.
const resolvePendingUserInputOptionValue = (
  question: PendingUserInputQuestion,
  value: string
): string | null => {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some(
      (option) => option.value === undefined && option.label.trim() === label
    )
    ? label
    : null;
};

/** The draft's selections that name an offered option, deduplicated, in selection order. */
export const normalizeSelectedOptionValues = (
  question: PendingUserInputQuestion,
  value: readonly string[] | undefined
): readonly string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((entry: string) =>
          resolvePendingUserInputOptionValue(question, entry)
        )
        .filter((entry): entry is string => entry !== null)
    ),
  ];
};

const draftCustomAnswer = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined
): string | null => {
  if (question.allowCustomAnswer === false) {
    return null;
  }
  if (question.initialAnswer === undefined) {
    return normalizeDraftAnswer(draft?.customAnswer);
  }
  return draft?.customAnswer ?? null;
};

// Attachments alone answer a question that accepts custom answers, as empty text.
const attachmentsOnlyAnswer = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined
): "" | null =>
  question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0
    ? ""
    : null;

/** The answer to submit for one question, or null while it is unanswered. */
export const resolvePendingUserInputAnswer = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined
): PendingUserInputAnswer | null => {
  if (draft?.attachmentsBlocked === true) {
    return null;
  }
  const customAnswer = draftCustomAnswer(question, draft);
  if (customAnswer !== null && customAnswer.length > 0) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(
    question,
    draft?.selectedOptionValues
  );
  if (question.multiSelect === true) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (customAnswer ?? attachmentsOnlyAnswer(question, draft));
  }
  return (
    selectedOptionValues[0] ??
    customAnswer ??
    attachmentsOnlyAnswer(question, draft)
  );
};

export const setPendingUserInputCustomAnswer = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string
): PendingUserInputDraftAnswer => {
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  const selectedOptionValues =
    question.initialAnswer !== undefined || customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0
      ? { selectedOptionValues }
      : {}),
  };
};

export const isPendingUserInputOptionSelected = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string
): boolean => {
  if (
    question.allowCustomAnswer !== false &&
    normalizeDraftAnswer(draft?.customAnswer) !== null
  ) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(
    question,
    optionValue
  );
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues
    ).includes(resolvedOptionValue)
  );
};

/** Toggles an offered option. An unknown option returns the same draft. */
export const togglePendingUserInputOptionSelection = (
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string
): PendingUserInputDraftAnswer => {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(
    question,
    optionValue
  );
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  if (question.multiSelect === true) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(
      resolvedOptionValue
    )
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [resolvedOptionValue],
  };
};

/** Every question's answer keyed by question id, or null while any is unanswered. */
export const buildPendingUserInputAnswers = (
  questions: readonly PendingUserInputQuestion[],
  draftAnswers: Record<string, PendingUserInputDraftAnswer>
): Record<string, PendingUserInputAnswer> | null => {
  const answers: Record<string, PendingUserInputAnswer> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(
      question,
      draftAnswers[question.id]
    );
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
};
