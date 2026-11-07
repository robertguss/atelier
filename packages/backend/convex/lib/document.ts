import type { Infer } from 'convex/values';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { blockState, changeSetKind, templateSection } from '../schema';
import { getUser } from './auth';
import { record } from './ledger';
import { detachThreads, reanchorThreads } from './threads';

// Every write to a room document goes through this file: it keeps the block
// row, its revision, the document rev, the change set, checkpoints and the
// anchors of the block's comment threads in step.

export type TemplateSection = Infer<typeof templateSection>;
type BlockState = Infer<typeof blockState>;

// Atelier's default template. Robert's own templates are rows in `templates`.
export const DEFAULT_TEMPLATE: TemplateSection[] = [
  { heading: "What's happened" },
  { heading: 'Ideas & notes' },
  { heading: 'Open questions' },
];

// A checkpoint every this many revisions bounds how much history a version
// rebuild replays.
export const CHECKPOINT_EVERY = 200;

// An order key between two neighbours; null means the start or end.
export function orderBetween(before: string | null, after: string | null) {
  return generateKeyBetween(before, after);
}

export async function getDocument(ctx: QueryCtx, roomId: Id<'rooms'>) {
  return await ctx.db.query('documents').withIndex('by_room', (q) => q.eq('roomId', roomId)).unique();
}

// The document's blocks in order, without deleted ones.
export async function liveBlocks(ctx: QueryCtx, documentId: Id<'documents'>) {
  const rows = await ctx.db
    .query('blocks')
    .withIndex('by_document_order', (q) => q.eq('documentId', documentId))
    .collect();
  return rows.filter((b) => b.deletedAt === undefined);
}

type ChangeSetSpec = {
  kind: Infer<typeof changeSetKind>;
  actorParticipantId?: Id<'participants'>;
  turnId?: Id<'turns'>;
  scribeRunId?: Id<'scribeRuns'>;
};

// The change set for a model turn or scribe run, reused across that turn's
// writes, or a new one. Each new change set gets one id-only ledger row.
export async function openChangeSet(ctx: MutationCtx, documentId: Id<'documents'>, spec: ChangeSetSpec) {
  if (spec.turnId) {
    const found = await ctx.db.query('changeSets').withIndex('by_turn', (q) => q.eq('turnId', spec.turnId)).first();
    if (found) return found._id;
  }
  if (spec.scribeRunId) {
    const found = await ctx.db
      .query('changeSets')
      .withIndex('by_scribe_run', (q) => q.eq('scribeRunId', spec.scribeRunId))
      .first();
    if (found) return found._id;
  }
  const document = (await ctx.db.get(documentId))!;
  const changeSetId = await ctx.db.insert('changeSets', {
    documentId,
    roomId: document.roomId,
    ...spec,
    at: Date.now(),
    lastRev: document.rev,
    revisionCount: 0,
  });
  await record(ctx, {
    roomId: document.roomId,
    type: 'document.changed',
    actorParticipantId: spec.actorParticipantId,
    subjectId: changeSetId,
    payload: { documentId, changeSetId, kind: spec.kind },
  });
  return changeSetId;
}

function stateOf(block: Doc<'blocks'>): BlockState {
  return { order: block.order, kind: block.kind, text: block.text, author: block.author };
}

// Every revision bumps the document rev and its change set. Call `nextRev`
// before writing the block and `recordRevision` after.
async function nextRev(ctx: MutationCtx, changeSetId: Id<'changeSets'>) {
  const changeSet = (await ctx.db.get(changeSetId))!;
  const document = (await ctx.db.get(changeSet.documentId))!;
  const rev = document.rev + 1;
  await ctx.db.patch(document._id, { rev, revisionsSinceCheckpoint: document.revisionsSinceCheckpoint + 1 });
  await ctx.db.patch(changeSetId, { lastRev: rev, revisionCount: changeSet.revisionCount + 1 });
  return { rev, document };
}

// Appends the revision, then takes a checkpoint if one is due, so the
// checkpoint includes this revision. Only a scribe commit writes while the
// scribe lock is held, and it ends with its own checkpoint, so none is taken
// in the middle of it.
async function recordRevision(ctx: MutationCtx, revision: Omit<Doc<'blockRevisions'>, '_id' | '_creationTime'>) {
  await ctx.db.insert('blockRevisions', revision);
  const document = (await ctx.db.get(revision.documentId))!;
  if (document.revisionsSinceCheckpoint >= CHECKPOINT_EVERY && document.scribeRunId === undefined) {
    await takeCheckpoint(ctx, document._id, 'interval');
  }
}

