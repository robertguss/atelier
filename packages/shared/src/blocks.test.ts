import { describe, expect, it } from "vitest";

import { kindLabel, numberedPositions } from "./blocks.ts";

describe("numbered positions", () => {
  it("numbers each run of consecutive numbered items from 1 and leaves other blocks unnumbered", () => {
    expect(
      numberedPositions([
        "numberedItem",
        "numberedItem",
        "paragraph",
        "numberedItem",
      ])
    ).toStrictEqual([1, 2, undefined, 1]);
  });
});

describe("kind labels", () => {
  it("shows a to-do's tick and a numbered item's number, and other kinds by name", () => {
    expect([
      kindLabel("todo", true, undefined),
      kindLabel("todo", undefined, undefined),
      kindLabel("numberedItem", undefined, 2),
      kindLabel("quote", undefined, undefined),
    ]).toStrictEqual([
      "todo (checked)",
      "todo (unchecked)",
      "numberedItem #2",
      "quote",
    ]);
  });
});
