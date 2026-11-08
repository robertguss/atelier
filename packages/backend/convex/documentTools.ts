import { numberedPositions } from "@atelier/shared";
import type { BlockKind } from "@atelier/shared";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireRunnerSecret } from "./lib/auth";
import {
  BLOCK_CHARS,
  DOCUMENT_BLOCKS,
  SCRIBE_WORKING,
  blockTextProblem,
  deleteBlock,
  getDocument,
  insertBlock,
  leaseHolder,
  liveBlocks,
  openChangeSet,
  orderBetween,
  participantName,
  patchBlock,
  scribeWorking,
  sectionEnd,
} from "./lib/document";
import {
  authorLabel,
  isOwnBlock,
  participantNames,
} from "./lib/documentDigest";
import { agentDecisions, decisionLine } from "./lib/prompt";
import { required } from "./lib/required";
import {
  DRAFT_OP_LIMIT,
  buildDraft,
  draftId,
  draftOps,
  draftReport,
  finalItems,
  parseDraftId,
} from "./lib/scribe";
import type { DraftOp, DraftPlan } from "./lib/scribe";
import { createThread, postComment } from "./lib/threads";
import { canWriteDocument, documentMode } from "./lib/visibility";
import { blockKind } from "./schema";

// The room tools a model turn calls through the runner: the room document,
// and the handbook and recent decisions. Each takes
// the runner secret and the turn, and Convex applies every rule itself: the
// author is the turn's participant, never an argument; the turn must be
// running under its claimed command; reviews never see the document and
// follow-ups only read it; a scribe turn changes it only through its draft.
// A refused call returns a reason and a message the
// model can act on, rather than throwing. Model writes never take a lease:
// each is a compare-and-set against the block's rev that refuses while a
// person holds the block. Nothing here reads team chat.

export const MODEL_LIMITS = {
  blockChars: BLOCK_CHARS,
  blockWritesPerTurn: 20,
  commentsPerTurn: 10,
  documentBlocks: DOCUMENT_BLOCKS,
};

type Reason =
  | "turn_ended"
  | "no_document_access"
  | "read_only"
  | "not_found"
  | "not_your_block"
  | "being_edited"
  | "scribe_working"
  | "stale"
  | "human_edited"
  | "cap_reached"
  | "too_long"
  | "empty"
  | "document_full"
  | "quote_not_found"
  | "quote_ambiguous"
  | "not_scribe"
  | "draft_full"
  | "bad_request";

export interface Refusal {
  ok: false;
  reason: Reason;
  message: string;
  current?: { text: string; rev: number; changedBy: string; checked?: boolean };
}

const refuse = (
  reason: Reason,
  message: string,
  current?: Refusal["current"]
): Refusal => ({ message, ok: false, reason, ...(current ? { current } : {}) });

const NOT_FOUND =
  "There is no such block in this room's document; it may have been removed. Call read_document for the current ids.";

interface Loaded {
  ok: true;
  turn: Doc<"turns">;
  document: Doc<"documents">;
}

// The turn behind a tool call, if it is running under its claimed run_turn
// command and may use the document as `need` asks.
const loadTurn = async (
  ctx: QueryCtx,
  secret: string,
  turnId: Id<"turns">,
  need: "read" | "write"
): Promise<Loaded | Refusal> => {
  requireRunnerSecret(secret);
  const turn = await ctx.db.get(turnId);
  const command = turn
    ? await ctx.db
        .query("commands")
        .withIndex("by_turn", (q) => q.eq("turnId", turnId))
        .filter((q) => q.eq(q.field("type"), "run_turn"))
        .first()
    : null;
  if (!turn || turn.status !== "running" || command?.status !== "claimed") {
    return refuse(
      "turn_ended",
      "This turn is no longer running, so its document tools no longer work."
    );
  }
  if (documentMode(turn) === "none") {
    return refuse(
      "no_document_access",
      "An independent review works without the room document."
    );
  }
  if (need === "write" && !canWriteDocument(turn)) {
    return documentMode(turn) === "scribe"
      ? refuse(
          "read_only",
          "As the scribe, you change the room document only through your draft tools, and the draft is applied when your turn ends."
        )
      : refuse(
          "read_only",
          "This turn follows up an independent review: it can read the room document but not change it."
        );
  }
  const document = await getDocument(ctx, turn.roomId);
  if (!document) {
    return refuse("not_found", "This room has no document yet.");
  }
  return { document, ok: true, turn };
};

