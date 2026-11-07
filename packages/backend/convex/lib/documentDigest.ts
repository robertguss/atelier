import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { liveBlocks, scribeWorking } from "./document";
import { agentName, firstCodePoints, neutralize } from "./prompt";
import type { DocumentMode } from "./visibility";

// The room document as a model turn sees it when the runner claims the turn,
// in a <room_document> section of its prompt. Block ids appear in it, so the
// document tools can name them. Everything from the document passes through
// `neutralize`, so block text cannot forge a prompt envelope. Nothing here
// reads team chat.

// About how much of the prompt the document may take, in characters.
export const DIGEST_BUDGET = 24_000;

// How much of each block by someone else the outline shows, longest first.
const EXCERPT_LENGTHS = [80, 40, 20, 0];
const LINE_LIMIT = 200;

type DigestMode = Exclude<DocumentMode, "none">;
interface Thread {
  thread: Doc<"threads">;
  comments: Doc<"comments">[];
}
interface View {
  document: Doc<"documents">;
  blocks: Doc<"blocks">[];
  threads: Map<Id<"blocks">, Thread[]>;
  names: Map<Id<"participants">, string>;
  participantId: Id<"participants">;
}

// Each participant's name as an agent reads it.
export const participantNames = async (ctx: QueryCtx, roomId: Id<"rooms">) => {
  const rows = await ctx.db
    .query("participants")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  return new Map(rows.map((p) => [p._id, agentName(p.displayName, "Someone")]));
};

export const authorLabel = (
  author: Doc<"blocks">["author"],
  names: Map<Id<"participants">, string>
) => {
  const name = (id: Id<"participants">) => names.get(id) ?? "Someone";
  if (author.kind === "participant") {
    return name(author.participantId);
  }
  const credits = author.credits.length
    ? `, drawing on ${author.credits.map(name).join(", ")}`
    : "";
  return `the scribe (${name(author.participantId)}${credits})`;
};

export const isOwnBlock = (
  block: Doc<"blocks">,
  participantId: Id<"participants">
) =>
  block.author.kind === "participant" &&
  block.author.participantId === participantId;

const loadView = async (
  ctx: QueryCtx,
  document: Doc<"documents">,
  participantId: Id<"participants">
): Promise<View> => {
  const threads = new Map<Id<"blocks">, Thread[]>();
  const withComments = await Promise.all(
    (["open", "settled"] as const).map(async (state) => {
      const rows = await ctx.db
        .query("threads")
        .withIndex("by_document_state", (q) =>
          q.eq("documentId", document._id).eq("state", state)
        )
        .collect();
      return await Promise.all(
        rows.map(async (thread) => ({
          comments: await ctx.db
            .query("comments")
            .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
            .collect(),
          thread,
        }))
      );
    })
  );
  for (const entry of withComments.flat()) {
    threads.set(entry.thread.blockId, [
      ...(threads.get(entry.thread.blockId) ?? []),
      entry,
    ]);
  }
  return {
    blocks: await liveBlocks(ctx, document._id),
    document,
    names: await participantNames(ctx, document.roomId),
    participantId,
    threads,
  };
};

const oneLine = (text: string, limit = LINE_LIMIT) => {
  const line = text.replaceAll(/\s+/gu, " ").trim();
  const kept = firstCodePoints(line, limit);
  return kept.length < line.length ? `${kept}…` : line;
};

const indented = (text: string, spaces: number) => {
  const pad = " ".repeat(spaces);
  return neutralize(text)
    .split("\n")
    .map((line) => pad + line);
};

const header = (view: View, block: Doc<"blocks">) => {
  const own = isOwnBlock(block, view.participantId);
  const parts = [
    `[${block._id}] ${block.kind} by ${neutralize(authorLabel(block.author, view.names))}`,
  ];
  if (own) {
    parts.push(`yours, rev ${block.rev}`);
  }
  if (own && block.humanEditedAt !== undefined) {
    parts.push("a person has edited it since you wrote it; keep their change");
  }
  return parts.join(", ");
};

// One block in full: its header, its text, and its threads with every comment.
const fullBlock = (view: View, block: Doc<"blocks">) => {
  const lines = [header(view, block), ...indented(block.text, 2)];
  for (const { thread, comments } of view.threads.get(block._id) ?? []) {
    const detached = thread.detachedBeforeChangeSetId
      ? ", passage since removed"
      : "";
    lines.push(
      `  thread ${thread._id} (${thread.state}${detached}) on "${neutralize(oneLine(thread.exact))}":`
    );
    for (const c of comments) {
      lines.push(
        `    ${neutralize(view.names.get(c.authorParticipantId) ?? "Someone")}:`,
        ...indented(c.body, 6)
      );
    }
  }
  return lines;
};

// One line for a block in the outline: its header and the start of its text.
const outlineLine = (view: View, block: Doc<"blocks">, excerpt: number) => {
  const firstLine = block.text.split("\n")[0] ?? "";
  let shown = "";
  if (block.kind === "heading") {
    shown = oneLine(firstLine);
  } else if (excerpt > 0) {
    shown = oneLine(firstLine, excerpt);
  }
  return shown === ""
    ? header(view, block)
    : `${header(view, block)}: ${neutralize(shown)}`;
};

