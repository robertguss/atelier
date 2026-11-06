import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "./markdownStreamBlocks";

describe(splitMarkdownBlocks, () => {
  it("cuts finished blocks at blank lines", () => {
    expect(splitMarkdownBlocks("# Plan\n\nFirst paragraph.\n\nSecond")).toEqual(
      ["# Plan\n\n", "First paragraph.\n\n", "Second"]
    );
  });

  it("keeps an open code fence, blank lines included, in the last block", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual([
      "Intro.\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;",
    ]);
    expect(blocks!.join("")).toBe(text);
  });

  it("returns null for footnote syntax, which ties blocks together", () => {
    expect(splitMarkdownBlocks("A claim.[^1]\n\n[^1]: The source.")).toBeNull();
  });
});