// As loadTurn, for a block write: also refuses while the scribe works and
// once the turn has used its block writes.
const loadForWrite = async (
  ctx: MutationCtx,
  secret: string,
  turnId: Id<"turns">
) => {
  const loaded = await loadTurn(ctx, secret, turnId, "write");
  if (!loaded.ok) {
    return loaded;
  }
  if (scribeWorking(loaded.document, Date.now())) {
    return refuse(
      "scribe_working",
      `${SCRIBE_WORKING}. Try again after it finishes.`
    );
  }
  const changeSet = await ctx.db
    .query("changeSets")
    .withIndex("by_turn", (q) => q.eq("turnId", turnId))
    .first();
  if ((changeSet?.revisionCount ?? 0) >= MODEL_LIMITS.blockWritesPerTurn) {
    return refuse(
      "cap_reached",
      `Turn cap reached: at most ${MODEL_LIMITS.blockWritesPerTurn} block writes per turn.`
    );
  }
  return loaded;
};

const ONLY_TODO = "Only a to-do can be checked.";

// A divider has no text; every other block needs some.
const checkText = (kind: BlockKind, text: string) => {
  if (kind === "divider") {
    return text === ""
      ? null
      : refuse("bad_request", "A divider has no text: send an empty string.");
  }
  if (!text.trim()) {
    return refuse(
      "empty",
      "A block needs some text. To remove a block, delete it."
    );
  }
  const problem = blockTextProblem(text);
  return problem === null ? null : refuse("too_long", problem);
};

// A live block of the turn's room, from an id the model passed.
const roomBlock = async (ctx: QueryCtx, turn: Doc<"turns">, rawId: string) => {
  const blockId = ctx.db.normalizeId("blocks", rawId);
  const block = blockId ? await ctx.db.get(blockId) : null;
  return block && block.roomId === turn.roomId && block.deletedAt === undefined
    ? block
    : null;
};

// A block the turn's participant wrote and nobody is editing.
const ownBlock = async (
  ctx: QueryCtx,
  turn: Doc<"turns">,
  rawId: string
): Promise<{ ok: true; block: Doc<"blocks"> } | Refusal> => {
  const block = await roomBlock(ctx, turn, rawId);
  if (!block) {
    return refuse("not_found", NOT_FOUND);
  }
  if (!isOwnBlock(block, turn.participantId)) {
    const author = authorLabel(
      block.author,
      await participantNames(ctx, turn.roomId)
    );
    return refuse(
      "not_your_block",
      `This block is by ${author}, not you. You can only change blocks you wrote: comment on it instead.`
    );
  }
  const holder = leaseHolder(block, Date.now());
  if (holder) {
    return refuse(
      "being_edited",
      `${await participantName(ctx, holder)} is editing this block. Try again later, or comment on it.`
    );
  }
  return { block, ok: true };
};

// The block changed since the model read it: its current text and tick, and
// who made the latest change.
const stale = async (ctx: QueryCtx, block: Doc<"blocks">) => {
  const latest = await ctx.db
    .query("blockRevisions")
    .withIndex("by_block", (q) => q.eq("blockId", block._id))
    .order("desc")
    .first();
  const changeSet = latest ? await ctx.db.get(latest.changeSetId) : null;
  let changedBy = "Someone";
  if (changeSet?.kind === "scribe_run") {
    changedBy = "the scribe";
  } else if (changeSet?.actorParticipantId) {
    changedBy = await participantName(ctx, changeSet.actorParticipantId);
  }
  return refuse(
    "stale",
    `${changedBy} changed this block after the version you sent (it is now rev ${block.rev}). Here is its current text: build on it rather than undo their change.`,
    {
      changedBy,
      rev: block.rev,
      text: block.text,
      ...(block.kind === "todo" ? { checked: block.checked === true } : {}),
    }
  );
};

const turnChangeSet = async (ctx: MutationCtx, { turn, document }: Loaded) =>
  await openChangeSet(ctx, document._id, {
    actorParticipantId: turn.participantId,
    kind: "model_turn",
    turnId: turn._id,
  });

