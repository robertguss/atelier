import { BLOCK_CHARS } from "@atelier/shared";
import type { Infer } from "convex/values";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { blockState, changeSetKind, templateSection } from "../schema";
import { getUser } from "./auth";
import { record } from "./ledger";
import { required } from "./required";
import { detachThreads, reanchorThreads } from "./threads";

// Every write to a room document goes through this file: it keeps the block
// row, its revision, the document rev, the change set, checkpoints and the
// anchors of the block's comment threads in step.

export type TemplateSection = Infer<typeof templateSection>;
type BlockState = Infer<typeof blockState>;

// Atelier's default template. Robert's own templates are rows in `templates`.
export const DEFAULT_TEMPLATE: TemplateSection[] = [
  { heading: "What's happened" },
  { heading: "Ideas & notes" },
  { heading: "Open questions" },
];

// A checkpoint every this many revisions bounds how much history a version
// rebuild replays.
export const CHECKPOINT_EVERY = 200;

// An order key between two neighbours; null means the start or end.
export const orderBetween = (before: string | null, after: string | null) =>
  generateKeyBetween(before, after);

export const getDocument = async (ctx: QueryCtx, roomId: Id<"rooms">) =>
  await ctx.db
    .query("documents")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .unique();

// A reason the text cannot be a block, or null.
export const blockTextProblem = (text: string): string | null =>
  text.length > BLOCK_CHARS
    ? `A block holds at most ${BLOCK_CHARS} characters; this one has ${text.length}. Split it into several blocks.`
    : null;

// The document's blocks in order, without deleted ones.
export const liveBlocks = async (ctx: QueryCtx, documentId: Id<"documents">) =>
  await ctx.db
    .query("blocks")
    .withIndex("by_document_live", (q) =>
      q.eq("documentId", documentId).eq("deletedAt", undefined)
    )
    .collect();

interface ChangeSetSpec {
  kind: Infer<typeof changeSetKind>;
  actorParticipantId?: Id<"participants">;
  turnId?: Id<"turns">;
  scribeRunId?: Id<"scribeRuns">;
}

// The change set for a model turn or scribe run, reused across that turn's
// writes, or a new one. Each new change set gets one id-only ledger row.
export const openChangeSet = async (
  ctx: MutationCtx,
  documentId: Id<"documents">,
  spec: ChangeSetSpec
) => {
  if (spec.turnId) {
    const found = await ctx.db
      .query("changeSets")
      .withIndex("by_turn", (q) => q.eq("turnId", spec.turnId))
      .first();
    if (found) {
      return found._id;
    }
  }
  if (spec.scribeRunId) {
    const found = await ctx.db
      .query("changeSets")
      .withIndex("by_scribe_run", (q) => q.eq("scribeRunId", spec.scribeRunId))
      .first();
    if (found) {
      return found._id;
    }
  }
  const document = required(await ctx.db.get(documentId), "document");
  const changeSetId = await ctx.db.insert("changeSets", {
    documentId,
    roomId: document.roomId,
    ...spec,
    at: Date.now(),
    lastRev: document.rev,
    revisionCount: 0,
  });
  await record(ctx, {
    actorParticipantId: spec.actorParticipantId,
    payload: { changeSetId, documentId, kind: spec.kind },
    roomId: document.roomId,
    subjectId: changeSetId,
    type: "document.changed",
  });
  return changeSetId;
};

const stateOf = (block: Doc<"blocks">): BlockState => ({
  author: block.author,
  checked: block.checked,
  kind: block.kind,
  order: block.order,
  text: block.text,
});

// Every revision bumps the document rev and its change set. Call `nextRev`
// before writing the block and `recordRevision` after.
const nextRev = async (ctx: MutationCtx, changeSetId: Id<"changeSets">) => {
  const changeSet = required(await ctx.db.get(changeSetId), "changeSet");
  const document = required(await ctx.db.get(changeSet.documentId), "document");
  const rev = document.rev + 1;
  await ctx.db.patch(document._id, {
    rev,
    revisionsSinceCheckpoint: document.revisionsSinceCheckpoint + 1,
  });
  await ctx.db.patch(changeSetId, {
    lastRev: rev,
    revisionCount: changeSet.revisionCount + 1,
  });
  return { document, rev };
};

// Copies every live block into a checkpoint at the current rev.
export const takeCheckpoint = async (
  ctx: MutationCtx,
  documentId: Id<"documents">,
  reason: Doc<"documentCheckpoints">["reason"]
) => {
  const document = required(await ctx.db.get(documentId), "document");
  const blocks = await liveBlocks(ctx, documentId);
  const checkpointId = await ctx.db.insert("documentCheckpoints", {
    blockCount: blocks.length,
    documentId,
    reason,
    rev: document.rev,
  });
  await Promise.all(
    blocks.map(async (block) => {
      await ctx.db.insert("checkpointBlocks", {
        blockId: block._id,
        checkpointId,
        ...stateOf(block),
      });
    })
  );
  await ctx.db.patch(documentId, { revisionsSinceCheckpoint: 0 });
  return checkpointId;
};

