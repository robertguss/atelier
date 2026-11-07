// The room document tools a model uses during a turn. One core serves every
// harness: the loopback MCP endpoint (room-tools-server.ts) for Codex and Pi,
// and an in-process SDK server for Claude. Each tool forwards to a
// runner-secret Convex function that applies every rule itself, so this file
// only validates the shape of the arguments and turns Convex's answer, or its
// refusal, into text the model can act on.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";

export type RoomToolsClient = Pick<ConvexClient, "query" | "mutation">;

/** An MCP tool result. Refusals and bad arguments set `isError`, but still read as plain text. */
export interface RoomToolResult {
  // The SDK's tool result type has an index signature; keeping it lets this one be returned as is.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface Refusal {
  ok: false;
  reason: string;
  message: string;
  current?: { text: string; rev: number; changedBy: string };
}

interface ToolContext {
  convex: RoomToolsClient;
  secret: string;
  turnId: Id<"turns">;
}

interface RoomTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** What the model reads to decide when and how to use the tool. */
  description: string;
  shape: Shape;
  /** Text for the model on success, or Convex's refusal. */
  // oxlint-disable-next-line typescript/method-signature-style -- method syntax keeps parameter bivariance, which lets tools with different argument shapes share one RoomToolSet
  run(
    ctx: ToolContext,
    args: z.infer<z.ZodObject<Shape>>
  ): Promise<string | Refusal>;
}

export type RoomToolSet = readonly RoomTool[];

const defineTool = <Shape extends z.ZodRawShape>(
  t: RoomTool<Shape>
): RoomTool => t;

const blockIdShape = z.string().describe("A block id from read_document.");
const baseRev = z
  .number()
  .int()
  .describe("The rev of the block when you last read it.");

const DOCUMENT_PURPOSE =
  "The room document is the shared, current record of this session that the people in the room and every model keep together: what has happened, findings, ideas, changes of direction and open questions.";

const errorText = (text: string): RoomToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const renderRefusal = (refusal: Refusal) => {
  let text = `Not done (${refusal.reason}): ${refusal.message}`;
  if (refusal.current) {
    text += `\n\nCurrent text, rev ${refusal.current.rev}, last changed by ${refusal.current.changedBy}:\n${refusal.current.text}`;
  }
  return text;
};

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

type DocumentView = Extract<
  FunctionReturnType<typeof api.documentTools.readDocumentForTurn>,
  { ok: true }
>;
type ThreadView = Extract<
  FunctionReturnType<typeof api.documentTools.readThreadForTurn>,
  { ok: true }
>;
type DraftReport = Extract<
  FunctionReturnType<typeof api.documentTools.scribeDraftForTurn>,
  { ok: true }
>["report"];

const access = (doc: DocumentView) => {
  if (doc.scribe) {
    return "You are its scribe: change it only through your draft tools, which apply when your turn ends.";
  }
  return doc.writable
    ? "You can add blocks, change and delete your own, and comment on any block."
    : "This turn can read the document but not change it.";
};

const renderDocument = (doc: DocumentView) => {
  const lines = [
    `Room document at rev ${doc.rev}. ${access(doc)}`,
    "",
    "Blocks, in order:",
  ];
  if (!doc.blocks.length) {
    lines.push("(none yet)");
  }
  for (const b of doc.blocks) {
    const notes = [
      `block ${b.id}`,
      b.kind,
      b.yours ? "by you" : `by ${b.author}`,
      `rev ${b.rev}`,
    ];
    if (b.humanEdited) {
      notes.push(
        b.yours
          ? "a person has edited it: keep their changes"
          : "edited by a person"
      );
    }
    lines.push(`- ${notes.join(" | ")}`, indent(b.text));
  }
  lines.push("", "Comment threads:");
  if (!doc.threads.length) {
    lines.push("(none)");
  }
  for (const t of doc.threads) {
    const where = t.detached
      ? "its passage was removed"
      : `on block ${t.blockId}`;
    lines.push(
      `- thread ${t.id} | ${t.state} | ${where} | ${t.comments} comment${t.comments === 1 ? "" : "s"}`,
      indent(`"${t.passage}"`)
    );
  }
  return lines.join("\n");
};