export const readDocumentForTurn = query({
  args: { secret: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { secret, turnId }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "read");
    if (!loaded.ok) {
      return loaded;
    }
    const { turn, document } = loaded;
    const names = await participantNames(ctx, turn.roomId);
    const blocks = await liveBlocks(ctx, document._id);
    const byState = await Promise.all(
      (["open", "settled"] as const).map(async (state) => {
        const rows = await ctx.db
          .query("threads")
          .withIndex("by_document_state", (q) =>
            q.eq("documentId", document._id).eq("state", state)
          )
          .collect();
        return await Promise.all(
          rows.map(async (thread) => {
            const comments = await ctx.db
              .query("comments")
              .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
              .collect();
            return {
              blockId: thread.blockId,
              comments: comments.length,
              detached: thread.detachedBeforeChangeSetId !== undefined,
              id: thread._id,
              passage: thread.exact,
              state: thread.state,
            };
          })
        );
      })
    );
    const threads = byState.flat();
    const numbers = numberedPositions(blocks.map((b) => b.kind));
    const now = Date.now();
    return {
      blocks: blocks.map((b, i) => {
        const holder = leaseHolder(b, now);
        return {
          author: authorLabel(b.author, names),
          checked: b.checked,
          editingBy: holder ? (names.get(holder) ?? "Someone") : undefined,
          humanEdited: b.humanEditedAt !== undefined,
          id: b._id,
          kind: b.kind,
          number: numbers[i],
          rev: b.rev,
          text: b.text,
          yours: isOwnBlock(b, turn.participantId),
        };
      }),
      ok: true as const,
      rev: document.rev,
      scribe: documentMode(turn) === "scribe",
      threads,
      writable: canWriteDocument(turn),
    };
  },
});

export const readThreadForTurn = query({
  args: { secret: v.string(), threadId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { secret, turnId, threadId }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "read");
    if (!loaded.ok) {
      return loaded;
    }
    const id = ctx.db.normalizeId("threads", threadId);
    const thread = id ? await ctx.db.get(id) : null;
    if (!thread || thread.roomId !== loaded.turn.roomId) {
      return refuse(
        "not_found",
        "There is no such thread in this room's document."
      );
    }
    const names = await participantNames(ctx, thread.roomId);
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect();
    return {
      blockId: thread.blockId,
      comments: comments.map((c) => ({
        at: c._creationTime,
        author: names.get(c.authorParticipantId) ?? "Someone",
        body: c.body,
      })),
      detached: thread.detachedBeforeChangeSetId !== undefined,
      id: thread._id,
      ok: true as const,
      passage: thread.exact,
      state: thread.state,
    };
  },
});

// The room's handbook as it is now. The prompt carries the copy from when
// the turn was queued.
export const readHandbookForTurn = query({
  args: { secret: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { secret, turnId }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "read");
    if (!loaded.ok) {
      return loaded;
    }
    const room = required(await ctx.db.get(loaded.turn.roomId), "room");
    return { handbook: room.handbook, ok: true as const };
  },
});

const DECISIONS_DEFAULT = 10;
const DECISIONS_MAX = 50;

// The room's latest decisions, oldest first, in the agent-visible view the
// context block uses: never a rationale or a decision made in a review.
export const recentDecisionsForTurn = query({
  args: {
    limit: v.optional(v.number()),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, limit }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "read");
    if (!loaded.ok) {
      return loaded;
    }
    const count = Math.min(
      DECISIONS_MAX,
      Math.max(1, Math.trunc(limit ?? DECISIONS_DEFAULT))
    );
    const decisions = await agentDecisions(ctx, loaded.turn.roomId, count);
    return { lines: decisions.map(decisionLine), ok: true as const };
  },
});