// Appends the revision, then takes a checkpoint if one is due, so the
// checkpoint includes this revision. Only a scribe commit writes while the
// scribe lock is held, and it ends with its own checkpoint, so none is taken
// in the middle of it.
const recordRevision = async (
  ctx: MutationCtx,
  revision: Omit<Doc<"blockRevisions">, "_id" | "_creationTime">
) => {
  await ctx.db.insert("blockRevisions", revision);
  const document = required(await ctx.db.get(revision.documentId), "document");
  if (
    document.revisionsSinceCheckpoint >= CHECKPOINT_EVERY &&
    document.scribeRunId === undefined
  ) {
    await takeCheckpoint(ctx, document._id, "interval");
  }
};

export const insertBlock = async (
  ctx: MutationCtx,
  changeSetId: Id<"changeSets">,
  fields: BlockState & {
    fromTemplate?: boolean;
    humanEditedAt?: number;
    sourceBlockIds?: Id<"blocks">[];
  }
) => {
  const { rev, document } = await nextRev(ctx, changeSetId);
  const blockId = await ctx.db.insert("blocks", {
    documentId: document._id,
    rev,
    roomId: document.roomId,
    ...fields,
  });
  const { order, kind, text, author, checked } = fields;
  await recordRevision(ctx, {
    after: { author, checked, kind, order, text },
    blockId,
    changeSetId,
    documentId: document._id,
    op: "insert",
    rev,
  });
  return blockId;
};

export type BlockPatch = Partial<
  Pick<
    Doc<"blocks">,
    | "order"
    | "kind"
    | "text"
    | "checked"
    | "author"
    | "humanEditedAt"
    | "sourceBlockIds"
  >
>;

// Changing a block's text also clears its template-guidance mark. Returns the
// block's new rev.
export const patchBlock = async (
  ctx: MutationCtx,
  changeSetId: Id<"changeSets">,
  blockId: Id<"blocks">,
  fields: BlockPatch
) => {
  const block = required(await ctx.db.get(blockId), "block");
  const before = stateOf(block);
  const after = stateOf({ ...block, ...fields });
  const textChanged = after.text !== before.text;
  const op =
    after.order !== before.order &&
    !textChanged &&
    after.kind === before.kind &&
    after.checked === before.checked
      ? "move"
      : "update";
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, {
    ...fields,
    rev,
    ...(textChanged ? { fromTemplate: undefined } : {}),
  });
  await recordRevision(ctx, {
    after,
    before,
    blockId,
    changeSetId,
    documentId: document._id,
    op,
    rev,
  });
  if (textChanged) {
    await reanchorThreads(ctx, blockId, after.text, changeSetId);
  }
  return rev;
};

export const deleteBlock = async (
  ctx: MutationCtx,
  changeSetId: Id<"changeSets">,
  blockId: Id<"blocks">
) => {
  const block = required(await ctx.db.get(blockId), "block");
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, { deletedAt: Date.now(), rev });
  await recordRevision(ctx, {
    before: stateOf(block),
    blockId,
    changeSetId,
    documentId: document._id,
    op: "delete",
    rev,
  });
  await detachThreads(ctx, blockId, changeSetId);
};

// Brings a deleted block back under its own id, as a restore does.
export const reviveBlock = async (
  ctx: MutationCtx,
  changeSetId: Id<"changeSets">,
  blockId: Id<"blocks">,
  state: BlockState,
  fields: Pick<BlockPatch, "humanEditedAt"> = {}
) => {
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, {
    ...state,
    ...fields,
    deletedAt: undefined,
    rev,
  });
  await recordRevision(ctx, {
    after: state,
    blockId,
    changeSetId,
    documentId: document._id,
    op: "insert",
    rev,
  });
  await reanchorThreads(ctx, blockId, state.text, changeSetId);
};

// Order keys sort by code unit, so no locale comparison.
const compareOrder = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

// The document as it stood at `rev`: the nearest checkpoint at or before it,
// with every later revision up to `rev` replayed in order. A checkpoint every
// CHECKPOINT_EVERY revisions bounds the replay.
export const versionAt = async (
  ctx: QueryCtx,
  documentId: Id<"documents">,
  rev: number
) => {
  const checkpoint = await ctx.db
    .query("documentCheckpoints")
    .withIndex("by_document_rev", (q) =>
      q.eq("documentId", documentId).lte("rev", rev)
    )
    .order("desc")
    .first();
  const blocks = new Map<Id<"blocks">, BlockState>();
  if (checkpoint) {
    const rows = await ctx.db
      .query("checkpointBlocks")
      .withIndex("by_checkpoint", (q) => q.eq("checkpointId", checkpoint._id))
      .collect();
    for (const { blockId, order, kind, text, author, checked } of rows) {
      blocks.set(blockId, { author, checked, kind, order, text });
    }
  }
  const revisions = await ctx.db
    .query("blockRevisions")
    .withIndex("by_document_rev", (q) =>
      q
        .eq("documentId", documentId)
        .gt("rev", checkpoint?.rev ?? 0)
        .lte("rev", rev)
    )
    .collect();
  for (const revision of revisions) {
    if (revision.after) {
      blocks.set(revision.blockId, revision.after);
    } else {
      blocks.delete(revision.blockId);
    }
  }
  return [...blocks]
    .map(([blockId, state]) => ({ blockId, ...state }))
    .toSorted((a, b) => compareOrder(a.order, b.order));
};

