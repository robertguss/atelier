// The kinds of block a room document holds. Convex validators, the runner's
// tool schemas and the web editor all build from this one list.
export const BLOCK_KINDS = [
  "heading",
  "paragraph",
  "listItem",
  "todo",
  "numberedItem",
  "quote",
  "code",
  "divider",
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

// Limits on one block and on the whole document, for people and models alike.
// Passage matching, the scribe commit and the tools' reads are sized for them.
export const BLOCK_CHARS = 4000;
export const DOCUMENT_BLOCKS = 600;

// A numbered item's number is its place in the run of consecutive numbered
// items it belongs to. Nothing stores it, so moves renumber for free.
export const numberedPositions = (
  kinds: readonly BlockKind[]
): (number | undefined)[] => {
  let run = 0;
  return kinds.map((kind) => {
    run = kind === "numberedItem" ? run + 1 : 0;
    return run === 0 ? undefined : run;
  });
};

// How a block's kind reads to a model, the same in the prompt digest and in
// read_document: a to-do with its tick, a numbered item with its number.
export const kindLabel = (
  kind: BlockKind,
  checked: boolean | undefined,
  number: number | undefined
) => {
  if (kind === "todo") {
    return `todo (${checked === true ? "checked" : "unchecked"})`;
  }
  return number === undefined ? kind : `${kind} #${number}`;
};
