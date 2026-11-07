import { generateNKeysBetween } from "fractional-indexing";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { matchQuote, selectorAt } from "./anchor";
import type { Selector } from "./anchor";
import {
  deleteBlock,
  insertBlock,
  liveBlocks,
  openChangeSet,
  patchBlock,
  scribeWorking,
  takeCheckpoint,
} from "./document";
import { required } from "./required";

// A scribe run rewrites the document as one draft. The scribe's turn records
// small operations, one row each; nothing touches the document until the
// turn finishes, when the whole draft is applied in one mutation as one
// change set. Every other way a run ends releases it: the draft is
// discarded, the lock cleared, and the document stays as it was.

// Longer than the runner's 30-minute turn deadline, so a live turn always
// ends before its lock does.
export const SCRIBE_LOCK_MS = 35 * 60_000;
// Enough to rewrite a full document twice over, and few enough that the
// commit stays well inside one mutation's limits.
export const DRAFT_OP_LIMIT = 1200;

export const SCRIBE_OUT_OF_TIME = "The scribe run ran out of time";

export type DraftOp = Omit<
  Doc<"scribeDraftOps">,
  "_id" | "_creationTime" | "scribeRunId"
>;

// A block added by the draft is named by the seq of its add op.
export const draftId = (seq: number) => `new-${seq}`;

export const parseDraftId = (raw: string) => {
  const digits = /^new-(?<seq>\d+)$/u.exec(raw)?.groups?.seq;
  return digits === undefined ? undefined : Number(digits);
};

export interface DraftItem {
  // The block's id, or the draft id of a block the draft adds.
  key: string;
  original?: Doc<"blocks">;
  kind: Doc<"blocks">["kind"];
  text: string;
  // Set once the scribe writes the block: the blocks it draws from.
  sources?: Id<"blocks">[];
  removed: boolean;
  mentioned: boolean;
}

export interface DraftPlan {
  items: Map<string, DraftItem>;
  // Every item's key in draft order, removed ones included.
  order: string[];
}

const targetKey = (op: DraftOp) =>
  op.blockId ??
  (op.targetSeq === undefined ? undefined : draftId(op.targetSeq));
const afterKey = (op: DraftOp) =>
  op.afterBlockId ??
  (op.afterSeq === undefined ? undefined : draftId(op.afterSeq));

// The document as the draft leaves it: the live blocks, with every op
// replayed in order. A later op on a block supersedes an earlier one; a
// block no op mentions stays exactly as it is.
export const buildDraft = (
  blocks: Doc<"blocks">[],
  ops: DraftOp[]
): DraftPlan => {
  const items = new Map<string, DraftItem>();
  const order: string[] = [];
  for (const b of blocks) {
    items.set(b._id, {
      key: b._id,
      kind: b.kind,
      mentioned: false,
      original: b,
      removed: false,
      text: b.text,
    });
    order.push(b._id);
  }
  const place = (key: string, op: DraftOp) => {
    const after = afterKey(op);
    const afterAt = after === undefined ? -1 : order.indexOf(after);
    let at = afterAt < 0 ? order.length : afterAt + 1;
    if (op.atStart === true) {
      at = 0;
    }
    order.splice(at, 0, key);
  };
  for (const op of ops) {
    if (op.op === "add") {
      const key = draftId(op.seq);
      items.set(key, {
        key,
        kind: required(op.kind, "kind"),
        mentioned: true,
        removed: false,
        sources: op.sourceBlockIds ?? [],
        text: required(op.text, "text"),
      });
      place(key, op);
      continue;
    }
    const key = targetKey(op);
    const item = key === undefined ? undefined : items.get(key);
    if (!item) {
      continue;
    }
    item.mentioned = true;
    if (op.op === "keep") {
      const original = required(item.original, "block");
      Object.assign(item, {
        kind: original.kind,
        removed: false,
        sources: undefined,
        text: original.text,
      });
    } else if (op.op === "replace") {
      const own = item.original ? [item.original._id] : [];
      const sources =
        op.sourceBlockIds ?? (item.original ? [] : (item.sources ?? []));
      Object.assign(item, {
        kind: op.kind ?? item.kind,
        removed: false,
        sources: [...new Set([...own, ...sources])],
        text: required(op.text, "text"),
      });
    } else if (op.op === "remove") {
      item.removed = true;
    } else if (op.op === "move") {
      order.splice(order.indexOf(item.key), 1);
      place(item.key, op);
    }
  }
  return { items, order };
};

export const finalItems = (plan: DraftPlan) =>
  plan.order
    .map((k) => required(plan.items.get(k), "draft item"))
    .filter((i) => !i.removed);

// Indices of a longest strictly increasing subsequence.
const longestIncreasing = (values: string[]) => {
  const tails: number[] = [];
  const previous: number[] = [];
  for (const [i, value] of values.entries()) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((values[tails[mid] ?? 0] ?? "") < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    previous[i] = lo > 0 ? (tails[lo - 1] ?? -1) : -1;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i] ?? -1) {
    out.push(i);
  }
  return out.toReversed();
};