const intro = (view: View, mode: DigestMode) => {
  const lines = [
    "This is the room's shared document. Everyone in the room reads it, people and agents. Each block starts with its id in brackets; the document tools take these ids.",
  ];
  if (mode === "write") {
    lines.push(
      "Add to it without being asked whenever something is worth keeping: a finding, an idea, a change of direction or an open question. You may update or delete blocks you wrote; comment on anyone else's instead of changing them."
    );
  } else if (mode === "scribe") {
    lines.push(
      "You are its scribe in this turn. Your draft tools name blocks by these ids, and blocks your draft does not mention are kept as they are."
    );
    return lines;
  } else {
    lines.push("You can read it in this turn but not change it.");
  }
  if (scribeWorking(view.document, Date.now())) {
    lines.push(
      "The scribe is working on the document now, so it cannot be changed until the scribe finishes."
    );
  }
  return lines;
};

const wrap = (
  view: View,
  kind: "full" | "outline" | "changes",
  lines: string[]
) =>
  [
    `<room_document rev="${view.document.rev}" view="${kind}">`,
    ...lines,
    "</room_document>",
  ].join("\n");

const fits = (text: string) => text.length <= DIGEST_BUDGET;

const clip = (view: View, lines: string[]) => {
  const end = "The rest is cut short here; call read_document to see it.";
  const kept = [];
  let { length } = wrap(view, "outline", [end]);
  for (const line of lines) {
    if (length + line.length + 1 > DIGEST_BUDGET) {
      kept.push(end);
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return wrap(view, "outline", kept);
};

// The outline: every block by someone else as one line, and this
// participant's own blocks in full with their threads, so it sees its blocks
// a person has edited. Excerpts shorten until it fits; past that, only
// headings remain from other authors, and as a last resort it is cut short.
const outline = (view: View, lead: string[]) => {
  const own = (b: Doc<"blocks">) => isOwnBlock(b, view.participantId);
  const note =
    "The document is too long to show in full here. Your own blocks are in full; call read_document for the rest.";
  for (const excerpt of EXCERPT_LENGTHS) {
    const text = wrap(view, "outline", [
      ...lead,
      note,
      ...view.blocks.flatMap((b) =>
        own(b) ? fullBlock(view, b) : [outlineLine(view, b, excerpt)]
      ),
    ]);
    if (fits(text)) {
      return text;
    }
  }
  const lines = [...lead, note, "Only headings are shown from other authors."];
  for (const b of view.blocks) {
    if (own(b)) {
      lines.push(...fullBlock(view, b));
    } else if (b.kind === "heading") {
      lines.push(outlineLine(view, b, 0));
    }
  }
  return clip(view, lines);
};

// What changed after `seenRev`: the blocks changed since, and whether a
// scribe run rewrote the document in between.
const changesSince = async (
  ctx: QueryCtx,
  document: Doc<"documents">,
  seenRev: number
) => {
  const revisions = await ctx.db
    .query("blockRevisions")
    .withIndex("by_document_rev", (q) =>
      q.eq("documentId", document._id).gt("rev", seenRev)
    )
    .collect();
  const changeSets = await Promise.all(
    [...new Set(revisions.map((r) => r.changeSetId))].map(
      async (changeSetId) => await ctx.db.get(changeSetId)
    )
  );
  return {
    blockIds: new Set(revisions.map((r) => r.blockId)),
    scribe: changeSets.some((c) => c?.kind === "scribe_run"),
  };
};

// The <room_document> section for a turn. A fresh session (no `seenRev`)
// gets the whole document when it fits the budget, otherwise the outline. A
// resumed session gets only the blocks changed since the rev it has seen,
// and the outline when those do not fit or a scribe run rewrote the document.
export const documentDigest = async (
  ctx: QueryCtx,
  document: Doc<"documents">,
  {
    participantId,
    mode,
    seenRev,
  }: { participantId: Id<"participants">; mode: DigestMode; seenRev?: number }
) => {
  const view = await loadView(ctx, document, participantId);
  const lead = intro(view, mode);
  if (seenRev === undefined) {
    const full = wrap(view, "full", [
      ...lead,
      ...view.blocks.flatMap((b) => fullBlock(view, b)),
    ]);
    return fits(full) ? full : outline(view, lead);
  }
  const changes = await changesSince(ctx, document, seenRev);
  if (changes.scribe) {
    return outline(view, [
      ...lead,
      "The scribe has reworked the document since your last turn.",
    ]);
  }
  const changed = view.blocks.filter((b) => changes.blockIds.has(b._id));
  const live = new Set(view.blocks.map((b) => b._id));
  const removed = [...changes.blockIds].filter((id) => !live.has(id));
  const lines =
    changed.length + removed.length === 0
      ? ["Nothing has changed since your last turn."]
      : [
          `Only the blocks changed since your last turn (rev ${seenRev}) are shown; call read_document for the whole document.`,
          ...changed.flatMap((b) => fullBlock(view, b)),
          ...removed.map((id) => `[${id}] removed`),
        ];
  const text = wrap(view, "changes", [...lead, ...lines]);
  return fits(text) ? text : outline(view, lead);
};

// The digest goes right after the room context, ahead of the messages.
export const withDigest = (prompt: string, digest: string) => {
  const end = "</room_context>";
  const at = prompt.indexOf(end);
  if (at === -1) {
    return `${prompt}\n\n${digest}`;
  }
  return `${prompt.slice(0, at + end.length)}\n\n${digest}${prompt.slice(at + end.length)}`;
};