// People's edit leases on blocks. A lease lapses this long after it was
// taken or last renewed.
export const LEASE_MS = 2 * 60_000;

export const SCRIBE_WORKING = "The scribe is working on the document";

export const scribeWorking = (document: Doc<"documents">, now: number) =>
  document.scribeRunId !== undefined &&
  (document.scribeLockExpiresAt ?? 0) > now;

// Who holds an unexpired lease on the block, if anyone.
export const leaseHolder = (block: Doc<"blocks">, now: number) =>
  block.leaseHolderParticipantId !== undefined &&
  (block.leaseExpiresAt ?? 0) > now
    ? block.leaseHolderParticipantId
    : undefined;

export const participantName = async (
  ctx: QueryCtx,
  participantId: Id<"participants">
) => {
  const participant = await ctx.db.get(participantId);
  return participant?.displayName ?? "Someone";
};

// The index of the last block in the section that holds block `index`: the
// blocks after a heading, up to the next heading.
export const sectionEnd = (blocks: Doc<"blocks">[], index: number) => {
  let end = index;
  while (blocks[end + 1] !== undefined && blocks[end + 1]?.kind !== "heading") {
    end += 1;
  }
  return end;
};

export const clearLease = async (ctx: MutationCtx, blockId: Id<"blocks">) => {
  await ctx.db.patch(blockId, {
    leaseChangeSetId: undefined,
    leaseExpiresAt: undefined,
    leaseHolderParticipantId: undefined,
  });
};

// Releases every lease a person holds in the room's document, except on `keep`.
export const releaseLeasesOf = async (
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  participantId: Id<"participants">,
  keep?: Id<"blocks">
) => {
  const document = await getDocument(ctx, roomId);
  if (!document) {
    return;
  }
  const blocks = await ctx.db
    .query("blocks")
    .withIndex("by_document_order", (q) => q.eq("documentId", document._id))
    .collect();
  await Promise.all(
    blocks
      .filter(
        (block) =>
          block.leaseHolderParticipantId === participantId && block._id !== keep
      )
      .map(async (block) => {
        await clearLease(ctx, block._id);
      })
  );
};

// The caller's template, or an error if it is missing or someone else's.
export const ownTemplate = async (
  ctx: QueryCtx,
  templateId: Id<"templates">
) => {
  const user = await getUser(ctx);
  const template = await ctx.db.get(templateId);
  if (!template || !user || template.ownerUserId !== user._id) {
    throw new Error("Unknown template");
  }
  return template;
};

// The room owner's participant. Template-seeded blocks are attributed to it.
export const ownerParticipantId = async (
  ctx: QueryCtx,
  roomId: Id<"rooms">
) => {
  const members = await ctx.db
    .query("roomMembers")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const owner = members.find((m) => m.role === "owner");
  if (!owner) {
    throw new Error("Room has no owner");
  }
  return owner.participantId;
};

// Creates the room's document from template sections, as one template
// seeding change set: each heading, followed by its guidance as a paragraph.
export const seedDocument = async (
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  sections: TemplateSection[],
  templateId?: Id<"templates">
) => {
  const robert = await ownerParticipantId(ctx, roomId);
  const documentId = await ctx.db.insert("documents", {
    rev: 0,
    revisionsSinceCheckpoint: 0,
    roomId,
    seededAt: Date.now(),
    templateId,
  });
  const changeSetId = await openChangeSet(ctx, documentId, {
    actorParticipantId: robert,
    kind: "template_seed",
  });
  const blocks = sections.flatMap(({ heading, guidance }) => [
    { kind: "heading" as const, text: heading },
    ...(guidance !== undefined && guidance !== ""
      ? [{ fromTemplate: true, kind: "paragraph" as const, text: guidance }]
      : []),
  ]);
  const orders = generateNKeysBetween(null, null, blocks.length);
  for (const [i, block] of blocks.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
    await insertBlock(ctx, changeSetId, {
      ...block,
      author: { kind: "participant", participantId: robert },
      order: required(orders[i], "order"),
    });
  }
  return documentId;
};

// Seeds the default template for a room that has no document yet.
export const ensureDocument = async (ctx: MutationCtx, roomId: Id<"rooms">) => {
  const existing = await getDocument(ctx, roomId);
  if (existing) {
    return existing._id;
  }
  return await seedDocument(ctx, roomId, DEFAULT_TEMPLATE);
};
