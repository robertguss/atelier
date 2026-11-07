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
const RUN = 'run1';
const TURN = 'turn-scribe';

const by = (participantId: string) => ({ kind: 'participant', participantId });

const blocks = [
  { _id: 'h1', order: 'a0', kind: 'heading', text: 'Ideas & notes', author: by(ROBERT), rev: 3, openThreads: 0 },
  { _id: 'b1', order: 'a1', kind: 'paragraph', text: 'Charge per seat.', author: by(CLAUDE), rev: 3, openThreads: 0 },
  { _id: 'b2', order: 'a2', kind: 'listItem', text: 'Try a free tier', author: by(DANA), rev: 3, openThreads: 0 },
];

type Run = {
  runId: string;
  participantId: string;
  startedByParticipantId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'committed' | 'released';
  releaseReason?: string;
  turnId?: string;
  stoppedByParticipantId?: string;
  changeSetId?: string;
};

// The document's lock while a run holds it, and the room's latest run.
let lock: { scribeRunId?: string; scribeLockExpiresAt?: number };
let run: Run | null;
let changeSets: { _id: string; kind: string; actorParticipantId: string; at: number; revisionCount: number; scribeParticipantId?: string; scribeStartedByParticipantId?: string }[];

// Claude acting as scribe, called in by Dana two minutes and five seconds ago.
function working() {
  lock = { scribeRunId: RUN, scribeLockExpiresAt: Date.now() + 30 * 60_000 };
  run = { runId: RUN, participantId: CLAUDE, startedByParticipantId: DANA, startedAt: Date.now() - 125_000, status: 'running', turnId: TURN };
}

// The run ends: the lock clears and the run records how.
function end(how: Partial<Run>) {
  lock = {};
  run = { ...run!, endedAt: Date.now(), ...how };
  pushBackend();
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
  backend.queries['documents:get'] = () => ({ documentId: 'd1', rev: 3, ...lock, blocks });
  backend.queries['threads:list'] = () => ({ open: [], settled: [] });
  backend.queries['scribe:latest'] = () => run;
  backend.queries['history:list'] = paginate(() => changeSets);
  backend.queries['history:version'] = ({ changeSetId }) => ({
    changeSetId,
    rev: 3,
    blocks: blocks.map(({ _id, order, kind, text, author }) => ({ blockId: _id, order, kind, text, author })),
  });
  backend.queries['history:diff'] = () => [];
  renderAt(`/rooms/${ROOM}`);
  return screen.findByRole('region', { name: 'Room document' });
}

function toolbarOf(text: string) {
  const block = screen.getByText(text).closest<HTMLElement>('[data-block-id]')!;
  return within(block).getByRole('toolbar');
}