const renderThread = (thread: ThreadView) => {
  const where = thread.detached
    ? "its passage was removed from the document"
    : `on block ${thread.blockId}`;
  const lines = [
    `Thread ${thread.id} | ${thread.state} | ${where}`,
    `Passage: "${thread.passage}"`,
    "",
    "Comments:",
  ];
  for (const c of thread.comments) {
    lines.push(
      `- ${c.author}, ${new Date(c.at).toISOString()}:`,
      indent(c.body)
    );
  }
  return lines.join("\n");
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What the whole draft would do if the turn ended now.
const renderReport = (r: DraftReport) => {
  const more =
    r.untouched.count > r.untouched.ids.length
      ? `, and ${r.untouched.count - r.untouched.ids.length} more`
      : "";
  const lines = [
    `Draft so far: ${plural(r.operations, "operation")}. Of the ${plural(r.blocks, "block")} in the document, ${r.replaced} rewritten, ${r.removed} removed, ${r.moved} moved; ${r.added} added. The document will have ${plural(r.finalBlocks, "block")}.`,
    r.untouched.count
      ? `Not mentioned by the draft, so kept exactly as they are: ${plural(r.untouched.count, "block")} (${r.untouched.ids.join(", ")}${more}).`
      : "Every block in the document is mentioned by the draft.",
  ];
  if (r.removedUndrawn.length) {
    lines.push(
      `Removed and drawn on by no block, so their text leaves the document (history keeps it): ${r.removedUndrawn.join(", ")}.`
    );
  }
  if (r.threads.moving.length) {
    lines.push("Comment threads that will move with their passage:");
    for (const t of r.threads.moving) {
      lines.push(`- thread ${t.threadId} ("${t.passage}") to ${t.toBlockId}`);
    }
  }
  if (r.threads.detaching.length) {
    lines.push(
      "Comment threads that will lose their passage (they stay open and link to the version before your run):"
    );
    for (const t of r.threads.detaching) {
      lines.push(`- thread ${t.threadId} ("${t.passage}") on ${t.blockId}`);
    }
  }
  return lines.join("\n");
};

export const documentTools: RoomToolSet = [
  defineTool({
    description: `${DOCUMENT_PURPOSE} Read it before you change it. It lists every block in order with its id, kind, author, rev and whether you wrote it, and the comment threads on it.`,
    name: "read_document",
    async run({ convex, secret, turnId }) {
      const doc = await convex.query(api.documentTools.readDocumentForTurn, {
        secret,
        turnId,
      });
      return doc.ok ? renderDocument(doc) : doc;
    },
    shape: {},
  }),
  defineTool({
    description:
      "Read one comment thread on the room document: the passage it is about and every comment, with its author.",
    name: "read_thread",
    async run({ convex, secret, turnId }, { threadId }) {
      const thread = await convex.query(api.documentTools.readThreadForTurn, {
        secret,
        threadId,
        turnId,
      });
      return thread.ok ? renderThread(thread) : thread;
    },
    shape: { threadId: z.string().describe("A thread id from read_document.") },
  }),
  defineTool({
    description:
      `${DOCUMENT_PURPOSE} Keep it current without being asked: whenever something in the session is worth keeping, add it as a short block in the section it belongs to. ` +
      "A block is one heading, paragraph or list item. Put it at the end of a section with endOfSectionId (the section heading's id), right after a block with afterBlockId, or at the end of the document with neither. Returns the new block's id and rev.",
    name: "add_block",
    async run({ convex, secret, turnId }, args) {
      const added = await convex.mutation(api.documentTools.addBlockForTurn, {
        ...args,
        secret,
        turnId,
      });
      return added.ok
        ? `Added block ${added.blockId} at rev ${added.rev}. Pass that rev as baseRev to change it later.`
        : added;
    },
    shape: {
      afterBlockId: z
        .string()
        .optional()
        .describe("Put the block right after this block."),
      endOfSectionId: z
        .string()
        .optional()
        .describe("Put the block at the end of this heading's section."),
      kind: z.enum(["heading", "paragraph", "listItem"]),
      text: z.string().describe("Markdown text of this one block."),
    },
  }),
  defineTool({
    description:
      "Replace the text of a block you wrote, to keep your contribution current. You can only change your own blocks: to respond to anyone else's, use comment. " +
      "Pass the rev you read as baseRev. If someone changed the block since then, nothing is written and you get its current text. Build on that text, and never undo a person's edit: if you disagree, comment.",
    name: "update_block",
    async run({ convex, secret, turnId }, args) {
      const updated = await convex.mutation(
        api.documentTools.updateBlockForTurn,
        { ...args, secret, turnId }
      );
      return updated.ok
        ? `Updated block ${args.blockId}. It is now at rev ${updated.rev}.`
        : updated;
    },
    shape: {
      baseRev,
      blockId: blockIdShape,
      text: z.string().describe("The full new text of the block."),
    },
  }),
  defineTool({
    description:
      "Delete a block you wrote that is no longer worth keeping. Pass the rev you read as baseRev. You cannot delete anyone else's block, or one of yours that a person has edited: comment on it instead.",
    name: "delete_block",
    async run({ convex, secret, turnId }, args) {
      const deleted = await convex.mutation(
        api.documentTools.deleteBlockForTurn,
        { ...args, secret, turnId }
      );
      return deleted.ok ? `Deleted block ${args.blockId}.` : deleted;
    },
    shape: { baseRev, blockId: blockIdShape },
  }),
  defineTool({
    description:
      "Start a comment thread on a passage of a block in the room document. This is how you respond to blocks you did not write: question them, add to them or disagree. " +
      "Copy the passage into quote exactly as it appears in the block's text. A comment does not call anyone in.",
    name: "comment",
    async run({ convex, secret, turnId }, args) {
      const made = await convex.mutation(api.documentTools.commentForTurn, {
        ...args,
        secret,
        turnId,
      });
      return made.ok
        ? `Started comment thread ${made.threadId} on block ${args.blockId}.`
        : made;
    },
    shape: {
      blockId: blockIdShape,
      body: z.string().describe("Your comment."),
      quote: z
        .string()
        .describe("The passage, copied exactly from the block's text."),
    },
  }),
];

const sourceBlockIds = z
  .array(z.string())
  .describe(
    "Ids of the blocks in the document this text draws from, from read_document. Their authors are credited."
  );
const placeAfter = z
  .string()
  .optional()
  .describe(
    'Put it right after this block: a block id, or a draft id (new-N) from draft_add. "start" puts it at the top; leave it out to put it at the end.'
  );

type DraftOp =
  | { op: "keep"; blockId: string }
  | {
      op: "replace";
      blockId: string;
      text: string;
      kind?: "heading" | "paragraph" | "listItem";
      sourceBlockIds?: string[];
    }
  | {
      op: "add";
      kind: "heading" | "paragraph" | "listItem";
      text: string;
      sourceBlockIds: string[];
      afterBlockId?: string;
    }
  | { op: "remove"; blockId: string }
  | { op: "move"; blockId: string; afterBlockId?: string };

const draft = async (
  { convex, secret, turnId }: ToolContext,
  op: DraftOp,
  done: (draftId?: string) => string
) => {
  const result = await convex.mutation(api.documentTools.scribeDraftForTurn, {
    op,
    secret,
    turnId,
  });
  return result.ok
    ? `${done(result.draftId)}\n\n${renderReport(result.report)}`
    : result;
};

/**
 * The scribe's tools: it reads the document and builds a draft, which is
 * applied in one go when its turn ends. It gets no tool that writes the
 * document directly.
 */
export const scribeTools: RoomToolSet = [
  defineTool({
    description: `${DOCUMENT_PURPOSE} You are its scribe in this turn. This lists every block in order with its id, kind and author, and the comment threads on it. Your draft names blocks by these ids.`,
    name: "read_document",
    async run({ convex, secret, turnId }) {
      const doc = await convex.query(api.documentTools.readDocumentForTurn, {
        secret,
        turnId,
      });
      return doc.ok ? renderDocument(doc) : doc;
    },
    shape: {},
  }),
  defineTool({
    description:
      "Mark a block as kept exactly as it is, undoing any earlier draft change to it. Blocks your draft never mentions are kept anyway.",
    name: "draft_keep",
    async run(ctx, { blockId }) {
      return await draft(
        ctx,
        { blockId, op: "keep" },
        () => `Block ${blockId} is kept as it is.`
      );
    },
    shape: { blockId: blockIdShape },
  }),
  defineTool({
    description:
      "Rewrite a block in your draft. Use it to merge blocks too: rewrite one with the combined text, list the others in sourceBlockIds, then draft_remove them. " +
      "The block becomes the scribe's, crediting the authors of the block and its sources. A later draft_replace of the same block replaces this one.",
    name: "draft_replace",
    async run(ctx, args) {
      return await draft(
        ctx,
        { op: "replace", ...args },
        () => `Block ${args.blockId} is rewritten in the draft.`
      );
    },
    shape: {
      blockId: z
        .string()
        .describe(
          "A block id from read_document, or a draft id (new-N) from draft_add."
        ),
      kind: z
        .enum(["heading", "paragraph", "listItem"])
        .optional()
        .describe("Change the kind of block; leave it out to keep it."),
      sourceBlockIds: sourceBlockIds.optional(),
      text: z.string().describe("The full new text of the block."),
    },
  }),
  defineTool({
    description:
      "Add a new block to your draft, listing in sourceBlockIds the blocks it draws from (an empty list for a new heading that draws on none). " +
      "Returns its draft id (new-N), which later draft operations can name. To add several blocks in a row, put each after the one you added before it.",
    name: "draft_add",
    async run(ctx, args) {
      return await draft(
        ctx,
        { op: "add", ...args },
        (id) => `Added ${id} to the draft.`
      );
    },
    shape: {
      afterBlockId: placeAfter,
      kind: z.enum(["heading", "paragraph", "listItem"]),
      sourceBlockIds,
      text: z.string().describe("Markdown text of this one block."),
    },
  }),
  defineTool({
    description:
      "Remove a block in your draft. Its text stays in the document's history. If its content lives on in a block you wrote, list it in that block's sourceBlockIds so its comment threads can follow.",
    name: "draft_remove",
    async run(ctx, { blockId }) {
      return await draft(
        ctx,
        { blockId, op: "remove" },
        () => `Block ${blockId} is removed in the draft.`
      );
    },
    shape: {
      blockId: z
        .string()
        .describe(
          "A block id from read_document, or a draft id (new-N) from draft_add."
        ),
    },
  }),
  defineTool({
    description:
      "Move a block to another place in your draft, keeping its text and author.",
    name: "draft_move",
    async run(ctx, args) {
      return await draft(
        ctx,
        { op: "move", ...args },
        () => `Block ${args.blockId} is moved in the draft.`
      );
    },
    shape: {
      afterBlockId: placeAfter,
      blockId: z
        .string()
        .describe(
          "A block id from read_document, or a draft id (new-N) from draft_add."
        ),
    },
  }),
];

/** The MCP `tools/list` entries for a tool set. */
export const listTools = (tools: RoomToolSet = documentTools) =>
  tools.map((t) => {
    const { $schema: _, ...inputSchema }: Record<string, unknown> =
      z.toJSONSchema(z.object(t.shape));
    return { description: t.description, inputSchema, name: t.name };
  });

// A client can only check an id's shape; Convex checks its table.
const isTurnId = (value: string): value is Id<"turns"> =>
  typeof value === "string";

/**
 * Runs one tool call for a turn. Unknown tools, bad arguments, refusals and
 * Convex errors all come back as text for the model, never as a throw.
 */
export const callRoomTool = async (
  convex: RoomToolsClient,
  secret: string,
  turnId: string,
  name: string,
  args: unknown,
  tools: RoomToolSet = documentTools
): Promise<RoomToolResult> => {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    return errorText(
      `There is no tool named ${name}. The tools are ${tools.map((t) => t.name).join(", ")}.`
    );
  }
  const parsed = z.object(found.shape).safeParse(args ?? {});
  if (!parsed.success) {
    return errorText(
      `Those arguments don't fit ${name}: ${z.prettifyError(parsed.error)}`
    );
  }
  try {
    if (!isTurnId(turnId)) {
      throw new Error("Turn ids are strings");
    }
    const out = await found.run({ convex, secret, turnId }, parsed.data);
    return typeof out === "string"
      ? { content: [{ text: out, type: "text" }] }
      : errorText(renderRefusal(out));
  } catch (error) {
    console.error(`room tool ${name} failed for turn ${turnId}:`, error);
    return errorText(
      `${name} failed before reaching the document. Try again, or carry on without it.`
    );
  }
};

/**
 * Claude's in-process server, named `atelier`, offering a tool set. `call`
 * runs a tool by name; the Claude adapter decides how it reaches the core.
 */
export const claudeRoomToolsServer = (
  call: (name: string, args: unknown) => Promise<RoomToolResult>,
  tools: RoomToolSet = documentTools
) =>
  createSdkMcpServer({
    alwaysLoad: true,
    name: "atelier",
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.shape,
        async (args) => await call(t.name, args)
      )
    ),
  });
