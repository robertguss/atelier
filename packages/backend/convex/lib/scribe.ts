import { generateNKeysBetween } from 'fractional-indexing';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { matchQuote, selectorAt, type Selector } from './anchor';
import { deleteBlock, insertBlock, liveBlocks, openChangeSet, patchBlock, scribeWorking, takeCheckpoint } from './document';

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
export const DRAFT_OP_LIMIT = 1_200;

export const SCRIBE_OUT_OF_TIME = 'The scribe run ran out of time';

export type DraftOp = Omit<Doc<'scribeDraftOps'>, '_id' | '_creationTime' | 'scribeRunId'>;

// A block added by the draft is named by the seq of its add op.
export const draftId = (seq: number) => `new-${seq}`;

export function parseDraftId(raw: string) {
  const m = /^new-(\d+)$/.exec(raw);
  return m ? Number(m[1]) : undefined;
}

export type DraftItem = {
  // The block's id, or the draft id of a block the draft adds.
  key: string;
  original?: Doc<'blocks'>;
  kind: Doc<'blocks'>['kind'];
  text: string;
  // Set once the scribe writes the block: the blocks it draws from.
  sources?: Id<'blocks'>[];
  removed: boolean;
  mentioned: boolean;
};

export type DraftPlan = {
  items: Map<string, DraftItem>;
  // Every item's key in draft order, removed ones included.
  order: string[];
};

const targetKey = (op: DraftOp) => op.blockId ?? (op.targetSeq !== undefined ? draftId(op.targetSeq) : undefined);
const afterKey = (op: DraftOp) => op.afterBlockId ?? (op.afterSeq !== undefined ? draftId(op.afterSeq) : undefined);

// The document as the draft leaves it: the live blocks, with every op
// replayed in order. A later op on a block supersedes an earlier one; a
// block no op mentions stays exactly as it is.
export function buildDraft(blocks: Doc<'blocks'>[], ops: DraftOp[]): DraftPlan {
  const items = new Map<string, DraftItem>();
  const order: string[] = [];
  for (const b of blocks) {
    items.set(b._id, { key: b._id, original: b, kind: b.kind, text: b.text, removed: false, mentioned: false });
    order.push(b._id);
  }
  const place = (key: string, op: DraftOp) => {
    const after = afterKey(op);
    const at = op.atStart ? 0 : after !== undefined && order.includes(after) ? order.indexOf(after) + 1 : order.length;
    order.splice(at, 0, key);
  };
  for (const op of ops) {
    if (op.op === 'add') {
      const key = draftId(op.seq);
      items.set(key, { key, kind: op.kind!, text: op.text!, sources: op.sourceBlockIds ?? [], removed: false, mentioned: true });
      place(key, op);
      continue;
    }
    const key = targetKey(op);
    const item = key === undefined ? undefined : items.get(key);
    if (!item) continue;
    item.mentioned = true;
    if (op.op === 'keep') {
      Object.assign(item, { kind: item.original!.kind, text: item.original!.text, sources: undefined, removed: false });
    } else if (op.op === 'replace') {
      const own = item.original ? [item.original._id] : [];
      const sources = op.sourceBlockIds ?? (item.original ? [] : (item.sources ?? []));
      Object.assign(item, { kind: op.kind ?? item.kind, text: op.text!, sources: [...new Set([...own, ...sources])], removed: false });
    } else if (op.op === 'remove') {
      item.removed = true;
    } else if (op.op === 'move') {
      order.splice(order.indexOf(item.key), 1);
      place(item.key, op);
    }
  }
  return { items, order };
}

export function finalItems(plan: DraftPlan) {
  return plan.order.map((k) => plan.items.get(k)!).filter((i) => !i.removed);
}