beforeEach(() => {
  resetBackend();
  window.localStorage.clear();
  lock = {};
  run = null;
  changeSets = [{ _id: 'cs-seed', kind: 'template_seed', actorParticipantId: ROBERT, at: Date.now() - 3_600_000, revisionCount: 3 }];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calling in the scribe', () => {
  it('starts a run with the model the person chooses', async () => {
    await openRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Call in the scribe' }));
    const choose = screen.getByRole('group', { name: 'Choose the scribe' });
    expect(within(choose).getAllByRole('button').map((b) => b.textContent)).toEqual(['Claude', 'Pi', 'Cancel']);

    fireEvent.click(within(choose).getByRole('button', { name: 'Pi' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Choose the scribe' })).not.toBeInTheDocument());
    expect(backend.mutations['scribe:begin']).toHaveBeenCalledTimes(1);
    expect(backend.mutations['scribe:begin']).toHaveBeenCalledWith({ roomId: ROOM, participantId: PI });
  });

  it('shows the refusal naming the person who is editing, and starts nothing', async () => {
    backend.mutations['scribe:begin'] = vi.fn(async () => {
      throw new Error('[CONVEX M(scribe:begin)] [Request ID: 1] Server Error\nUncaught Error: Dana is editing a block\n    at handler (scribe.ts:1:1)');
    });
    await openRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Call in the scribe' }));
    const choose = screen.getByRole('group', { name: 'Choose the scribe' });
    fireEvent.click(within(choose).getByRole('button', { name: 'Claude' }));

    expect(await within(choose).findByRole('alert')).toHaveTextContent(/^Dana is editing a block$/);
    expect(screen.queryByRole('region', { name: 'The scribe is working' })).not.toBeInTheDocument();
    expect(within(toolbarOf('Charge per seat.')).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });
});

describe('while the scribe works', () => {
  it('shows the banner with the model, who started it and the time so far, and every block’s edit, add, move and delete is disabled', async () => {
    working();
    await openRoom();
    const banner = screen.getByRole('region', { name: 'The scribe is working' });
    expect(banner).toHaveTextContent('The scribe is working');
    expect(banner).toHaveTextContent(/Claude, started by Dana · 2m 0\ds/);

    for (const text of ['Ideas & notes', 'Charge per seat.', 'Try a free tier']) {
      const toolbar = toolbarOf(text);
      for (const name of ['Edit', 'Add below', 'Move up', 'Move down', 'Delete']) {
        expect(within(toolbar).getByRole('button', { name })).toBeDisabled();
      }
    }
    expect(screen.getByRole('button', { name: 'Add to Ideas & notes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Call in the scribe' })).toBeDisabled();
  });

  it('Stop cancels the scribe’s turn, and the notice says the document is unchanged', async () => {
    working();
    backend.mutations['messages:cancel'] = vi.fn(async () => {
      end({ status: 'released', releaseReason: 'Cancelled by owner', stoppedByParticipantId: ROBERT });
      return null;
    });
    await openRoom();
    fireEvent.click(within(screen.getByRole('region', { name: 'The scribe is working' })).getByRole('button', { name: 'Stop' }));

    const notice = await screen.findByRole('status', { name: 'Scribe run ended' });
    expect(notice).toHaveTextContent('Robert stopped the scribe run. The document is unchanged.');
    expect(backend.mutations['messages:cancel']).toHaveBeenCalledTimes(1);
    expect(backend.mutations['messages:cancel']).toHaveBeenCalledWith({ turnId: TURN });
    expect(screen.queryByRole('region', { name: 'The scribe is working' })).not.toBeInTheDocument();
    expect(within(toolbarOf('Charge per seat.')).getByRole('button', { name: 'Edit' })).toBeEnabled();

    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'Scribe run ended' })).not.toBeInTheDocument();
  });

  it('a failed run’s notice gives the reason and says the document is unchanged', async () => {
    working();
    await openRoom();
    end({ status: 'released', releaseReason: 'Model overloaded' });
    expect(await screen.findByRole('status', { name: 'Scribe run ended' })).toHaveTextContent(
      'The scribe run failed: Model overloaded. The document is unchanged.',
    );
  });
});

describe('a committed run', () => {
  it('announces the run and opens its history entry, which names the scribe and the person who started it', async () => {
    working();
    await openRoom();
    changeSets = [
      { _id: 'cs-scribe', kind: 'scribe_run', actorParticipantId: CLAUDE, at: Date.now(), revisionCount: 6, scribeParticipantId: CLAUDE, scribeStartedByParticipantId: DANA },
      ...changeSets,
    ];
    end({ status: 'committed', changeSetId: 'cs-scribe' });

    const notice = await screen.findByRole('status', { name: 'Scribe run ended' });
    expect(notice).toHaveTextContent('Claude finished the scribe run.');
    fireEvent.click(within(notice).getByRole('button', { name: 'See it in history' }));

    const panel = await screen.findByRole('dialog', { name: 'History' });
    expect(await within(panel).findByRole('region', { name: 'Version: Scribe run by Claude, started by Dana' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'All versions' }));
    const list = within(panel).getByRole('list', { name: 'Versions' });
    expect(within(list).getAllByRole('listitem')[0]?.querySelector('[data-entry-title]')).toHaveTextContent('Scribe run by Claude, started by Dana');
  });

  it('a run that ended before the document was opened is not announced', async () => {
    run = { runId: RUN, participantId: CLAUDE, startedByParticipantId: DANA, startedAt: Date.now() - 600_000, endedAt: Date.now() - 300_000, status: 'committed', turnId: TURN, changeSetId: 'cs-scribe' };
    await openRoom();
    expect(screen.queryByRole('status', { name: 'Scribe run ended' })).not.toBeInTheDocument();
  });
});
