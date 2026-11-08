import { describe, expect, it } from "vitest";

import { numberedPositions } from "./blocks.ts";

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