// Adds a block after another, at the end of a heading's section, or at the
// end of the document when neither is given.
export const addBlockForTurn = mutation({
  args: {
    afterBlockId: v.optional(v.string()),
    checked: v.optional(v.boolean()),
    endOfSectionId: v.optional(v.string()),
    kind: blockKind,
    secret: v.string(),
    text: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (
    ctx,
    { secret, turnId, afterBlockId, endOfSectionId, kind, text, checked }
  ) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) {
      return loaded;
    }
    if (afterBlockId !== undefined && endOfSectionId !== undefined) {
      return refuse(
        "bad_request",
        "Give either afterBlockId or endOfSectionId, not both."
      );
    }
    if (checked !== undefined && kind !== "todo") {
      return refuse("bad_request", ONLY_TODO);
    }
    const badText = checkText(kind, text);
    if (badText) {
      return badText;
    }
    const blocks = await liveBlocks(ctx, loaded.document._id);
    if (blocks.length >= MODEL_LIMITS.documentBlocks) {
      return refuse(
        "document_full",
        `The document holds at most ${MODEL_LIMITS.documentBlocks} blocks. Update one of your blocks instead.`
      );
    }
    const anchorId = afterBlockId ?? endOfSectionId;
    let index = blocks.length - 1;
    if (anchorId !== undefined) {
      const anchor = await roomBlock(ctx, loaded.turn, anchorId);
      index = anchor ? blocks.findIndex((b) => b._id === anchor._id) : -1;
      if (index < 0) {
        return refuse("not_found", NOT_FOUND);
      }
      if (endOfSectionId !== undefined) {
        index = sectionEnd(blocks, index);
      }
    }
    const order = orderBetween(
      blocks[index]?.order ?? null,
      blocks[index + 1]?.order ?? null
    );
    const changeSetId = await turnChangeSet(ctx, loaded);
    const blockId = await insertBlock(ctx, changeSetId, {
      author: { kind: "participant", participantId: loaded.turn.participantId },
      checked,
      kind,
      order,
      text,
    });
    return {
      blockId,
      ok: true as const,
      rev: required(await ctx.db.get(blockId), "block").rev,
    };
  },
});

// Replaces the text of a block the model wrote, ticks or unticks its to-do,
// or both, if it is still at `baseRev`.
export const updateBlockForTurn = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.string(),
    checked: v.optional(v.boolean()),
    secret: v.string(),
    text: v.optional(v.string()),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, blockId, baseRev, text, checked }) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) {
      return loaded;
    }
    if (text === undefined && checked === undefined) {
      return refuse(
        "bad_request",
        "Send the block's new text, checked, or both."
      );
    }
    const own = await ownBlock(ctx, loaded.turn, blockId);
    if (!own.ok) {
      return own;
    }
    const { block } = own;
    if (checked !== undefined && block.kind !== "todo") {
      return refuse("bad_request", ONLY_TODO);
    }
    const badText = text === undefined ? null : checkText(block.kind, text);
    if (badText) {
      return badText;
    }
    if (block.rev !== baseRev) {
      return await stale(ctx, block);
    }
    if (
      (text === undefined || text === block.text) &&
      (checked === undefined || checked === (block.checked === true))
    ) {
      return { ok: true as const, rev: block.rev };
    }
    await patchBlock(ctx, await turnChangeSet(ctx, loaded), block._id, {
      ...(text === undefined ? {} : { text }),
      ...(checked === undefined ? {} : { checked }),
    });
    return {
      ok: true as const,
      rev: required(await ctx.db.get(block._id), "block").rev,
    };
  },
});

// Deletes a block the model wrote, if it is still at `baseRev` and no person
// has edited it.
export const deleteBlockForTurn = mutation({
  args: {
    baseRev: v.number(),
    blockId: v.string(),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, blockId, baseRev }) => {
    const loaded = await loadForWrite(ctx, secret, turnId);
    if (!loaded.ok) {
      return loaded;
    }
    const own = await ownBlock(ctx, loaded.turn, blockId);
    if (!own.ok) {
      return own;
    }
    const { block } = own;
    if (block.humanEditedAt !== undefined) {
      return refuse(
        "human_edited",
        "A person has edited this block, so you cannot delete it. Comment on it instead if you think it should go."
      );
    }
    if (block.rev !== baseRev) {
      return await stale(ctx, block);
    }
    await deleteBlock(ctx, await turnChangeSet(ctx, loaded), block._id);
    return { ok: true as const };
  },
});

