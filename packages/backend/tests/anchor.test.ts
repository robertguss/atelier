import { expect, it, describe } from "vitest";

import { matchQuote, selectorAt } from "../convex/lib/anchor";
import { defined } from "./support";

const TEXT =
  "Robert wants the pricing page to ship on Friday, with the old plans kept for existing customers until March.";

const selectorFor = (text: string, passage: string, from = 0) => {
  const start = text.indexOf(passage, from);
  return selectorAt(text, start, start + passage.length);
};

// A 4,000-character block of distinct words, different for each seed.
const words = (seed: number) =>
  Array.from({ length: 800 }, (_, i) => `w${(i * 7919 + seed) % 977}`)
    .join(" ")
    .slice(0, 4000);

describe("comment anchors", () => {
  it("a selector holds the passage, up to 32 characters either side and its position", () => {
    const selector = selectorFor(TEXT, "ship on Friday");
    expect(selector).toStrictEqual({
      exact: "ship on Friday",
      position: TEXT.indexOf("ship on Friday"),
      prefix: "Robert wants the pricing page to ".slice(-32),
      suffix: ", with the old plans kept for ex",
    });
    expect(selector.prefix).toHaveLength(32);
    expect(selector.suffix).toHaveLength(32);
  });

  it("editing the text around a passage keeps the anchor on the passage", () => {
    const selector = selectorFor(TEXT, "ship on Friday");
    const edited =
      "After the call, Robert said the new pricing page has to ship on Friday, and the old plans stay for existing customers until March.";
    const match = defined(matchQuote(edited, selector));
    expect(edited.slice(match.start, match.end)).toBe("ship on Friday");
  });

  it("a small edit inside the passage keeps the anchor on the edited passage", () => {
    const selector = selectorFor(
      TEXT,
      "the old plans kept for existing customers"
    );
    const edited = TEXT.replace(
      "the old plans kept for existing customers",
      "the old plan kept for current customers"
    );
    const match = defined(matchQuote(edited, selector));
    expect(edited.slice(match.start, match.end)).toContain(
      "old plan kept for current customers"
    );
  });

  it("rewriting the passage and its surroundings entirely finds no anchor", () => {
    const selector = selectorFor(TEXT, "ship on Friday");
    expect(
      matchQuote(
        "Launch is postponed until the security review signs off.",
        selector
      )
    ).toBeNull();
  });

  it("a two-word quote that appears twice anchors to the occurrence nearest the stored position", () => {
    const text =
      "red car parked by the gate, then later a second red car parked by the gate";
    const second = text.lastIndexOf("red car");
    const selector = {
      exact: "red car",
      position: second,
      prefix: "",
      suffix: "",
    };
    expect(defined(matchQuote(text, selector)).start).toBe(second);
    expect(defined(matchQuote(text, { ...selector, position: 0 })).start).toBe(
      0
    );
  });

  it("a longest-allowed passage rewritten in a longest-allowed block is found gone within a fraction of a second", () => {
    const original = words(1);
    const started = performance.now();
    expect(matchQuote(words(2), selectorAt(original, 0, 3900))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