// New order keys for the blocks whose place changes. The longest run of
// existing blocks still in their old relative order keeps its keys; every
// other block gets a key between its neighbours in that run.
export function newOrders(plan: DraftPlan) {
  const final = finalItems(plan);
  const existing = final.map((item, index) => ({ item, index })).filter(({ item }) => item.original);
  const anchored = new Set(longestIncreasing(existing.map(({ item }) => item.original!.order)).map((i) => existing[i]!.index));
  const orders = new Map<string, string>();
  let i = 0;
  while (i < final.length) {
    if (anchored.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < final.length && !anchored.has(j)) j++;
    const before = i > 0 ? final[i - 1]!.original!.order : null;
    const after = j < final.length ? final[j]!.original!.order : null;
    const keys = generateNKeysBetween(before, after, j - i);
    for (let k = i; k < j; k++) orders.set(final[k]!.key, keys[k - i]!);
    i = j;
  }
  return orders;
}

// Indices of a longest strictly increasing subsequence.
function longestIncreasing(values: string[]) {
  const tails: number[] = [];
  const previous: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) out.push(i);
  return out.reverse();
}

export type ThreadOutcome = 'unchanged' | { key: string; selector: Selector } | null;

// Where an attached thread ends up. A thread whose block the draft leaves
// alone stays put. Otherwise its passage is looked for in the block's new
// text, then in each block that lists its block as a source, in document
// order. Null means the passage is gone and the thread detaches.
export function resolveThread(thread: Doc<'threads'>, plan: DraftPlan): ThreadOutcome {
  const item = plan.items.get(thread.blockId);
  if (!item || (!item.removed && item.sources === undefined)) return 'unchanged';
  const successors = finalItems(plan).filter((i) => i !== item && i.sources?.includes(thread.blockId));
  for (const candidate of item.removed ? successors : [item, ...successors]) {
    const match = matchQuote(candidate.text, thread);
    if (match) return { key: candidate.key, selector: selectorAt(candidate.text, match.start, match.end) };
  }
  return null;
}

export async function draftOps(ctx: QueryCtx, scribeRunId: Id<'scribeRuns'>) {
  return await ctx.db
    .query('scribeDraftOps')
    .withIndex('by_run_seq', (q) => q.eq('scribeRunId', scribeRunId))
    .collect();
}

async function attachedOpenThreads(ctx: QueryCtx, documentId: Id<'documents'>) {
  const open = await ctx.db
    .query('threads')
    .withIndex('by_document_state', (q) => q.eq('documentId', documentId).eq('state', 'open'))
    .collect();
  return open.filter((t) => t.detachedBeforeChangeSetId === undefined);
}

const PREVIEW_IDS = 40;

// What the draft would do if the run ended now, for the scribe to check
// after every operation.
export async function draftReport(ctx: QueryCtx, document: Doc<'documents'>, plan: DraftPlan, opCount: number) {
  const items = [...plan.items.values()];
  const existing = items.filter((i) => i.original);
  const untouched = existing.filter((i) => !i.mentioned).map((i) => i.key);
  const drawnOn = new Set(finalItems(plan).flatMap((i) => i.sources ?? []));
  const moved = newOrders(plan);
  const threads = { moving: [] as { threadId: string; passage: string; toBlockId: string }[], detaching: [] as { threadId: string; passage: string; blockId: string }[] };
  for (const thread of await attachedOpenThreads(ctx, document._id)) {
    const outcome = resolveThread(thread, plan);
    if (outcome === 'unchanged') continue;
    if (outcome === null) threads.detaching.push({ threadId: thread._id, passage: thread.exact, blockId: thread.blockId });
    else if (outcome.key !== thread.blockId) threads.moving.push({ threadId: thread._id, passage: thread.exact, toBlockId: outcome.key });
  }
  return {
    operations: opCount,
    blocks: existing.length,
    untouched: { count: untouched.length, ids: untouched.slice(0, PREVIEW_IDS) },
    replaced: existing.filter((i) => !i.removed && i.sources !== undefined).length,
    removed: existing.filter((i) => i.removed).length,
    moved: existing.filter((i) => !i.removed && moved.has(i.key)).length,
    added: items.filter((i) => !i.original && !i.removed).length,
    finalBlocks: finalItems(plan).length,
    removedUndrawn: existing.filter((i) => i.removed && !drawnOn.has(i.original!._id)).map((i) => i.key),
    threads,
  };
}