// New order keys for the blocks whose place changes. The longest run of
// existing blocks still in their old relative order keeps its keys; every
// other block gets a key between its neighbours in that run.
export const newOrders = (plan: DraftPlan) => {
  const final = finalItems(plan);
  const existing = final
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => item.original);
  const anchored = new Set(
    longestIncreasing(
      existing.map(({ item }) => required(item.original, "block").order)
    ).flatMap((i) => existing[i]?.index ?? [])
  );
  const orders = new Map<string, string>();
  let i = 0;
  while (i < final.length) {
    if (anchored.has(i)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < final.length && !anchored.has(j)) {
      j += 1;
    }
    const before = final[i - 1]?.original?.order ?? null;
    const after = final[j]?.original?.order ?? null;
    const keys = generateNKeysBetween(before, after, j - i);
    for (const [offset, item] of final.slice(i, j).entries()) {
      orders.set(item.key, required(keys[offset], "order key"));
    }
    i = j;
  }
  return orders;
};

export type ThreadOutcome =
  | "unchanged"
  | { key: string; selector: Selector }
  | null;

// Where an attached thread ends up. A thread whose block the draft leaves
// alone stays put. Otherwise its passage is looked for in the block's new
// text, then in each block that lists its block as a source, in document
// order. Null means the passage is gone and the thread detaches.
export const resolveThread = (
  thread: Doc<"threads">,
  plan: DraftPlan
): ThreadOutcome => {
  const item = plan.items.get(thread.blockId);
  if (!item || (!item.removed && item.sources === undefined)) {
    return "unchanged";
  }
  const successors = finalItems(plan).filter(
    (i) => i !== item && i.sources?.includes(thread.blockId) === true
  );
  for (const candidate of item.removed ? successors : [item, ...successors]) {
    const match = matchQuote(candidate.text, thread);
    if (match) {
      return {
        key: candidate.key,
        selector: selectorAt(candidate.text, match.start, match.end),
      };
    }
  }
  return null;
};

export const draftOps = async (ctx: QueryCtx, scribeRunId: Id<"scribeRuns">) =>
  await ctx.db
    .query("scribeDraftOps")
    .withIndex("by_run_seq", (q) => q.eq("scribeRunId", scribeRunId))
    .collect();

const attachedOpenThreads = async (
  ctx: QueryCtx,
  documentId: Id<"documents">
) => {
  const open = await ctx.db
    .query("threads")
    .withIndex("by_document_state", (q) =>
      q.eq("documentId", documentId).eq("state", "open")
    )
    .collect();
  return open.filter((t) => t.detachedBeforeChangeSetId === undefined);
};

const PREVIEW_IDS = 40;

// What the draft would do if the run ended now, for the scribe to check
// after every operation.
export const draftReport = async (
  ctx: QueryCtx,
  document: Doc<"documents">,
  plan: DraftPlan,
  opCount: number
) => {
  const items = [...plan.items.values()];
  const existing = items.filter((i) => i.original);
  const untouched = existing.filter((i) => !i.mentioned).map((i) => i.key);
  const drawnOn = new Set(finalItems(plan).flatMap((i) => i.sources ?? []));
  const moved = newOrders(plan);
  const threads = {
    detaching: [] as { threadId: string; passage: string; blockId: string }[],
    moving: [] as { threadId: string; passage: string; toBlockId: string }[],
  };
  for (const thread of await attachedOpenThreads(ctx, document._id)) {
    const outcome = resolveThread(thread, plan);
    if (outcome === "unchanged") {
      continue;
    }
    if (outcome === null) {
      threads.detaching.push({
        blockId: thread.blockId,
        passage: thread.exact,
        threadId: thread._id,
      });
    } else if (outcome.key !== thread.blockId) {
      threads.moving.push({
        passage: thread.exact,
        threadId: thread._id,
        toBlockId: outcome.key,
      });
    }
  }
  return {
    added: items.filter((i) => !i.original && !i.removed).length,
    blocks: existing.length,
    finalBlocks: finalItems(plan).length,
    moved: existing.filter((i) => !i.removed && moved.has(i.key)).length,
    operations: opCount,
    removed: existing.filter((i) => i.removed).length,
    removedUndrawn: existing
      .filter(
        (i) => i.removed && !drawnOn.has(required(i.original, "block")._id)
      )
      .map((i) => i.key),
    replaced: existing.filter((i) => !i.removed && i.sources !== undefined)
      .length,
    threads,
    untouched: {
      count: untouched.length,
      ids: untouched.slice(0, PREVIEW_IDS),
    },
  };
};

// Ends a running scribe run: discards its draft, clears the document's lock
// and records how it ended. Every way a run ends comes through here.
export const releaseScribe = async (
  ctx: MutationCtx,
  scribeRunId: Id<"scribeRuns">,
  status: "committed" | "released",
  releaseReason?: string
) => {
  const run = await ctx.db.get(scribeRunId);
  if (!run || run.status !== "running") {
    return;
  }
  const ops = await draftOps(ctx, scribeRunId);
  await Promise.all(
    ops.map(async (op) => {
      await ctx.db.delete(op._id);
    })
  );
  const document = await ctx.db.get(run.documentId);
  if (document?.scribeRunId === scribeRunId) {
    await ctx.db.patch(document._id, {
      scribeLockExpiresAt: undefined,
      scribeRunId: undefined,
    });
  }
  await ctx.db.patch(scribeRunId, {
    endedAt: Date.now(),
    status,
    ...(status === "released" &&
    releaseReason !== undefined &&
    releaseReason !== ""
      ? { releaseReason }
      : {}),
  });
};

