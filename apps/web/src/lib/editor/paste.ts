import type { BlockKind } from "@atelier/shared";

export interface PastedBlock {
  kind: BlockKind;
  text: string;
}

// A part's first line names its kind, like the shortcuts typed at the start
// of a block. Stored text never keeps the marker.
const MARKERS: [RegExp, BlockKind][] = [
  [/^#{1,6} /u, "heading"],
  [/^[-*] /u, "listItem"],
  [/^\d+\. /u, "numberedItem"],
  [/^\[ ?\] /u, "todo"],
  [/^> /u, "quote"],
];

const FENCE = "```";

const blockOf = (lines: readonly string[]): PastedBlock => {
  const text = lines.join("\n");
  if (/^-{3,}$/u.test(text.trim())) {
    return { kind: "divider", text: "" };
  }
  for (const [marker, kind] of MARKERS) {
    if (marker.test(text)) {
      return { kind, text: text.replace(marker, "") };
    }
  }
  return { kind: "paragraph", text };
};

/** Pasted plain text as blocks: one per run of lines between blank lines, and one per fenced code block, blank lines and all. */
export const pastedBlocks = (text: string): PastedBlock[] => {
  const blocks: PastedBlock[] = [];
  let part: string[] = [];
  let code: string[] | null = null;
  const endPart = () => {
    if (part.length > 0) {
      blocks.push(blockOf(part));
    }
    part = [];
  };
  for (const line of text.split(/\r?\n/u)) {
    if (code) {
      if (line.startsWith(FENCE)) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code.push(line);
      }
    } else if (line.startsWith(FENCE)) {
      endPart();
      code = [];
    } else if (line.trim() === "") {
      endPart();
    } else {
      part.push(line);
    }
  }
  endPart();
  // An unclosed fence runs to the end.
  if (code) {
    blocks.push({ kind: "code", text: code.join("\n") });
  }
  return blocks;
};
