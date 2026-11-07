import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backend, paginate, pushBackend, resetBackend } from '~/test/backend';
import { renderAt } from '~/test/render';

vi.mock('convex/react', async () => (await import('~/test/backend')).convexMock);
vi.mock('~/auth/ClerkShell', async () => (await import('~/test/backend')).authMock);

const ROOM = 'room1';
const ROBERT = 'p-robert';
const DANA = 'p-dana';
const CLAUDE = 'p-claude';
const PI = 'p-pi';

type Kind = 'template_seed' | 'model_turn' | 'human_edit' | 'scribe_run' | 'restore';
type ChangeSet = { _id: string; kind: Kind; actorParticipantId?: string; at: number; revisionCount: number };

const by = (participantId: string) => ({ kind: 'participant', participantId });
const at = (minute: number) => Date.UTC(2026, 10, 7, 9, minute);

const current = [
  { _id: 'h1', order: 'a0', kind: 'heading', text: 'Ideas & notes', author: by(ROBERT), rev: 30, openThreads: 0 },
  { _id: 'b1', order: 'a1', kind: 'paragraph', text: 'Charge per team.', author: by(CLAUDE), rev: 30, openThreads: 0 },
];

let changeSets: ChangeSet[];

// The newest twenty-two versions: a restore, one scribe run of many block
// changes, a model's turn, two edits, sixteen older edits and, oldest, the
// template seeding, which is past the first page.
function history(): ChangeSet[] {
  const older = Array.from({ length: 16 }, (_, i): ChangeSet => ({ _id: `old${i}`, kind: 'human_edit', actorParticipantId: ROBERT, at: at(20 - i), revisionCount: 1 }));
  return [
    { _id: 'cs-restore', kind: 'restore', actorParticipantId: ROBERT, at: at(50), revisionCount: 2 },
    { _id: 'cs-scribe', kind: 'scribe_run', actorParticipantId: CLAUDE, at: at(45), revisionCount: 9 },
    { _id: 'cs-pi', kind: 'model_turn', actorParticipantId: PI, at: at(40), revisionCount: 3 },
    { _id: 'cs-dana', kind: 'human_edit', actorParticipantId: DANA, at: at(35), revisionCount: 2 },
    { _id: 'cs-robert', kind: 'human_edit', actorParticipantId: ROBERT, at: at(30), revisionCount: 1 },
    ...older,
    { _id: 'cs-seed', kind: 'template_seed', actorParticipantId: ROBERT, at: at(0), revisionCount: 3 },
  ];
}

function openRoom() {
  backend.queries['rooms:access'] = () => 'owner';
  backend.queries['members:notice'] = () => ({ currentVersion: 1, acceptedVersion: 1 });
  backend.queries['me:get'] = () => ({ signedIn: true, isOwner: true, userId: 'u-robert', email: null, name: null });
  backend.queries['rooms:get'] = () => ({
    room: { _id: ROOM, name: 'Pricing plan', editsEnabled: false },
    participants: [
      { _id: ROBERT, kind: 'human', displayName: 'Robert', userId: 'u-robert' },
      { _id: DANA, kind: 'human', displayName: 'Dana', userId: 'u-dana' },
      { _id: CLAUDE, kind: 'harness', harness: 'claude', displayName: 'Claude' },
      { _id: PI, kind: 'harness', harness: 'pi', displayName: 'Pi' },
    ],
  });
  backend.queries['agent:pane'] = () => ({
    runner: { lastHeartbeatAt: Date.now(), offlineAfterMs: 45_000 },
    editsEnabled: false,
    hasOlder: false,
    agents: [],
    messages: [],
    cards: [],
    turns: [],
  });
  backend.queries['team:list'] = () => [];
  backend.queries['documents:get'] = () => ({ documentId: 'd1', rev: 30, blocks: current });
  backend.queries['threads:list'] = () => ({ open: [], settled: [] });
  backend.queries['history:list'] = paginate(() => changeSets);
  // Dana's edit: she rewrote one paragraph, added a list item and removed
  // another paragraph; the heading was untouched.
  backend.queries['history:version'] = ({ changeSetId }) =>
    changeSetId === 'cs-dana'
      ? {
          changeSetId,
          rev: 12,
          blocks: [
            { blockId: 'h1', order: 'a0', kind: 'heading', text: 'Ideas & notes', author: by(ROBERT) },
            { blockId: 'b1', order: 'a1', kind: 'paragraph', text: 'Charge per seat, billed monthly.', author: by(CLAUDE) },
            { blockId: 'b3', order: 'a3', kind: 'listItem', text: 'Try a free tier', author: by(DANA) },
          ],
        }
      : { changeSetId, rev: 30, blocks: current.map(({ _id, order, kind, text, author }) => ({ blockId: _id, order, kind, text, author })) };
  backend.queries['history:diff'] = ({ changeSetId }) =>
    changeSetId === 'cs-dana'
      ? [
          {
            blockId: 'b1',
            rev: 10,
            op: 'update',
            before: { order: 'a1', kind: 'paragraph', text: 'Charge per seat.', author: by(CLAUDE) },
            after: { order: 'a1', kind: 'paragraph', text: 'Charge per seat, billed monthly.', author: by(CLAUDE) },
          },
          {
            blockId: 'b2',
            rev: 11,
            op: 'delete',
            before: { order: 'a2', kind: 'paragraph', text: 'Offer an annual discount.', author: by(PI) },
          },
          { blockId: 'b3', rev: 12, op: 'insert', after: { order: 'a3', kind: 'listItem', text: 'Try a free tier', author: by(DANA) } },
        ]
      : [];
  renderAt(`/rooms/${ROOM}`);
}

