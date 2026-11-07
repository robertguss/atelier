import type { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { Names } from './room';

export type DocumentData = NonNullable<FunctionReturnType<typeof api.documents.get>>;
export type DocBlock = DocumentData['blocks'][number];
export type BlockKind = DocBlock['kind'];

export const BLOCK_KINDS: BlockKind[] = ['heading', 'paragraph', 'listItem'];

export const KIND_LABEL: Record<BlockKind, string> = { heading: 'Heading', paragraph: 'Paragraph', listItem: 'List item' };

// The server lets a lease lapse two minutes after its last renewal; renewing
// this often while the person types keeps it held with room to spare.
export const RENEW_EVERY_MS = 30_000;

/** A heading and the blocks under it. Blocks before the first heading form a section with no heading. */
export interface Section {
  heading: DocBlock | null;
  blocks: DocBlock[];
}

export function sectionsOf(blocks: readonly DocBlock[]): Section[] {
  const sections: Section[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') sections.push({ heading: block, blocks: [] });
    else if (sections.length === 0) sections.push({ heading: null, blocks: [block] });
    else sections[sections.length - 1]!.blocks.push(block);
  }
  return sections;
}

/** Who holds an unexpired edit lease on the block, if anyone. */
export function leaseHolder(block: DocBlock, now: number): string | null {
  return block.leaseHolderParticipantId && (block.leaseExpiresAt ?? 0) > now ? block.leaseHolderParticipantId : null;
}

export function authorText(author: DocBlock['author'], names: Names) {
  if (author.kind === 'participant') return names(author.participantId);
  const credits = author.credits.map(names);
  return credits.length ? `Scribe (${names(author.participantId)}), from ${credits.join(', ')}` : `Scribe (${names(author.participantId)})`;
}

export function openThreadsText(count: number) {
  return count === 1 ? '1 open thread' : `${count} open threads`;
}

export type ThreadsData = FunctionReturnType<typeof api.threads.list>;
export type DocThread = ThreadsData['open'][number];
export type ThreadComment = DocThread['comments'][number];
export type MentionState = ThreadComment['mentions'][number]['state'];

/** A passage of a block's stored text, [start, end) in string indices. */
export interface Passage {
  blockId: Id<'blocks'>;
  start: number;
  end: number;
}

/** Threads in the order of their blocks, and by place within a block. Threads on blocks no longer in the document go last. */
export function threadsInBlockOrder(threads: readonly DocThread[], blocks: readonly DocBlock[]): DocThread[] {
  const index = new Map<string, number>(blocks.map((b, i) => [b._id, i]));
  const place = (t: DocThread) => index.get(t.blockId) ?? blocks.length;
  return [...threads].sort((a, b) => place(a) - place(b) || a.position - b.position);
}

/** Where a mention of a model stands, for its thread card. */
export function mentionText(state: MentionState, name: string) {
  switch (state) {
    case 'waiting':
      return `waiting for ${name}`;
    case 'waitingForRunner':
      return 'waiting for the runner';
    case 'answering':
      return `${name} is answering`;
    case 'replied':
      return `${name} replied`;
    case 'failed':
      return `${name} could not reply`;
    case 'cancelled':
      return `mention of ${name} cancelled`;
  }
}

export type ChangeSetEntry = FunctionReturnType<typeof api.history.list>['page'][number];
export type VersionData = FunctionReturnType<typeof api.history.version>;
export type VersionBlock = VersionData['blocks'][number];
export type ChangeSetDiff = FunctionReturnType<typeof api.history.diff>;

/** One history entry in plain words: what kind of change it was, and whose. A scribe run names its model and the person who called it in. */
export function entryText(entry: ChangeSetEntry, names: Names) {
  if (entry.kind === 'scribe_run' && entry.scribeStartedByParticipantId) {
    return `Scribe run by ${names(entry.scribeParticipantId ?? entry.actorParticipantId)}, started by ${names(entry.scribeStartedByParticipantId)}`;
  }
  return changeSetText(entry.kind, names(entry.actorParticipantId));
}

function changeSetText(kind: ChangeSetEntry['kind'], actor: string) {
  switch (kind) {
    case 'template_seed':
      return `Template seeding by ${actor}`;
    case 'human_edit':
      return `Edit by ${actor}`;
    case 'model_turn':
      return `${actor}'s turn`;
    case 'scribe_run':
      return `Scribe run by ${actor}`;
    case 'restore':
      return `Restore by ${actor}`;
  }
}

/** How one change set left a block, as a version view marks it. */
export type BlockMark = 'added' | 'changed' | 'moved' | 'removed' | 'commented';

export const MARK_LABEL: Record<BlockMark, string> = {
  added: 'Added',
  changed: 'Changed',
  moved: 'Moved',
  removed: 'Removed',
  commented: 'Commented',
};

/**
 * A version's blocks with the ones its change set touched marked. Blocks it
 * removed are not in the version, so they come back from the change set's
 * record, in the place they stood. A block added and removed again within
 * the change set left no trace and is not shown.
 */
export function markedVersion(blocks: readonly VersionBlock[], diff: ChangeSetDiff) {
  const byBlock = new Map<string, ChangeSetDiff>();
  for (const revision of diff) byBlock.set(revision.blockId, [...(byBlock.get(revision.blockId) ?? []), revision]);
  const marks = new Map<string, BlockMark>();
  const removed: VersionBlock[] = [];
  for (const [blockId, revisions] of byBlock) {
    const first = revisions[0]!;
    const last = revisions[revisions.length - 1]!;
    if (last.op === 'delete') {
      if (first.op !== 'insert' && first.before) {
        removed.push({ blockId: blockId as VersionBlock['blockId'], ...first.before });
        marks.set(blockId, 'removed');
      }
    } else if (first.op === 'insert') {
      marks.set(blockId, 'added');
    } else {
      marks.set(blockId, revisions.some((r) => r.op === 'update') ? 'changed' : 'moved');
    }
  }
  const all = [...blocks, ...removed].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return all.map((block) => ({ ...block, mark: marks.get(block.blockId) ?? null }));
}

export type ScribeRun = NonNullable<FunctionReturnType<typeof api.scribe.latest>>;

/** Whether a scribe run holds the document now. The lock lapses on its own at its expiry. */
export function scribeLocked(doc: Pick<DocumentData, 'scribeRunId' | 'scribeLockExpiresAt'>, now: number) {
  return !!doc.scribeRunId && (doc.scribeLockExpiresAt ?? 0) > now;
}

/** How long a run has been going, as "45s" or "3m 05s". */
export function elapsedText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
