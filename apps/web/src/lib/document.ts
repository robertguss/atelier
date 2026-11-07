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