export async function insertBlock(
  ctx: MutationCtx,
  changeSetId: Id<'changeSets'>,
  fields: BlockState & { fromTemplate?: boolean; sourceBlockIds?: Id<'blocks'>[] },
) {
  const { rev, document } = await nextRev(ctx, changeSetId);
  const blockId = await ctx.db.insert('blocks', { documentId: document._id, roomId: document.roomId, rev, ...fields });
  const { order, kind, text, author } = fields;
  await recordRevision(ctx, { documentId: document._id, changeSetId, blockId, rev, op: 'insert', after: { order, kind, text, author } });
  return blockId;
}

export type BlockPatch = Partial<Pick<Doc<'blocks'>, 'order' | 'kind' | 'text' | 'author' | 'humanEditedAt' | 'sourceBlockIds'>>;

// Changing a block's text also clears its template-guidance mark.
export async function patchBlock(ctx: MutationCtx, changeSetId: Id<'changeSets'>, blockId: Id<'blocks'>, fields: BlockPatch) {
  const block = (await ctx.db.get(blockId))!;
  const before = stateOf(block);
  const after = stateOf({ ...block, ...fields });
  const textChanged = after.text !== before.text;
  const op = after.order !== before.order && !textChanged && after.kind === before.kind ? 'move' : 'update';
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, { ...fields, rev, ...(textChanged ? { fromTemplate: undefined } : {}) });
  await recordRevision(ctx, { documentId: document._id, changeSetId, blockId, rev, op, before, after });
  if (textChanged) await reanchorThreads(ctx, blockId, after.text, changeSetId);
}

export async function deleteBlock(ctx: MutationCtx, changeSetId: Id<'changeSets'>, blockId: Id<'blocks'>) {
  const block = (await ctx.db.get(blockId))!;
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, { rev, deletedAt: Date.now() });
  await recordRevision(ctx, { documentId: document._id, changeSetId, blockId, rev, op: 'delete', before: stateOf(block) });
  await detachThreads(ctx, blockId, changeSetId);
}

// Brings a deleted block back under its own id, as a restore does.
export async function reviveBlock(
  ctx: MutationCtx,
  changeSetId: Id<'changeSets'>,
  blockId: Id<'blocks'>,
  state: BlockState,
  fields: Pick<BlockPatch, 'humanEditedAt'> = {},
) {
  const { rev, document } = await nextRev(ctx, changeSetId);
  await ctx.db.patch(blockId, { ...state, ...fields, rev, deletedAt: undefined });
  await recordRevision(ctx, { documentId: document._id, changeSetId, blockId, rev, op: 'insert', after: state });
  await reanchorThreads(ctx, blockId, state.text, changeSetId);
}