// Ends a running scribe run: discards its draft, clears the document's lock
// and records how it ended. Every way a run ends comes through here.
export async function releaseScribe(
  ctx: MutationCtx,
  scribeRunId: Id<'scribeRuns'>,
  status: 'committed' | 'released',
  releaseReason?: string,
) {
  const run = await ctx.db.get(scribeRunId);
  if (!run || run.status !== 'running') return;
  for (const op of await draftOps(ctx, scribeRunId)) await ctx.db.delete(op._id);
  const document = await ctx.db.get(run.documentId);
  if (document?.scribeRunId === scribeRunId) await ctx.db.patch(document._id, { scribeRunId: undefined, scribeLockExpiresAt: undefined });
  await ctx.db.patch(scribeRunId, { status, endedAt: Date.now(), ...(status === 'released' && releaseReason ? { releaseReason } : {}) });
}

// The scribe's turn finished. If its run still holds the document, the whole
// draft is applied as one change set by the scribe, open threads follow
// their passages, and the result is checkpointed. A run already released
// changes nothing.
export async function commitScribe(ctx: MutationCtx, turn: Doc<'turns'>) {
  const run = turn.scribeRunId ? await ctx.db.get(turn.scribeRunId) : null;
  if (!run || run.status !== 'running' || run.turnId !== turn._id) return;
  const document = (await ctx.db.get(run.documentId))!;
  if (document.scribeRunId !== run._id || !scribeWorking(document, Date.now())) {
    await releaseScribe(ctx, run._id, 'released', SCRIBE_OUT_OF_TIME);
    return;
  }
  const blocks = await liveBlocks(ctx, document._id);
  const plan = buildDraft(blocks, await draftOps(ctx, run._id));
  const orders = newOrders(plan);
  const existing = [...plan.items.values()].filter((i) => i.original);
  const changes = existing.some((i) => i.removed || i.sources !== undefined || orders.has(i.key)) || finalItems(plan).some((i) => !i.original);
  if (!changes) {
    await releaseScribe(ctx, run._id, 'committed');
    return;
  }

  const threads = await attachedOpenThreads(ctx, document._id);
  const byId = new Map(blocks.map((b) => [b._id as string, b]));
  // Credits come from the authors of the blocks drawn on, never from the model.
  const author = (sources: Id<'blocks'>[]) => {
    const credits = sources.flatMap((id) => {
      const a = byId.get(id)?.author;
      return !a ? [] : a.kind === 'participant' ? [a.participantId] : a.credits;
    });
    return { kind: 'scribe' as const, participantId: run.participantId, credits: [...new Set(credits)] };
  };

  const changeSetId = await openChangeSet(ctx, document._id, {
    kind: 'scribe_run',
    actorParticipantId: run.participantId,
    turnId: turn._id,
    scribeRunId: run._id,
  });
  const ids = new Map<string, Id<'blocks'>>(blocks.map((b) => [b._id, b._id]));
  for (const item of finalItems(plan)) {
    const order = orders.get(item.key) ?? item.original?.order;
    if (!item.original) {
      const blockId = await insertBlock(ctx, changeSetId, { order: order!, kind: item.kind, text: item.text, author: author(item.sources!), sourceBlockIds: item.sources });
      ids.set(item.key, blockId);
      continue;
    }
    const written = item.sources
      ? { text: item.text, kind: item.kind, author: author(item.sources), sourceBlockIds: item.sources, humanEditedAt: undefined }
      : {};
    const moved = orders.has(item.key) ? { order } : {};
    if (item.sources || orders.has(item.key)) await patchBlock(ctx, changeSetId, item.original._id, { ...written, ...moved });
  }
  for (const item of existing) if (item.removed) await deleteBlock(ctx, changeSetId, item.original!._id);

  // Threads open when the turn ended, including any started during the run.
  for (const thread of threads) {
    const outcome = resolveThread(thread, plan);
    if (outcome === 'unchanged') continue;
    await ctx.db.patch(
      thread._id,
      outcome ? { blockId: ids.get(outcome.key)!, ...outcome.selector, detachedBeforeChangeSetId: undefined } : { detachedBeforeChangeSetId: changeSetId },
    );
  }
  await takeCheckpoint(ctx, document._id, 'after_scribe');
  await releaseScribe(ctx, run._id, 'committed');
}