async function openHistory() {
  openRoom();
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  return screen.findByRole('dialog', { name: 'History' });
}

function entryTitles(panel: HTMLElement) {
  const list = within(panel).getByRole('list', { name: 'Versions' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('[data-entry-title]')?.textContent);
}

beforeEach(() => {
  resetBackend();
  window.localStorage.clear();
  changeSets = history();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the history list', () => {
  it('lists change sets newest first with who made each and what kind it was, a scribe run as one entry, and loads older ones on request', async () => {
    const panel = await openHistory();
    const titles = entryTitles(panel);
    expect(titles.slice(0, 5)).toEqual(['Restore by Robert', 'Scribe run by Claude', "Pi's turn", 'Edit by Dana', 'Edit by Robert']);
    expect(titles.filter((t) => t?.startsWith('Scribe run'))).toHaveLength(1);
    expect(titles).toHaveLength(20);
    expect(titles).not.toContain('Template seeding by Robert');

    fireEvent.click(within(panel).getByRole('button', { name: 'Load older versions' }));
    await waitFor(() => expect(entryTitles(panel)).toHaveLength(22));
    expect(entryTitles(panel).at(-1)).toBe('Template seeding by Robert');
    expect(within(panel).queryByRole('button', { name: 'Load older versions' })).not.toBeInTheDocument();
  });
});

describe('a selected version', () => {
  it('shows that version read-only, with the blocks its change set added, changed and removed marked', async () => {
    const panel = await openHistory();
    fireEvent.click(within(panel).getByRole('button', { name: /^Edit by Dana/ }));

    const version = await within(panel).findByRole('region', { name: 'Version: Edit by Dana' });
    const blockOf = (text: string) => within(version).getByText(text).closest<HTMLElement>('[data-version-block]')!;
    expect(blockOf('Charge per seat, billed monthly.')).toHaveAttribute('data-mark', 'changed');
    expect(within(blockOf('Charge per seat, billed monthly.')).getByText('Changed')).toBeInTheDocument();
    expect(blockOf('Try a free tier')).toHaveAttribute('data-mark', 'added');
    expect(blockOf('Offer an annual discount.')).toHaveAttribute('data-mark', 'removed');
    expect(blockOf('Ideas & notes')).not.toHaveAttribute('data-mark');
    // The removed block sits where it stood, between the two it came between.
    expect(within(version).getAllByText(/Charge per seat, billed|Offer an annual|Try a free/).map((n) => n.textContent)).toEqual([
      'Charge per seat, billed monthly.',
      'Offer an annual discount.',
      'Try a free tier',
    ]);
    expect(within(version).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(version).queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'All versions' }));
    expect(within(panel).getByRole('list', { name: 'Versions' })).toBeInTheDocument();
  });

  it('offers no restore for the newest version, which is the document as it is now', async () => {
    const panel = await openHistory();
    fireEvent.click(within(panel).getByRole('button', { name: /^Restore by Robert/ }));
    expect(await within(panel).findByText('This is the document as it is now.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument();
  });
});

describe('restoring a version', () => {
  it('asks for confirmation, calls restore once, and shows its refusal', async () => {
    backend.mutations['history:restore'] = vi.fn(async () => {
      throw new Error('[CONVEX M(history:restore)] [Request ID: 1] Server Error\nUncaught Error: Robert is editing a block\n    at handler (history.ts:1:1)');
    });
    const panel = await openHistory();
    fireEvent.click(within(panel).getByRole('button', { name: /^Edit by Dana/ }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Restore this version' }));
    expect(backend.mutations['history:restore']).not.toHaveBeenCalled();

    const confirm = within(panel).getByRole('group', { name: 'Confirm restore' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restore' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Robert is editing a block');
    expect(backend.mutations['history:restore']).toHaveBeenCalledTimes(1);
    expect(backend.mutations['history:restore']).toHaveBeenCalledWith({ changeSetId: 'cs-dana' });
  });

  it('returns to the list once the restore lands, where it shows as the person’s change', async () => {
    backend.mutations['history:restore'] = vi.fn(async () => {
      changeSets = [{ _id: 'cs-new', kind: 'restore', actorParticipantId: ROBERT, at: at(55), revisionCount: 2 }, ...changeSets];
      pushBackend();
      return 'cs-new';
    });
    const panel = await openHistory();
    fireEvent.click(within(panel).getByRole('button', { name: /^Edit by Dana/ }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Restore this version' }));
    fireEvent.click(within(within(panel).getByRole('group', { name: 'Confirm restore' })).getByRole('button', { name: 'Restore' }));

    await within(panel).findByRole('list', { name: 'Versions' });
    expect(entryTitles(panel)[0]).toBe('Restore by Robert');
    expect(within(panel).getByRole('status')).toHaveTextContent(/^Restored the version from /);
    expect(backend.mutations['history:restore']).toHaveBeenCalledTimes(1);
  });
});
