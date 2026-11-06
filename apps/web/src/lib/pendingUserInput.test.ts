import { describe, expect, it } from "vitest";

import {
  buildCardAnswers,
  describeCardAnswer,
  type CardQuestion,
} from "./cardAnswers";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const single: CardQuestion = {
  id: "scope",
  header: "Scope",
  text: "How big should the plan be?",
  options: [{ label: "Small" }, { label: "Large" }],
  multiSelect: false,
  allowFreeText: true,
};
const multi: CardQuestion = {
  id: "areas",
  header: "Areas",
  text: "Which areas?",
  options: [{ label: "Billing" }, { label: "Search" }, { label: "Auth" }],
  multiSelect: true,
  allowFreeText: true,
};

describe("buildCardAnswers", () => {
  it("answers a single-select question with the chosen label", () => {
    const draft = togglePendingUserInputOptionSelection(
      single,
      undefined,
      "Large"
    );
    expect(buildCardAnswers([single], { scope: draft })).toEqual([
      { questionId: "scope", labels: ["Large"] },
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
      { questionId: "areas", labels: ["Search", "Billing"] },
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
      { questionId: "scope", labels: [], freeText: "Medium, but phased" },
    ]);
  });

  it("treats free text that matches an option label as free text", () => {
    const draft = setPendingUserInputCustomAnswer(single, undefined, "Small");
    expect(buildCardAnswers([single], { scope: draft })).toEqual([
      { questionId: "scope", labels: [], freeText: "Small" },
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

describe("describeCardAnswer", () => {
  it("shows labels joined with a comma, then any free text", () => {
    expect(describeCardAnswer({ questionId: "q", labels: ["A", "B"] })).toBe(
      "A, B"
    );
    expect(
      describeCardAnswer({ questionId: "q", labels: [], freeText: "go with B" })
    ).toBe("go with B");
    expect(
      describeCardAnswer({
        questionId: "q",
        labels: ["A"],
        freeText: "and keep it short",
      })
    ).toBe("A, and keep it short");
  });
});
