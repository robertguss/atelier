// The room document tools a model uses during a turn. One core serves every
// harness: the loopback MCP endpoint (roomToolsServer.ts) for Codex and Pi,
// and an in-process SDK server for Claude. Each tool forwards to a
// runner-secret Convex function that applies every rule itself, so this file
// only validates the shape of the arguments and turns Convex's answer, or its
// refusal, into text the model can act on.

import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export type RoomToolsClient = Pick<ConvexClient, 'query' | 'mutation'>;

/** An MCP tool result. Refusals and bad arguments set `isError`, but still read as plain text. */
export type RoomToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

interface Refusal {
  ok: false;
  reason: string;
  message: string;
  current?: { text: string; rev: number; changedBy: string };
}

interface ToolContext {
  convex: RoomToolsClient;
  secret: string;
  turnId: Id<'turns'>;
}

export interface RoomTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** What the model reads to decide when and how to use the tool. */
  description: string;
  shape: Shape;
  /** Text for the model on success, or Convex's refusal. */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<string | Refusal>;
}

export type RoomToolSet = readonly RoomTool[];

function defineTool<Shape extends z.ZodRawShape>(t: RoomTool<Shape>): RoomTool {
  return t as unknown as RoomTool;
}

const blockId = z.string().describe('A block id from read_document.');
const baseRev = z.number().int().describe('The rev of the block when you last read it.');

const DOCUMENT_PURPOSE =
  "The room document is the shared, current record of this session that the people in the room and every model keep together: what has happened, findings, ideas, changes of direction and open questions.";

export const documentTools: RoomToolSet = [
  defineTool({
    name: 'read_document',
    description:
      `${DOCUMENT_PURPOSE} Read it before you change it. It lists every block in order with its id, kind, author, rev and whether you wrote it, and the comment threads on it.`,
    shape: {},
    async run({ convex, secret, turnId }) {
      const doc = await convex.query(api.documentTools.readDocumentForTurn, { secret, turnId });
      return doc.ok ? renderDocument(doc) : doc;
    },
  }),
  defineTool({
    name: 'read_thread',
    description: 'Read one comment thread on the room document: the passage it is about and every comment, with its author.',
    shape: { threadId: z.string().describe('A thread id from read_document.') },
    async run({ convex, secret, turnId }, { threadId }) {
      const thread = await convex.query(api.documentTools.readThreadForTurn, { secret, turnId, threadId });
      return thread.ok ? renderThread(thread) : thread;
    },
  }),
  defineTool({
    name: 'add_block',
    description:
      `${DOCUMENT_PURPOSE} Keep it current without being asked: whenever something in the session is worth keeping, add it as a short block in the section it belongs to. ` +
      "A block is one heading, paragraph or list item. Put it at the end of a section with endOfSectionId (the section heading's id), right after a block with afterBlockId, or at the end of the document with neither. Returns the new block's id and rev.",
    shape: {
      kind: z.enum(['heading', 'paragraph', 'listItem']),
      text: z.string().describe('Markdown text of this one block.'),
      afterBlockId: z.string().optional().describe('Put the block right after this block.'),
      endOfSectionId: z.string().optional().describe("Put the block at the end of this heading's section."),
    },
    async run({ convex, secret, turnId }, args) {
      const added = await convex.mutation(api.documentTools.addBlockForTurn, { ...args, secret, turnId });
      return added.ok ? `Added block ${added.blockId} at rev ${added.rev}. Pass that rev as baseRev to change it later.` : added;
    },
  }),
  defineTool({
    name: 'update_block',
    description:
      'Replace the text of a block you wrote, to keep your contribution current. You can only change your own blocks: to respond to anyone else\'s, use comment. ' +
      'Pass the rev you read as baseRev. If someone changed the block since then, nothing is written and you get its current text. Build on that text, and never undo a person\'s edit: if you disagree, comment.',
    shape: { blockId, baseRev, text: z.string().describe('The full new text of the block.') },
    async run({ convex, secret, turnId }, args) {
      const updated = await convex.mutation(api.documentTools.updateBlockForTurn, { ...args, secret, turnId });
      return updated.ok ? `Updated block ${args.blockId}. It is now at rev ${updated.rev}.` : updated;
    },
  }),
  defineTool({
    name: 'delete_block',
    description:
      'Delete a block you wrote that is no longer worth keeping. Pass the rev you read as baseRev. You cannot delete anyone else\'s block, or one of yours that a person has edited: comment on it instead.',
    shape: { blockId, baseRev },
    async run({ convex, secret, turnId }, args) {
      const deleted = await convex.mutation(api.documentTools.deleteBlockForTurn, { ...args, secret, turnId });
      return deleted.ok ? `Deleted block ${args.blockId}.` : deleted;
    },
  }),
  defineTool({
    name: 'comment',
    description:
      'Start a comment thread on a passage of a block in the room document. This is how you respond to blocks you did not write: question them, add to them or disagree. ' +
      'Copy the passage into quote exactly as it appears in the block\'s text. A comment does not call anyone in.',
    shape: {
      blockId,
      quote: z.string().describe("The passage, copied exactly from the block's text."),
      body: z.string().describe('Your comment.'),
    },
    async run({ convex, secret, turnId }, args) {
      const made = await convex.mutation(api.documentTools.commentForTurn, { ...args, secret, turnId });
      return made.ok ? `Started comment thread ${made.threadId} on block ${args.blockId}.` : made;
    },
  }),
];