// The document as it stood at `rev`: the nearest checkpoint at or before it,
// with every later revision up to `rev` replayed in order. A checkpoint every
// CHECKPOINT_EVERY revisions bounds the replay.
export async function versionAt(ctx: QueryCtx, documentId: Id<'documents'>, rev: number) {
  const checkpoint = await ctx.db
    .query('documentCheckpoints')
    .withIndex('by_document_rev', (q) => q.eq('documentId', documentId).lte('rev', rev))
    .order('desc')
    .first();
  const blocks = new Map<Id<'blocks'>, BlockState>();
  if (checkpoint) {
    const rows = await ctx.db
      .query('checkpointBlocks')
      .withIndex('by_checkpoint', (q) => q.eq('checkpointId', checkpoint._id))
      .collect();
    for (const { blockId, order, kind, text, author } of rows) blocks.set(blockId, { order, kind, text, author });
  }
  const revisions = await ctx.db
    .query('blockRevisions')
    .withIndex('by_document_rev', (q) => q.eq('documentId', documentId).gt('rev', checkpoint?.rev ?? 0).lte('rev', rev))
    .collect();
  for (const revision of revisions) {
    if (revision.after) blocks.set(revision.blockId, revision.after);
    else blocks.delete(revision.blockId);
  }
  return [...blocks]
    .map(([blockId, state]) => ({ blockId, ...state }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

// People's edit leases on blocks. A lease lapses this long after it was
// taken or last renewed.
export const LEASE_MS = 2 * 60_000;

export const SCRIBE_WORKING = 'The scribe is working on the document';

export function scribeWorking(document: Doc<'documents'>, now: number) {
  return document.scribeRunId !== undefined && (document.scribeLockExpiresAt ?? 0) > now;
}

// Who holds an unexpired lease on the block, if anyone.
export function leaseHolder(block: Doc<'blocks'>, now: number) {
  return block.leaseHolderParticipantId !== undefined && (block.leaseExpiresAt ?? 0) > now
    ? block.leaseHolderParticipantId
    : undefined;
}

export async function participantName(ctx: QueryCtx, participantId: Id<'participants'>) {
  return (await ctx.db.get(participantId))?.displayName ?? 'Someone';
}

export async function clearLease(ctx: MutationCtx, blockId: Id<'blocks'>) {
  await ctx.db.patch(blockId, { leaseHolderParticipantId: undefined, leaseExpiresAt: undefined, leaseChangeSetId: undefined });
}

// Releases every lease a person holds in the room's document.
export async function releaseLeasesOf(ctx: MutationCtx, roomId: Id<'rooms'>, participantId: Id<'participants'>) {
  const document = await getDocument(ctx, roomId);
  if (!document) return;
  const blocks = await ctx.db
    .query('blocks')
    .withIndex('by_document_order', (q) => q.eq('documentId', document._id))
    .collect();
  for (const block of blocks) if (block.leaseHolderParticipantId === participantId) await clearLease(ctx, block._id);
}

// Copies every live block into a checkpoint at the current rev.
export async function takeCheckpoint(
  ctx: MutationCtx,
  documentId: Id<'documents'>,
  reason: Doc<'documentCheckpoints'>['reason'],
) {
  const document = (await ctx.db.get(documentId))!;
  const blocks = await liveBlocks(ctx, documentId);
  const checkpointId = await ctx.db.insert('documentCheckpoints', {
    documentId,
    rev: document.rev,
    reason,
    blockCount: blocks.length,
  });
  for (const block of blocks) await ctx.db.insert('checkpointBlocks', { checkpointId, blockId: block._id, ...stateOf(block) });
  await ctx.db.patch(documentId, { revisionsSinceCheckpoint: 0 });
  return checkpointId;
}

// The caller's template, or an error if it is missing or someone else's.
export async function ownTemplate(ctx: QueryCtx, templateId: Id<'templates'>) {
  const user = await getUser(ctx);
  const template = await ctx.db.get(templateId);
  if (!template || !user || template.ownerUserId !== user._id) throw new Error('Unknown template');
  return template;
}

// The room owner's participant. Template-seeded blocks are attributed to it.
export async function ownerParticipantId(ctx: QueryCtx, roomId: Id<'rooms'>) {
  const members = await ctx.db.query('roomMembers').withIndex('by_room', (q) => q.eq('roomId', roomId)).collect();
  const owner = members.find((m) => m.role === 'owner');
  if (!owner) throw new Error('Room has no owner');
  return owner.participantId;
}

// Creates the room's document from template sections, as one template
// seeding change set: each heading, followed by its guidance as a paragraph.
export async function seedDocument(
  ctx: MutationCtx,
  roomId: Id<'rooms'>,
  sections: TemplateSection[],
  templateId?: Id<'templates'>,
) {
  const robert = await ownerParticipantId(ctx, roomId);
  const documentId = await ctx.db.insert('documents', {
    roomId,
    rev: 0,
    revisionsSinceCheckpoint: 0,
    seededAt: Date.now(),
    templateId,
  });
  const changeSetId = await openChangeSet(ctx, documentId, { kind: 'template_seed', actorParticipantId: robert });
  const blocks = sections.flatMap(({ heading, guidance }) => [
    { kind: 'heading' as const, text: heading },
    ...(guidance ? [{ kind: 'paragraph' as const, text: guidance, fromTemplate: true }] : []),
  ]);
  const orders = generateNKeysBetween(null, null, blocks.length);
  for (const [i, block] of blocks.entries()) {
    await insertBlock(ctx, changeSetId, {
      ...block,
      order: orders[i]!,
      author: { kind: 'participant', participantId: robert },
    });
  }
  return documentId;
}

// Seeds the default template for a room that has no document yet.
export async function ensureDocument(ctx: MutationCtx, roomId: Id<'rooms'>) {
  const existing = await getDocument(ctx, roomId);
  if (existing) return existing._id;
  return await seedDocument(ctx, roomId, DEFAULT_TEMPLATE);
}