// Writes the draft into the document as the scribe's change set: new and
// rewritten blocks credit the authors they drew on, never the model. Returns
// the id each draft item ended up with.
const applyPlan = async (
  ctx: MutationCtx,
  {
    blocks,
    changeSetId,
    orders,
    plan,
    scribeParticipantId,
  }: {
    blocks: Doc<"blocks">[];
    changeSetId: Id<"changeSets">;
    orders: Map<string, string>;
    plan: DraftPlan;
    scribeParticipantId: Id<"participants">;
  }
) => {
  const byId = new Map(blocks.map((b) => [b._id as string, b]));
  const author = (sources: Id<"blocks">[]) => {
    const credits = sources.flatMap((id) => {
      const a = byId.get(id)?.author;
      if (!a) {
        return [];
      }
      return a.kind === "participant" ? [a.participantId] : a.credits;
    });
    return {
      credits: [...new Set(credits)],
      kind: "scribe" as const,
      participantId: scribeParticipantId,
    };
  };
  const ids = new Map<string, Id<"blocks">>(blocks.map((b) => [b._id, b._id]));
  // Each write bumps the document's revision, so they run one after another.
  for (const item of finalItems(plan)) {
    const order = orders.get(item.key) ?? item.original?.order;
    if (!item.original) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
      const blockId = await insertBlock(ctx, changeSetId, {
        author: author(item.sources ?? []),
        kind: item.kind,
        order: required(order, "order"),
        sourceBlockIds: item.sources,
        text: item.text,
      });
      ids.set(item.key, blockId);
    } else if (item.sources || orders.has(item.key)) {
      const written = item.sources
        ? {
            author: author(item.sources),
            humanEditedAt: undefined,
            kind: item.kind,
            sourceBlockIds: item.sources,
            text: item.text,
          }
        : {};
      const moved = orders.has(item.key) ? { order } : {};
      // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
      await patchBlock(ctx, changeSetId, item.original._id, {
        ...written,
        ...moved,
      });
    }
  }
  const removed = [...plan.items.values()].filter(
    (i) => i.original !== undefined && i.removed
  );
  for (const item of removed) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
    await deleteBlock(ctx, changeSetId, required(item.original, "block")._id);
  }
  return ids;
};

// The scribe's turn finished. If its run still holds the document, the whole
// draft is applied as one change set by the scribe, open threads follow
// their passages, and the result is checkpointed. A run already released
// changes nothing.
export const commitScribe = async (ctx: MutationCtx, turn: Doc<"turns">) => {
  const run = turn.scribeRunId ? await ctx.db.get(turn.scribeRunId) : null;
  if (!run || run.status !== "running" || run.turnId !== turn._id) {
    return;
  }
  const document = required(await ctx.db.get(run.documentId), "document");
  if (
    document.scribeRunId !== run._id ||
    !scribeWorking(document, Date.now())
  ) {
    await releaseScribe(ctx, run._id, "released", SCRIBE_OUT_OF_TIME);
    return;
  }
  const blocks = await liveBlocks(ctx, document._id);
  const plan = buildDraft(blocks, await draftOps(ctx, run._id));
  const orders = newOrders(plan);
  const existing = [...plan.items.values()].filter((i) => i.original);
  const changes =
    existing.some(
      (i) => i.removed || i.sources !== undefined || orders.has(i.key)
    ) || finalItems(plan).some((i) => !i.original);
  if (!changes) {
    await releaseScribe(ctx, run._id, "committed");
    return;
  }

  const threads = await attachedOpenThreads(ctx, document._id);
  const changeSetId = await openChangeSet(ctx, document._id, {
    actorParticipantId: run.participantId,
    kind: "scribe_run",
    scribeRunId: run._id,
    turnId: turn._id,
  });
  const ids = await applyPlan(ctx, {
    blocks,
    changeSetId,
    orders,
    plan,
    scribeParticipantId: run.participantId,
  });

  // Threads open when the turn ended, including any started during the run.
  const outcomes = threads.map((thread) => ({
    outcome: resolveThread(thread, plan),
    thread,
  }));
  await Promise.all(
    outcomes.map(async ({ outcome, thread }) => {
      if (outcome === "unchanged") {
        return;
      }
      const blockId = outcome ? ids.get(outcome.key) : undefined;
      await ctx.db.patch(
        thread._id,
        outcome && blockId
          ? {
              blockId,
              ...outcome.selector,
              detachedBeforeChangeSetId: undefined,
            }
          : { detachedBeforeChangeSetId: changeSetId }
      );
    })
  );
  await takeCheckpoint(ctx, document._id, "after_scribe");
  await releaseScribe(ctx, run._id, "committed");
};