// Starts a comment thread on the passage `quote` of any block. Comments keep
// working while the scribe works. A model's comment summons no one.
export const commentForTurn = mutation({
  args: {
    blockId: v.string(),
    body: v.string(),
    quote: v.string(),
    secret: v.string(),
    turnId: v.id("turns"),
  },
  handler: async (ctx, { secret, turnId, blockId, quote, body }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "write");
    if (!loaded.ok) {
      return loaded;
    }
    const { turn } = loaded;
    const written = await ctx.db
      .query("comments")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .take(MODEL_LIMITS.commentsPerTurn);
    if (written.length >= MODEL_LIMITS.commentsPerTurn) {
      return refuse(
        "cap_reached",
        `Turn cap reached: at most ${MODEL_LIMITS.commentsPerTurn} comments per turn.`
      );
    }
    const text = body.trim();
    if (!text) {
      return refuse("empty", "A comment needs some text.");
    }
    if (text.length > MODEL_LIMITS.blockChars) {
      return refuse(
        "too_long",
        `A comment holds at most ${MODEL_LIMITS.blockChars} characters.`
      );
    }
    const block = await roomBlock(ctx, turn, blockId);
    if (!block) {
      return refuse("not_found", NOT_FOUND);
    }
    const start = quote ? block.text.indexOf(quote) : -1;
    if (start < 0) {
      return refuse(
        "quote_not_found",
        "That passage is not in the block's text. Quote it exactly as it appears in the block."
      );
    }
    if (block.text.includes(quote, start + 1)) {
      return refuse(
        "quote_ambiguous",
        "That passage appears more than once in the block. Quote a longer passage that appears only once."
      );
    }
    const thread = await createThread(ctx, block, start, start + quote.length);
    const author = required(
      await ctx.db.get(turn.participantId),
      "participant"
    );
    const commentId = await postComment(ctx, thread, author, text, turn._id);
    return { commentId, ok: true as const, threadId: thread._id };
  },
});

const draftOp = v.union(
  v.object({ blockId: v.string(), op: v.literal("keep") }),
  v.object({
    blockId: v.string(),
    checked: v.optional(v.boolean()),
    kind: v.optional(blockKind),
    op: v.literal("replace"),
    sourceBlockIds: v.optional(v.array(v.string())),
    text: v.string(),
  }),
  v.object({
    afterBlockId: v.optional(v.string()),
    checked: v.optional(v.boolean()),
    kind: blockKind,
    op: v.literal("add"),
    sourceBlockIds: v.array(v.string()),
    text: v.string(),
  }),
  v.object({ blockId: v.string(), op: v.literal("remove") }),
  v.object({
    afterBlockId: v.optional(v.string()),
    blockId: v.string(),
    op: v.literal("move"),
  })
);

const NOT_IN_DRAFT =
  "There is no such block in the document or your draft. Use an id from read_document, or a draft id (new-N) that draft_add returned.";

interface DraftLookup {
  live: Map<string, Id<"blocks">>;
  plan: DraftPlan;
}

// A block in the document, or one the draft adds, as the op row names it.
const draftTarget = ({ live, plan }: DraftLookup, raw: string) => {
  const added = parseDraftId(raw);
  if (added !== undefined) {
    return plan.items.has(draftId(added)) ? { targetSeq: added } : null;
  }
  const blockId = live.get(raw);
  return blockId ? { blockId } : null;
};

const draftAfter = (lookup: DraftLookup, raw: string | undefined) => {
  if (raw === undefined) {
    return {};
  }
  if (raw === "start") {
    return { atStart: true };
  }
  const found = draftTarget(lookup, raw);
  if (found === null) {
    return null;
  }
  return "blockId" in found
    ? { afterBlockId: found.blockId }
    : { afterSeq: found.targetSeq };
};

const draftSources = ({ live }: DraftLookup, raws: string[]) => {
  const ids = raws.map((raw) => live.get(raw));
  return ids.every((id) => id !== undefined) ? ids : null;
};

const NO_SUCH_SOURCE =
  "Every source must be a block in the document now, by its id from read_document.";

type DraftInput = Infer<typeof draftOp>;

