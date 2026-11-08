import { DOCUMENT_BLOCKS } from "@atelier/shared";
import { v } from "convex/values";
import { generateNKeysBetween } from "fractional-indexing";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireMember } from "./lib/auth";
import {
  SCRIBE_WORKING,
  clearLease,
  deleteBlock,
  getDocument,
  insertBlock,
  liveBlocks,
  openChangeSet,
  orderBetween,
  patchBlock,
  refuseBadText,
  scribeWorking,
} from "./lib/document";
import {
  grantLease,
  humanEdit,
  loadForChange,
  refuseIfHeldByOther,
  refuseIfStale,
} from "./lib/leases";
import { required } from "./lib/required";
import { attachedThreadsOn, rehomeThreads } from "./lib/threads";
import { blockKind } from "./schema";

// The structural edits people make to the document: split, merge, kind
// change, tick, move and paste. Each is one mutation and one change set,
// based on the rev of every block it touches and returning the new revs, and
// comment threads follow their passages into whichever block now holds them.

const refuseIfFull = (count: number, adding: number) => {
  if (count + adding > DOCUMENT_BLOCKS) {
    throw new Error(
      `This would add ${adding} ${adding === 1 ? "block" : "blocks"} to a document of ${count}, and a document holds at most ${DOCUMENT_BLOCKS} blocks.`
    );
  }
};

// The index of the block that `afterBlockId` names, or -1 for the top.
const indexAfter = (
  blocks: Doc<"blocks">[],
  afterBlockId: Id<"blocks"> | null
) => {
  if (afterBlockId === null) {
    return -1;
  }
  const index = blocks.findIndex((b) => b._id === afterBlockId);
  if (index === -1) {
    throw new Error("That block has been removed");
  }
  return index;
};

// The block a paste lands inside, refused like any other write to it, with
// the threads that may follow its tail into the last pasted block.
const pasteTarget = async (
  ctx: MutationCtx,
  block: Doc<"blocks"> | undefined,
  source: { baseRev: number; headText: string; tailText: string } | undefined,
  participantId: Id<"participants">,
  now: number
) => {
  if (!source) {
    return null;
  }
  if (!block) {
    throw new Error("Choose the block to paste into");
  }
  refuseBadText([source.headText]);
  await refuseIfHeldByOther(ctx, block, participantId, now);
  refuseIfStale(block, source.baseRev);
  return {
    ...source,
    block,
    threads: await attachedThreadsOn(ctx, block._id),
  };
};

const humanChangeSet = async (
  ctx: MutationCtx,
  documentId: Id<"documents">,
  participantId: Id<"participants">
) =>
  await openChangeSet(ctx, documentId, {
    actorParticipantId: participantId,
    kind: "human_edit",
  });

const revOf = async (ctx: MutationCtx, blockId: Id<"blocks">) =>
  required(await ctx.db.get(blockId), "block").rev;

// Enter inside a block: the block keeps `headText` and a new block after it
// holds `tailText`. The person goes on typing in the new block, so they take
// its lease.
export const split = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.id("blocks"),
    headText: v.string(),
    tailChecked: v.optional(v.boolean()),
    tailKind: blockKind,
    tailText: v.string(),
  },
  handler: async (
    ctx,
    { baseRev, blockId, headText, tailChecked, tailKind, tailText }
  ) => {
    const { block, participant, now } = await loadForChange(
      ctx,
      blockId,
      baseRev
    );
    refuseBadText([headText, tailText]);
    const blocks = await liveBlocks(ctx, block.documentId);
    refuseIfFull(blocks.length, 1);
    const next = blocks[blocks.findIndex((b) => b._id === blockId) + 1];
    const threads = await attachedThreadsOn(ctx, blockId);
    const changeSetId = await humanChangeSet(
      ctx,
      block.documentId,
      participant._id
    );
    const rev =
      headText === block.text
        ? block.rev
        : await patchBlock(ctx, changeSetId, blockId, {
            text: headText,
            ...humanEdit(block, participant._id, now),
          });
    // A tail carrying the block's words keeps its author; an empty one is the person's.
    const tailId = await insertBlock(ctx, changeSetId, {
      checked: tailChecked,
      kind: tailKind,
      order: orderBetween(block.order, next?.order ?? null),
      text: tailText,
      ...(tailText === ""
        ? { author: { kind: "participant", participantId: participant._id } }
        : { author: block.author, ...humanEdit(block, participant._id, now) }),
    });
    await rehomeThreads(
      ctx,
      threads,
      [
        { blockId, text: headText },
        { blockId: tailId, shift: -headText.length, text: tailText },
      ],
      changeSetId
    );
    await grantLease(
      ctx,
      { _id: tailId, roomId: block.roomId },
      participant._id,
      now,
      changeSetId
    );
    return { rev, tailId, tailRev: await revOf(ctx, tailId) };
  },
});

