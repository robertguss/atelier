import { describe, expect, it } from "vitest";

import { intentFor } from "./keymap";
import type { KeyContext } from "./keymap";

// The caret in the middle of the text of a paragraph that has blocks around it.
const press = (
  key: KeyContext["key"],
  context: Partial<Omit<KeyContext, "key">> = {}
) =>
  intentFor({
    atEnd: false,
    atStart: false,
    empty: false,
    firstLine: false,
    hasNext: true,
    kind: "paragraph",
    lastLine: false,
    previous: { heldBy: null, kind: "paragraph" },
    ...context,
    key,
  });

const EMPTY = { atEnd: true, atStart: true, empty: true };

describe("the keyboard table", () => {
  describe("Enter", () => {
    it("at the end of a heading or paragraph adds a paragraph below; in the middle it splits off the same kind", () => {
      expect(press("Enter", { atEnd: true, kind: "heading" })).toStrictEqual({
        intent: "splitParagraph",
      });
      expect(press("Enter", { kind: "heading" })).toStrictEqual({
        intent: "splitSame",
      });
      expect(press("Enter", { atEnd: true })).toStrictEqual({
        intent: "splitParagraph",
      });
      expect(press("Enter")).toStrictEqual({ intent: "splitSame" });
    });

    it("on an empty heading or paragraph adds a paragraph below", () => {
      expect(press("Enter", { ...EMPTY, kind: "heading" })).toStrictEqual({
        intent: "splitParagraph",
      });
      expect(press("Enter", EMPTY)).toStrictEqual({
        intent: "splitParagraph",
      });
    });

    it("at the end of a to-do, list item, numbered item or quote starts another of the same kind", () => {
      for (const kind of [
        "todo",
        "listItem",
        "numberedItem",
        "quote",
      ] as const) {
        expect(press("Enter", { atEnd: true, kind })).toStrictEqual({
          intent: "splitSame",
        });
        expect(press("Enter", { kind })).toStrictEqual({ intent: "splitSame" });
      }
    });

    it("on an empty to-do, list item, numbered item or quote turns it into a paragraph", () => {
      for (const kind of [
        "todo",
        "listItem",
        "numberedItem",
        "quote",
      ] as const) {
        expect(press("Enter", { ...EMPTY, kind })).toStrictEqual({
          intent: "convertToParagraph",
        });
      }
    });

    it("at the start of a non-empty block adds an empty block above", () => {
      expect(press("Enter", { atStart: true, kind: "listItem" })).toStrictEqual(
        { intent: "insertAbove" }
      );
      expect(press("Enter", { atStart: true })).toStrictEqual({
        intent: "insertAbove",
      });
    });

    it("in code adds a new line anywhere, and Mod+Enter adds a paragraph below", () => {
      for (const context of [{}, { atEnd: true }, EMPTY]) {
        expect(press("Enter", { ...context, kind: "code" })).toStrictEqual({
          intent: "newline",
        });
      }
      expect(press("Shift-Enter", { kind: "code" })).toStrictEqual({
        intent: "newline",
      });
      expect(press("Mod-Enter", { ...EMPTY, kind: "code" })).toStrictEqual({
        intent: "insertBelow",
      });
    });

    it("with Shift breaks the line inside any text block", () => {
      for (const kind of ["heading", "paragraph", "todo", "quote"] as const) {
        expect(press("Shift-Enter", { atEnd: true, kind })).toStrictEqual({
          intent: "hardBreak",
        });
      }
    });

    it("on a divider adds a paragraph below, and Shift+Enter does nothing", () => {
      expect(press("Enter", { ...EMPTY, kind: "divider" })).toStrictEqual({
        intent: "insertBelow",
      });
      expect(press("Shift-Enter", { ...EMPTY, kind: "divider" })).toStrictEqual(
        { intent: "none" }
      );
    });
  });

  describe("Backspace", () => {
    it("at the start of a non-empty to-do turns it into a paragraph, and at the start of a paragraph merges it into the block above", () => {
      expect(press("Backspace", { atStart: true, kind: "todo" })).toStrictEqual(
        { intent: "convertToParagraph" }
      );
      expect(press("Backspace", { atStart: true })).toStrictEqual({
        intent: "mergeIntoPrevious",
      });
      expect(
        press("Backspace", { atStart: true, kind: "heading" })
      ).toStrictEqual({ intent: "mergeIntoPrevious" });
    });

    it("turns a list item, numbered item, quote or code block into a paragraph", () => {
      for (const kind of [
        "listItem",
        "numberedItem",
        "quote",
        "code",
      ] as const) {
        expect(press("Backspace", { atStart: true, kind })).toStrictEqual({
          intent: "convertToParagraph",
        });
      }
    });

    it("removes a divider above instead of merging into it", () => {
      expect(
        press("Backspace", {
          atStart: true,
          previous: { heldBy: null, kind: "divider" },
        })
      ).toStrictEqual({ intent: "removePrevious" });
    });

    it("does nothing, naming the holder, when someone else holds the block above", () => {
      expect(
        press("Backspace", {
          atStart: true,
          previous: { heldBy: "Ana", kind: "paragraph" },
        })
      ).toStrictEqual({ heldBy: "Ana", intent: "none" });
    });

    it("at the start of the first block does nothing in a paragraph and turns a heading into a paragraph", () => {
      expect(press("Backspace", { ...EMPTY, previous: null })).toStrictEqual({
        intent: "none",
      });
      expect(
        press("Backspace", { atStart: true, kind: "heading", previous: null })
      ).toStrictEqual({ intent: "convertToParagraph" });
    });

    it("anywhere but the start is the editor's own", () => {
      expect(press("Backspace", { atEnd: true, kind: "todo" })).toStrictEqual({
        intent: "none",
      });
    });

    it("or Delete on a focused divider removes it", () => {
      expect(press("Backspace", { ...EMPTY, kind: "divider" })).toStrictEqual({
        intent: "removeSelf",
      });
      expect(press("Delete", { ...EMPTY, kind: "divider" })).toStrictEqual({
        intent: "removeSelf",
      });
      expect(press("Delete", { atEnd: true })).toStrictEqual({
        intent: "none",
      });
    });
  });

  describe("arrows", () => {
    it("move to the block above from the first line and below from the last line, and are the editor's own elsewhere", () => {
      expect(press("ArrowUp", { firstLine: true })).toStrictEqual({
        intent: "focusPrevious",
      });
      expect(press("ArrowDown", { lastLine: true })).toStrictEqual({
        intent: "focusNext",
      });
      expect(press("ArrowUp", { lastLine: true })).toStrictEqual({
        intent: "none",
      });
      expect(press("ArrowDown", { firstLine: true })).toStrictEqual({
        intent: "none",
      });
    });

    it("stay put at the top and bottom of the document", () => {
      expect(
        press("ArrowUp", { firstLine: true, previous: null })
      ).toStrictEqual({ intent: "none" });
      expect(
        press("ArrowDown", { hasNext: false, lastLine: true })
      ).toStrictEqual({ intent: "none" });
    });

    it("move on from a focused divider either way", () => {
      expect(press("ArrowUp", { ...EMPTY, kind: "divider" })).toStrictEqual({
        intent: "focusPrevious",
      });
      expect(press("ArrowDown", { ...EMPTY, kind: "divider" })).toStrictEqual({
        intent: "focusNext",
      });
    });
  });
});
