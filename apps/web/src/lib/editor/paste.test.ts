import { describe, expect, it } from "vitest";

import { pastedBlocks } from "./paste";

describe("pasted text as blocks", () => {
  it("makes a block of each part between blank lines, its kind from its marker, without the marker", () => {
    const text = [
      "# Title",
      "- First item",
      "- Second item",
      "1. Numbered",
      "[ ] Call Dana",
      "> Quoted",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "---",
      "Plain *text*",
    ].join("\n\n");

    expect(pastedBlocks(text)).toStrictEqual([
      { kind: "heading", text: "Title" },
      { kind: "listItem", text: "First item" },
      { kind: "listItem", text: "Second item" },
      { kind: "numberedItem", text: "Numbered" },
      { kind: "todo", text: "Call Dana" },
      { kind: "quote", text: "Quoted" },
      { kind: "code", text: "const a = 1;\n\nconst b = 2;" },
      { kind: "divider", text: "" },
      { kind: "paragraph", text: "Plain *text*" },
    ]);
  });

  it("keeps lines with no blank line between them as one block", () => {
    expect(pastedBlocks("First line\r\nsecond line\n")).toStrictEqual([
      { kind: "paragraph", text: "First line\nsecond line" },
    ]);
  });
});
