import type { BlockKind } from "@atelier/shared";

// What Enter, Backspace and the arrows do to a block, by kind and caret
// position. The block's editor turns the intent into an edit; "none" leaves
// the key to the editor's own handling.

export type Intent =
  | "splitSame"
  | "splitParagraph"
  | "insertAbove"
  | "insertBelow"
  | "hardBreak"
  | "newline"
  | "convertToParagraph"
  | "mergeIntoPrevious"
  | "removePrevious"
  | "removeSelf"
  | "focusPrevious"
  | "focusNext"
  | "none";

export interface KeyContext {
  key:
    | "Enter"
    | "Shift-Enter"
    | "Mod-Enter"
    | "Backspace"
    | "Delete"
    | "ArrowUp"
    | "ArrowDown";
  kind: BlockKind;
  /** The caret sits, with nothing selected, at the start or end of the text. */
  atStart: boolean;
  atEnd: boolean;
  empty: boolean;
  /** The caret is on the block's first or last line. */
  firstLine: boolean;
  lastLine: boolean;
  /** The block above, with the name of anyone else editing it. */
  previous: { kind: BlockKind; heldBy: string | null } | null;
  hasNext: boolean;
}

// Kinds that Enter on an empty block, or Backspace at the start, turn into a paragraph.
const ITEM_KINDS = new Set<BlockKind>([
  "listItem",
  "numberedItem",
  "quote",
  "todo",
]);

const enter = ({ key, kind, empty, atStart, atEnd }: KeyContext): Intent => {
  if (kind === "divider") {
    return key === "Shift-Enter" ? "none" : "insertBelow";
  }
  if (kind === "code") {
    return key === "Mod-Enter" ? "insertBelow" : "newline";
  }
  if (key === "Shift-Enter") {
    return "hardBreak";
  }
  if (empty) {
    return ITEM_KINDS.has(kind) ? "convertToParagraph" : "splitParagraph";
  }
  if (atStart) {
    return "insertAbove";
  }
  return atEnd && (kind === "heading" || kind === "paragraph")
    ? "splitParagraph"
    : "splitSame";
};

const backspace = ({
  kind,
  atStart,
  previous,
}: KeyContext): { intent: Intent; heldBy?: string } => {
  if (kind === "divider") {
    return { intent: "removeSelf" };
  }
  if (!atStart) {
    return { intent: "none" };
  }
  if (kind !== "paragraph" && (kind !== "heading" || previous === null)) {
    return { intent: "convertToParagraph" };
  }
  if (previous === null) {
    return { intent: "none" };
  }
  if (previous.kind === "divider") {
    return { intent: "removePrevious" };
  }
  return previous.heldBy === null
    ? { intent: "mergeIntoPrevious" }
    : { heldBy: previous.heldBy, intent: "none" };
};

/** What a key does to the block; `heldBy` names whoever stops a merge. */
export const intentFor = (
  context: KeyContext
): { intent: Intent; heldBy?: string } => {
  const { key, kind, previous, hasNext } = context;
  const divider = kind === "divider";
  switch (key) {
    case "Enter":
    case "Shift-Enter":
    case "Mod-Enter": {
      return { intent: enter(context) };
    }
    case "Backspace": {
      return backspace(context);
    }
    case "Delete": {
      return { intent: divider ? "removeSelf" : "none" };
    }
    case "ArrowUp": {
      return {
        intent:
          (divider || context.firstLine) && previous !== null
            ? "focusPrevious"
            : "none",
      };
    }
    case "ArrowDown": {
      return {
        intent: (divider || context.lastLine) && hasNext ? "focusNext" : "none",
      };
    }
    default: {
      return { intent: "none" };
    }
  }
};
