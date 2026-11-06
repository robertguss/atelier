import { describe, expect, it } from "vitest";

import { buildCardAnswers, describeCardAnswer } from "./cardAnswers";
import type { CardQuestion } from "./cardAnswers";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const single: CardQuestion = {
  allowFreeText: true,
  header: "Scope",
  id: "scope",
  multiSelect: false,
  options: [{ label: "Small" }, { label: "Large" }],
  text: "How big should the plan be?",
};
const multi: CardQuestion = {
  allowFreeText: true,
  header: "Areas",
  id: "areas",
  multiSelect: true,
  options: [{ label: "Billing" }, { label: "Search" }, { label: "Auth" }],
  text: "Which areas?",
};

describe(buildCardAnswers, () => {
  it("answers a single-select question with the chosen label", () => {
    const draft = togglePendingUserInputOptionSelection(
      single,
      undefined,
      "Large"
    );
    expect(buildCardAnswers([single], { scope: draft })).toEqual([
      { labels: ["Large"], questionId: "scope" },
    ]);
  });

  it("answers a multi-select question with every chosen label, in choice order", () => {
    let draft = togglePendingUserInputOptionSelection(
      multi,
      undefined,
      "Search"
    );
    draft = togglePendingUserInputOptionSelection(multi, draft, "Billing");
    const answers = buildCardAnswers([multi], { areas: draft });
    expect(answers).toEqual([
      { labels: ["Search", "Billing"], questionId: "areas" },
    ]);
    expect(describeCardAnswer(answers![0]!)).toBe("Search, Billing");
  });

  it("answers with free text, which replaces any chosen option", () => {
    let draft = togglePendingUserInputOptionSelection(
      single,
      undefined,
      "Small"
    );
    draft = setPendingUserInputCustomAnswer(
      single,
      draft,
      "  Medium, but phased "
    );
    expect(buildCardAnswers([single], { scope: draft })).toEqual([
      { freeText: "Medium, but phased", labels: [], questionId: "scope" },
    ]);
  });

  it("treats free text that matches an option label as free text", () => {
    const draft = setPendingUserInputCustomAnswer(single, undefined, "Small");
    expect(buildCardAnswers([single], { scope: draft })).toEqual([
      { freeText: "Small", labels: [], questionId: "scope" },
    ]);
  });

  it("returns null until every question on the card is answered", () => {
    const draft = togglePendingUserInputOptionSelection(
      single,
      undefined,
      "Small"
    );
    expect(buildCardAnswers([single, multi], { scope: draft })).toBeNull();
  });

  it("ignores free text on a question that does not allow it", () => {
    const closed = { ...single, allowFreeText: false };
    const draft = setPendingUserInputCustomAnswer(
      closed,
      undefined,
      "Something else"
    );
    expect(buildCardAnswers([closed], { scope: draft })).toBeNull();
  });
});

describe(describeCardAnswer, () => {
  it("shows labels joined with a comma, then any free text", () => {
    expect(describeCardAnswer({ labels: ["A", "B"], questionId: "q" })).toBe(
      "A, B"
    );
    expect(
      describeCardAnswer({ freeText: "go with B", labels: [], questionId: "q" })
    ).toBe("go with B");
    expect(
      describeCardAnswer({
        freeText: "and keep it short",
        labels: ["A"],
        questionId: "q",
      })
    ).toBe("A, and keep it short");
  });
});
