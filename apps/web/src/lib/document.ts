import type { api } from '@atelier/backend/api';
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