/** The MCP `tools/list` entries for a tool set. */
export function listTools(tools: RoomToolSet = documentTools) {
  return tools.map((t) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema };
  });
}

/**
 * Runs one tool call for a turn. Unknown tools, bad arguments, refusals and
 * Convex errors all come back as text for the model, never as a throw.
 */
export async function callRoomTool(
  convex: RoomToolsClient,
  secret: string,
  turnId: string,
  name: string,
  args: unknown,
  tools: RoomToolSet = documentTools,
): Promise<RoomToolResult> {
  const found = tools.find((t) => t.name === name);
  if (!found) return errorText(`There is no tool named ${name}. The tools are ${tools.map((t) => t.name).join(', ')}.`);
  const parsed = z.object(found.shape).safeParse(args ?? {});
  if (!parsed.success) return errorText(`Those arguments don't fit ${name}: ${z.prettifyError(parsed.error)}`);
  try {
    const out = await found.run({ convex, secret, turnId: turnId as Id<'turns'> }, parsed.data);
    return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : errorText(renderRefusal(out));
  } catch (e) {
    console.error(`room tool ${name} failed for turn ${turnId}:`, e);
    return errorText(`${name} failed before reaching the document. Try again, or carry on without it.`);
  }
}

/**
 * Claude's in-process server, named `atelier`, offering a tool set. `call`
 * runs a tool by name; the Claude adapter decides how it reaches the core.
 */
export function claudeRoomToolsServer(call: (name: string, args: unknown) => Promise<RoomToolResult>, tools: RoomToolSet = documentTools) {
  return createSdkMcpServer({
    name: 'atelier',
    alwaysLoad: true,
    tools: tools.map((t) => tool(t.name, t.description, t.shape, (args) => call(t.name, args))),
  });
}

function errorText(text: string): RoomToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function renderRefusal(refusal: Refusal) {
  let text = `Not done (${refusal.reason}): ${refusal.message}`;
  if (refusal.current) {
    text += `\n\nCurrent text, rev ${refusal.current.rev}, last changed by ${refusal.current.changedBy}:\n${refusal.current.text}`;
  }
  return text;
}

const indent = (text: string) => text.split('\n').map((line) => `  ${line}`).join('\n');

type DocumentView = Extract<FunctionReturnType<typeof api.documentTools.readDocumentForTurn>, { ok: true }>;
type ThreadView = Extract<FunctionReturnType<typeof api.documentTools.readThreadForTurn>, { ok: true }>;

function renderDocument(doc: DocumentView) {
  const lines = [
    `Room document at rev ${doc.rev}. ${doc.writable ? 'You can add blocks, change and delete your own, and comment on any block.' : 'This turn can read the document but not change it.'}`,
    '',
    'Blocks, in order:',
  ];
  if (!doc.blocks.length) lines.push('(none yet)');
  for (const b of doc.blocks) {
    const notes = [`block ${b.id}`, b.kind, b.yours ? 'by you' : `by ${b.author}`, `rev ${b.rev}`];
    if (b.humanEdited) notes.push(b.yours ? 'a person has edited it: keep their changes' : 'edited by a person');
    lines.push(`- ${notes.join(' | ')}`, indent(b.text));
  }
  lines.push('', 'Comment threads:');
  if (!doc.threads.length) lines.push('(none)');
  for (const t of doc.threads) {
    const where = t.detached ? 'its passage was removed' : `on block ${t.blockId}`;
    lines.push(`- thread ${t.id} | ${t.state} | ${where} | ${t.comments} comment${t.comments === 1 ? '' : 's'}`, indent(`"${t.passage}"`));
  }
  return lines.join('\n');
}

function renderThread(thread: ThreadView) {
  const where = thread.detached ? 'its passage was removed from the document' : `on block ${thread.blockId}`;
  const lines = [`Thread ${thread.id} | ${thread.state} | ${where}`, `Passage: "${thread.passage}"`, '', 'Comments:'];
  for (const c of thread.comments) lines.push(`- ${c.author}, ${new Date(c.at).toISOString()}:`, indent(c.body));
  return lines.join('\n');
}