// Backspace at the start of a block: its text joins the end of the block
// above, on a new line in code, and the block is removed.
export const merge = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.id("blocks"),
    previousBaseRev: v.number(),
  },
  handler: async (ctx, { baseRev, blockId, previousBaseRev }) => {
    const { block, participant, now } = await loadForChange(
      ctx,
      blockId,
      baseRev
    );
    const blocks = await liveBlocks(ctx, block.documentId);
    const previous = blocks[blocks.findIndex((b) => b._id === blockId) - 1];
    if (!previous) {
      throw new Error("There is no block above to merge into");
    }
    await refuseIfHeldByOther(ctx, previous, participant._id, now);
    refuseIfStale(previous, previousBaseRev);
    const joiner = previous.kind === "code" ? "\n" : "";
    const text = previous.text + joiner + block.text;
    refuseBadText([text]);
    const threads = await attachedThreadsOn(ctx, blockId);
    const changeSetId = await humanChangeSet(
      ctx,
      block.documentId,
      participant._id
    );
    const rev =
      text === previous.text
        ? previous.rev
        : await patchBlock(ctx, changeSetId, previous._id, {
            text,
            ...humanEdit(previous, participant._id, now),
          });
    await deleteBlock(ctx, changeSetId, blockId);
    await clearLease(ctx, blockId);
    await rehomeThreads(
      ctx,
      threads,
      [
        {
          blockId: previous._id,
          shift: previous.text.length + joiner.length,
          text,
        },
      ],
      changeSetId
    );
    return { rev };
  },
});

// Turns the block into another kind, with the text that kind gives it.
export const setKind = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.id("blocks"),
    kind: blockKind,
    text: v.string(),
  },
  handler: async (ctx, { baseRev, blockId, kind, text }) => {
    const { block, participant, now } = await loadForChange(
      ctx,
      blockId,
      baseRev
    );
    refuseBadText([text]);
    const changeSetId = await humanChangeSet(
      ctx,
      block.documentId,
      participant._id
    );
    const rev = await patchBlock(ctx, changeSetId, blockId, {
      // Only a to-do has a tick.
      checked: kind === "todo" ? block.checked : undefined,
      kind,
      text,
      ...humanEdit(block, participant._id, now),
    });
    return { rev };
  },
});

// Ticks or unticks a to-do. It takes no lease, but waits for whoever is
// editing the block.
export const toggleChecked = mutation({
  args: { baseRev: v.number(), blockId: v.id("blocks"), checked: v.boolean() },
  handler: async (ctx, { baseRev, blockId, checked }) => {
    const { block, participant, now } = await loadForChange(
      ctx,
      blockId,
      baseRev
    );
    if (block.kind !== "todo") {
      throw new Error("Only a to-do can be ticked");
    }
    const changeSetId = await humanChangeSet(
      ctx,
      block.documentId,
      participant._id
    );
    const rev = await patchBlock(ctx, changeSetId, blockId, {
      checked,
      ...humanEdit(block, participant._id, now),
    });
    return { rev };
  },
});

