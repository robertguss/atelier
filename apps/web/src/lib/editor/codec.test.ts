import { describe, expect, it } from "vitest";

import { fromDoc, sliceDoc, toDoc } from "./codec";

const roundTrip = (kind: Parameters<typeof toDoc>[0], text: string) =>
  fromDoc(toDoc(kind, text));

describe("the block codec", () => {
  it.each([
    "Plain text.",
    "Mix **bold**, *italic*, ~~gone~~, `x < y` and [a link](https://example.com).",
    "# not a heading",
    "- not a list item",
    "1. not a numbered item",
    "> not a quote",
    String.raw`\*not emphasis\* and a lone \ backslash`,
    "snake_case_name, 2 * 3 and a ~ b",
    "First line\nsecond line",
    "**bold across\na break**",
    "See https://example.com/a_b for more",
    "",
  ])("round-trips %j byte-for-byte", (text) => {
    expect(roundTrip("paragraph", text)).toBe(text);
  });

  it("keeps code text literal, leading spaces, markdown-looking lines and all", () => {
    const code = "  # comment\n  const x = **y**;\n\n- not a list";
    expect(toDoc("code", code)).toStrictEqual({
      content: [{ content: [{ text: code, type: "text" }], type: "codeBlock" }],
      type: "doc",
    });
    expect(roundTrip("code", code)).toBe(code);
  });

  it("parses inline markdown only, so a paragraph starting with # stays a paragraph", () => {
    expect(toDoc("paragraph", "# x **b**")).toStrictEqual({
      content: [
        {
          content: [
            { text: "# x ", type: "text" },
            { marks: [{ type: "bold" }], text: "b", type: "text" },
          ],
          type: "paragraph",
        },
      ],
      type: "doc",
    });
  });

  it("turns a newline into a hard break and back", () => {
    expect(toDoc("quote", "a\nb")).toStrictEqual({
      content: [
        {
          content: [
            { text: "a", type: "text" },
            { type: "hardBreak" },
            { text: "b", type: "text" },
          ],
          type: "quote",
        },
      ],
      type: "doc",
    });
  });

  it("gives empty text an empty node of the kind", () => {
    expect(toDoc("heading", "")).toStrictEqual({
      content: [{ type: "heading" }],
      type: "doc",
    });
  });

  it("writes formatting the editor applied as inline markdown", () => {
    const link = { attrs: { href: "https://example.com" }, type: "link" };
    expect(
      fromDoc({
        content: [
          {
            content: [
              { text: "Say ", type: "text" },
              // Whitespace selected with a word stays outside the delimiters.
              { marks: [{ type: "bold" }], text: "hello ", type: "text" },
              { marks: [link], text: "there", type: "text" },
              { marks: [link, { type: "italic" }], text: " now", type: "text" },
              { text: ", run ", type: "text" },
              { marks: [{ type: "code" }], text: "a`b", type: "text" },
            ],
            type: "todo",
          },
        ],
        type: "doc",
      })
    ).toBe("Say **hello** [there *now*](https://example.com), run ``a`b``");
  });

  it("escapes characters that would otherwise read as markup", () => {
    expect(
      fromDoc({
        content: [
          {
            content: [{ text: "*not* [a] link", type: "text" }],
            type: "listItem",
          },
        ],
        type: "doc",
      })
    ).toBe(String.raw`\*not\* \[a\] link`);
  });

  it("cuts a block where the caret stands, each side keeping its formatting and line breaks", () => {
    const doc = toDoc("paragraph", "Charge **per seat**.\nYearly");
    // Position 1 is the start of the text; "Charge per" ends at 11.
    expect(fromDoc(sliceDoc(doc, 0, 11))).toBe("Charge **per**");
    expect(fromDoc(sliceDoc(doc, 11))).toBe(" **seat**.\nYearly");
    expect(fromDoc(sliceDoc(toDoc("code", "a *b*"), 3))).toBe("*b*");
  });
});
