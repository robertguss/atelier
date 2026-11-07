import type { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import type { FunctionReturnType } from "convex/server";

import type { Names } from "./room";

export type DocumentData = NonNullable<
  FunctionReturnType<typeof api.documents.get>
>;

export type DocBlock = DocumentData["blocks"][number];

export type BlockKind = DocBlock["kind"];

export const BLOCK_KINDS: BlockKind[] = ["heading", "paragraph", "listItem"];

export const KIND_LABEL: Record<BlockKind, string> = {
  heading: "Heading",
  listItem: "List item",
  paragraph: "Paragraph",
};

// The server lets a lease lapse two minutes after its last renewal; renewing
// this often while the person types keeps it held with room to spare.
export const RENEW_EVERY_MS = 30_000;

/** A heading and the blocks under it. Blocks before the first heading form a section with no heading. */
export interface Section {
  heading: DocBlock | null;
  blocks: DocBlock[];
}

export const sectionsOf = (blocks: readonly DocBlock[]): Section[] => {
  const sections: Section[] = [];
  for (const block of blocks) {
    const current = sections.at(-1);
    if (block.kind === "heading") {
      sections.push({ blocks: [], heading: block });
    } else if (current === undefined) {
      sections.push({ blocks: [block], heading: null });
    } else {
      current.blocks.push(block);
    }
  }
  return sections;
};

/** Who holds an unexpired edit lease on the block, if anyone. */
export const leaseHolder = (block: DocBlock, now: number): string | null =>
  block.leaseHolderParticipantId && (block.leaseExpiresAt ?? 0) > now
    ? block.leaseHolderParticipantId
    : null;
export const authorText = (author: DocBlock["author"], names: Names) => {
  if (author.kind === "participant") {
    return names(author.participantId);
  }
  const credits = author.credits.map(names);
  return credits.length
    ? `Scribe (${names(author.participantId)}), from ${credits.join(", ")}`
    : `Scribe (${names(author.participantId)})`;
};

export const openThreadsText = (count: number) =>
  count === 1 ? "1 open thread" : `${count} open threads`;
export type ThreadsData = FunctionReturnType<typeof api.threads.list>;

export type DocThread = ThreadsData["open"][number];

export type ThreadComment = DocThread["comments"][number];

export type MentionState = ThreadComment["mentions"][number]["state"];

/** A passage of a block's stored text, [start, end) in string indices. */
export interface Passage {
  blockId: Id<"blocks">;
  start: number;
  end: number;
}

/** Threads in the order of their blocks, and by place within a block. Threads on blocks no longer in the document go last. */
export const threadsInBlockOrder = (
  threads: readonly DocThread[],
  blocks: readonly DocBlock[]
): DocThread[] => {
  const index = new Map<string, number>(blocks.map((b, i) => [b._id, i]));
  const place = (t: DocThread) => index.get(t.blockId) ?? blocks.length;
  return [...threads].toSorted(
    (a, b) => place(a) - place(b) || a.position - b.position
  );
};

// The backend sends the state as a plain string, so an unknown one reads as itself.
const MENTION_TEXT: Partial<Record<string, (name: string) => string>> = {
  answering: (name) => `${name} is answering`,
  cancelled: (name) => `mention of ${name} cancelled`,
  failed: (name) => `${name} could not reply`,
  replied: (name) => `${name} replied`,
  waiting: (name) => `waiting for ${name}`,
  waitingForRunner: () => "waiting for the runner",
};

/** Where a mention of a model stands, for its thread card. */
export const mentionText = (state: MentionState, name: string) =>
  MENTION_TEXT[state]?.(name) ?? state;

export type ChangeSetEntry = FunctionReturnType<
  typeof api.history.list
>["page"][number];

type VersionData = FunctionReturnType<typeof api.history.version>;

export type VersionBlock = VersionData["blocks"][number];

export type ChangeSetDiff = FunctionReturnType<typeof api.history.diff>;

const CHANGE_SET_TEXT: Record<
  ChangeSetEntry["kind"],
  (actor: string) => string
> = {
  human_edit: (actor) => `Edit by ${actor}`,
  model_turn: (actor) => `${actor}'s turn`,
  restore: (actor) => `Restore by ${actor}`,
  scribe_run: (actor) => `Scribe run by ${actor}`,
  template_seed: (actor) => `Template seeding by ${actor}`,
};

/** One history entry in plain words: what kind of change it was, and whose. A scribe run names its model and the person who called it in. */
export const entryText = (entry: ChangeSetEntry, names: Names) => {
  if (entry.kind === "scribe_run" && entry.scribeStartedByParticipantId) {
    return `Scribe run by ${names(entry.scribeParticipantId ?? entry.actorParticipantId)}, started by ${names(entry.scribeStartedByParticipantId)}`;
  }
  return CHANGE_SET_TEXT[entry.kind](names(entry.actorParticipantId));
};

/** How one change set left a block, as a version view marks it. */
export type BlockMark = "added" | "changed" | "moved" | "removed" | "commented";

export const MARK_LABEL: Record<BlockMark, string> = {
  added: "Added",
  changed: "Changed",
  commented: "Commented",
  moved: "Moved",
  removed: "Removed",
};

// Order keys sort by code unit, not by locale.
const compareOrder = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

/**
 * A version's blocks with the ones its change set touched marked. Blocks it
 * removed are not in the version, so they come back from the change set's
 * record, in the place they stood. A block added and removed again within
 * the change set left no trace and is not shown.
 */
export const markedVersion = (
  blocks: readonly VersionBlock[],
  diff: ChangeSetDiff
) => {
  const byBlock = new Map<VersionBlock["blockId"], ChangeSetDiff>();
  for (const revision of diff) {
    byBlock.set(revision.blockId, [
      ...(byBlock.get(revision.blockId) ?? []),
      revision,
    ]);
  }
  const marks = new Map<string, BlockMark>();
  const removed: VersionBlock[] = [];
  for (const [blockId, revisions] of byBlock) {
    const [first] = revisions;
    const last = revisions.at(-1);
    if (first === undefined || last === undefined) {
      continue;
    }
    if (last.op === "delete") {
      if (first.op !== "insert" && first.before) {
        removed.push({
          blockId,
          ...first.before,
        });
        marks.set(blockId, "removed");
      }
    } else if (first.op === "insert") {
      marks.set(blockId, "added");
    } else {
      marks.set(
        blockId,
        revisions.some((r) => r.op === "update") ? "changed" : "moved"
      );
    }
  }
  const all = [...blocks, ...removed].toSorted((a, b) =>
    compareOrder(a.order, b.order)
  );
  return all.map((block) => ({
    ...block,
    mark: marks.get(block.blockId) ?? null,
  }));
};

export type ScribeRun = NonNullable<
  FunctionReturnType<typeof api.scribe.latest>
>;

/** Whether a scribe run holds the document now. The lock lapses on its own at its expiry. */
export const scribeLocked = (
  doc: Pick<DocumentData, "scribeRunId" | "scribeLockExpiresAt">,
  now: number
) => !!doc.scribeRunId && (doc.scribeLockExpiresAt ?? 0) > now;
/** How long a run has been going, as "45s" or "3m 05s". */
export const elapsedText = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