// The row one draft operation adds, or why it was refused. Block ids are
// checked against the document and the draft so far.
const draftRow = (lookup: DraftLookup, op: DraftInput, seq: number) => {
  if (op.op === "add") {
    const badText = checkText(op.kind, op.text);
    if (badText) {
      return badText;
    }
    const place = draftAfter(lookup, op.afterBlockId);
    if (!place) {
      return refuse("not_found", NOT_IN_DRAFT);
    }
    const drawn = draftSources(lookup, op.sourceBlockIds);
    if (!drawn) {
      return refuse("not_found", NO_SUCH_SOURCE);
    }
    const row: DraftOp = {
      kind: op.kind,
      op: "add",
      seq,
      sourceBlockIds: drawn,
      text: op.text,
      ...place,
      checked: op.checked,
    };
    return row;
  }
  const named = draftTarget(lookup, op.blockId);
  if (!named) {
    return refuse("not_found", NOT_IN_DRAFT);
  }
  if (op.op === "keep") {
    if (!("blockId" in named)) {
      return refuse(
        "bad_request",
        "draft_keep is for blocks already in the document; a block you added is kept unless you remove it."
      );
    }
    const row: DraftOp = { op: "keep", seq, ...named };
    return row;
  }
  if (op.op === "replace") {
    const item = required(
      lookup.plan.items.get(
        named.blockId ?? draftId(required(named.targetSeq, "draft id"))
      ),
      "draft item"
    );
    const badText = checkText(op.kind ?? item.kind, op.text);
    if (badText) {
      return badText;
    }
    const drawn =
      op.sourceBlockIds === undefined
        ? undefined
        : draftSources(lookup, op.sourceBlockIds);
    if (drawn === null) {
      return refuse("not_found", NO_SUCH_SOURCE);
    }
    const row: DraftOp = {
      op: "replace",
      seq,
      ...named,
      text: op.text,
      ...(op.kind ? { kind: op.kind } : {}),
      checked: op.checked,
      ...(drawn ? { sourceBlockIds: drawn } : {}),
    };
    return row;
  }
  if (op.op === "remove") {
    const row: DraftOp = { op: "remove", seq, ...named };
    return row;
  }
  if (op.afterBlockId === op.blockId) {
    return refuse("bad_request", "A block cannot go after itself.");
  }
  const place = draftAfter(lookup, op.afterBlockId);
  if (!place) {
    return refuse("not_found", NOT_IN_DRAFT);
  }
  const row: DraftOp = { op: "move", seq, ...named, ...place };
  return row;
};

// Adds one operation to the scribe's draft and reports what the whole draft
// would do. Only the turn acting for the document's running scribe run may
// call it. Block ids are checked here; nothing reaches the document until the
// turn finishes.
export const scribeDraftForTurn = mutation({
  args: { op: draftOp, secret: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { secret, turnId, op }) => {
    const loaded = await loadTurn(ctx, secret, turnId, "read");
    if (!loaded.ok) {
      return loaded;
    }
    const { turn, document } = loaded;
    if (!turn.scribeRunId) {
      return refuse(
        "not_scribe",
        "Only the scribe has draft tools. Change your own blocks with update_block, or comment."
      );
    }
    const run = await ctx.db.get(turn.scribeRunId);
    if (
      !run ||
      run.status !== "running" ||
      run.turnId !== turn._id ||
      document.scribeRunId !== run._id ||
      !scribeWorking(document, Date.now())
    ) {
      return refuse(
        "turn_ended",
        "This scribe run has ended, so its draft can no longer change."
      );
    }
    const ops = await draftOps(ctx, run._id);
    if (ops.length >= DRAFT_OP_LIMIT) {
      return refuse(
        "draft_full",
        `The draft holds at most ${DRAFT_OP_LIMIT} operations. Finish with what you have.`
      );
    }
    const blocks = await liveBlocks(ctx, document._id);
    const live = new Map(blocks.map((b) => [b._id as string, b._id]));
    const plan = buildDraft(blocks, ops);
    const seq = (ops.at(-1)?.seq ?? -1) + 1;

    const lookup = { live, plan };
    const row = draftRow(lookup, op, seq);
    if ("ok" in row) {
      return row;
    }
    const next = buildDraft(blocks, [...ops, row]);
    if (finalItems(next).length > MODEL_LIMITS.documentBlocks) {
      return refuse(
        "document_full",
        `The document holds at most ${MODEL_LIMITS.documentBlocks} blocks. Merge or remove some instead.`
      );
    }
    await ctx.db.insert("scribeDraftOps", { scribeRunId: run._id, ...row });
    return {
      ok: true as const,
      ...(row.op === "add" ? { draftId: draftId(seq) } : {}),
      report: await draftReport(ctx, document, next, ops.length + 1),
    };
  },
});