// Moves the block to just after another, or to the top when that is null.
export const moveTo = mutation({
  args: {
    afterBlockId: v.union(v.id("blocks"), v.null()),
    baseRev: v.number(),
    blockId: v.id("blocks"),
  },
  handler: async (ctx, { afterBlockId, baseRev, blockId }) => {
    const { block, participant } = await loadForChange(ctx, blockId, baseRev);
    const blocks = await liveBlocks(ctx, block.documentId);
    const others = blocks.filter((b) => b._id !== blockId);
    const index = indexAfter(others, afterBlockId);
    const order = orderBetween(
      others[index]?.order ?? null,
      others[index + 1]?.order ?? null
    );
    const changeSetId = await humanChangeSet(
      ctx,
      block.documentId,
      participant._id
    );
    return { rev: await patchBlock(ctx, changeSetId, blockId, { order }) };
  },
});

// Adds blocks after another, or at the top when that is null, as the
// person's own, and they take the lease on the last one. With `source`, the
// blocks were pasted inside `afterBlockId`: that block keeps `headText` and
// the last pasted block ends with `tailText`. Refused whole when the document
// or any block would pass its limit.
export const insertMany = mutation({
  args: {
    afterBlockId: v.union(v.id("blocks"), v.null()),
    blocks: v.array(
      v.object({
        checked: v.optional(v.boolean()),
        kind: blockKind,
        text: v.string(),
      })
    ),
    roomId: v.id("rooms"),
    source: v.optional(
      v.object({
        baseRev: v.number(),
        headText: v.string(),
        tailText: v.string(),
      })
    ),
  },
  handler: async (ctx, { afterBlockId, blocks, roomId, source }) => {
    const { participant } = await requireMember(ctx, roomId);
    const document = await getDocument(ctx, roomId);
    if (!document) {
      throw new Error("This room has no document yet");
    }
    const now = Date.now();
    if (scribeWorking(document, now)) {
      throw new Error(SCRIBE_WORKING);
    }
    if (blocks.length === 0) {
      throw new Error("There is nothing to add");
    }
    const live = await liveBlocks(ctx, document._id);
    refuseIfFull(live.length, blocks.length);
    const index = indexAfter(live, afterBlockId);
    const anchor = live[index];
    const into = await pasteTarget(ctx, anchor, source, participant._id, now);
    const rows = blocks.map((row, i) =>
      into && i === blocks.length - 1
        ? { ...row, text: row.text + into.tailText }
        : row
    );
    refuseBadText(rows.map((row) => row.text));
    const changeSetId = await humanChangeSet(
      ctx,
      document._id,
      participant._id
    );
    let rev = into?.block.rev;
    if (into && into.headText !== into.block.text) {
      rev = await patchBlock(ctx, changeSetId, into.block._id, {
        text: into.headText,
        ...humanEdit(into.block, participant._id, now),
      });
    }
    const orders = generateNKeysBetween(
      anchor?.order ?? null,
      live[index + 1]?.order ?? null,
      rows.length
    );
    const inserted: { blockId: Id<"blocks">; rev: number }[] = [];
    for (const [i, row] of rows.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
      const blockId = await insertBlock(ctx, changeSetId, {
        ...row,
        author: { kind: "participant", participantId: participant._id },
        order: required(orders[i], "order"),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- the rev of the row just written
      inserted.push({ blockId, rev: await revOf(ctx, blockId) });
    }
    const last = required(inserted.at(-1), "inserted block");
    if (into) {
      const pasted = required(blocks.at(-1), "pasted block");
      await rehomeThreads(
        ctx,
        into.threads,
        [
          { blockId: into.block._id, text: into.headText },
          {
            blockId: last.blockId,
            shift: pasted.text.length - into.headText.length,
            text: required(rows.at(-1), "row").text,
          },
        ],
        changeSetId
      );
    }
    await grantLease(
      ctx,
      { _id: last.blockId, roomId },
      participant._id,
      now,
      changeSetId
    );
    return { blocks: inserted, rev };
  },
});
