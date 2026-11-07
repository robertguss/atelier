import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backend, pushBackend, resetBackend } from '~/test/backend';
import { renderAt } from '~/test/render';

vi.mock('convex/react', async () => (await import('~/test/backend')).convexMock);
vi.mock('~/auth/ClerkShell', async () => (await import('~/test/backend')).authMock);

const ROOM = 'room1';
const ROBERT = 'p-robert';
const DANA = 'p-dana';
const CLAUDE = 'p-claude';
const PI = 'p-pi';

type MentionState = 'waiting' | 'waitingForRunner' | 'answering' | 'replied' | 'failed' | 'cancelled';
type TestComment = { _id: string; at: number; authorParticipantId: string; body: string; mentions: { participantId: string; state: MentionState }[] };
type TestThread = {
  _id: string;
  blockId: string;
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
  state: 'open' | 'settled';
  detachedBeforeChangeSetId: string | null;
  comments: TestComment[];
};

const blocks = [
  { _id: 'h1', order: 'a0', kind: 'heading', text: 'Ideas & notes', author: { kind: 'participant', participantId: ROBERT }, rev: 1, openThreads: 0 },
  { _id: 'b1', order: 'a1', kind: 'paragraph', text: 'Charge **per seat** monthly.', author: { kind: 'participant', participantId: CLAUDE }, rev: 1, openThreads: 1 },
  { _id: 'b2', order: 'a2', kind: 'listItem', text: 'Try a free tier', author: { kind: 'participant', participantId: DANA }, rev: 1, openThreads: 1 },
];

let threads: TestThread[];

function comment(_id: string, authorParticipantId: string, body: string, mentions: TestComment['mentions'] = []): TestComment {
  return { _id, at: Date.UTC(2026, 10, 7, 9, 30), authorParticipantId, body, mentions };
}

function thread(_id: string, blockId: string, exact: string, position: number, comments: TestComment[], overrides: Partial<TestThread> = {}): TestThread {
  return { _id, blockId, exact, prefix: '', suffix: '', position, state: 'open', detachedBeforeChangeSetId: null, comments, ...overrides };
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
  backend.queries['documents:get'] = () => ({ documentId: 'd1', rev: 4, blocks });
  backend.queries['threads:list'] = () => ({
    open: threads.filter((t) => t.state === 'open'),
    settled: threads.filter((t) => t.state === 'settled'),
  });
  renderAt(`/rooms/${ROOM}`);
  return screen.findByRole('complementary', { name: 'Comments' });
}

function setThreadState(state: TestThread['state']) {
  return vi.fn(async ({ threadId }: { threadId: string }) => {
    threads = threads.map((t) => (t._id === threadId ? { ...t, state } : t));
    pushBackend();
    return null;
  });
}

// Selects rendered text in a block the way a reader's drag would.
function selectInBlock(blockId: string, from: [Node, number], to: [Node, number]) {
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
  return document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)!;
}

function threadCard(exact: string) {
  return screen.getByRole('article', { name: `Thread on “${exact}”` });
}

beforeEach(() => {
  resetBackend();
  window.localStorage.clear();
  document.getSelection()?.removeAllRanges();
  threads = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('starting a thread', () => {
  it('comments on a selection that crosses markdown emphasis, at the offsets of the stored text, with the @mention in the body', async () => {
    await openRoom();
    const paragraph = document.querySelector('[data-block-text="b1"] p')!;
    const block = selectInBlock('b1', [paragraph.firstChild!, 3], [paragraph.querySelector('strong')!.firstChild!, 3]);
    fireEvent.click(within(block).getByRole('button', { name: 'Comment' }));

    const composer = within(block).getByRole('group', { name: 'New comment' });
    expect(within(composer).getByText('rge **per')).toBeInTheDocument();
    const input = within(composer).getByRole('textbox', { name: 'Comment' });
    fireEvent.change(input, { target: { value: 'Is this right @' } });
    const options = within(composer).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Claude', 'Pi']);

    fireEvent.change(input, { target: { value: 'Is this right @Cl' } });
    fireEvent.click(within(composer).getByRole('option', { name: 'Claude' }));
    expect(input).toHaveValue('Is this right @Claude ');

    fireEvent.change(input, { target: { value: 'Is this right @Claude for teams?' } });
    fireEvent.click(within(composer).getByRole('button', { name: 'Post comment' }));
    await waitFor(() =>
      expect(backend.mutations['threads:create']).toHaveBeenCalledWith({ blockId: 'b1', start: 3, end: 12, body: 'Is this right @Claude for teams?' }),
    );
    await waitFor(() => expect(within(block).queryByRole('group', { name: 'New comment' })).not.toBeInTheDocument());
  });

  it('posts a comment without a mention as a plain body', async () => {
    await openRoom();
    const item = document.querySelector('[data-block-text="b2"] li')!;
    const block = selectInBlock('b2', [item.firstChild!, 4], [item.firstChild!, 15]);
    fireEvent.click(within(block).getByRole('button', { name: 'Comment' }));
    const input = within(block).getByRole('textbox', { name: 'Comment' });
    fireEvent.change(input, { target: { value: 'Only for students' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(backend.mutations['threads:create']).toHaveBeenCalledWith({ blockId: 'b2', start: 4, end: 15, body: 'Only for students' }),
    );
  });

  it('offers no Comment button without a selection in a block', async () => {
    await openRoom();
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
  });
});

describe('the margin', () => {
  it('lists open threads in block order, each with its passage and every comment with its author', async () => {
    threads = [
      thread('t2', 'b2', 'free tier', 6, [comment('c2', DANA, 'For students?')]),
      thread('t1', 'b1', 'per seat', 9, [comment('c1', ROBERT, 'Or per team?'), comment('c3', CLAUDE, 'Per team is simpler to bill.')]),
    ];
    const margin = await openRoom();
    const cards = within(margin).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Thread on “per seat”', 'Thread on “free tier”']);
    const first = within(cards[0]!);
    expect(first.getByText('Per team is simpler to bill.').closest('li')).toHaveTextContent('Claude');
    expect(first.getByText('Or per team?').closest('li')).toHaveTextContent('Robert');
  });

  it('highlights the passages of open threads where the browser supports it', async () => {
    const registry = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
    threads = [thread('t1', 'b1', 'per seat', 9, [comment('c1', ROBERT, 'Or per team?')])];
    await openRoom();
    await waitFor(() => expect(registry.get('atelier-comment')?.ranges.map((r) => r.toString())).toEqual(['per seat']));
  });

  it('replies in a thread', async () => {
    threads = [thread('t1', 'b1', 'per seat', 9, [comment('c1', ROBERT, 'Or per team?')])];
    await openRoom();
    const card = threadCard('per seat');
    fireEvent.click(within(card).getByRole('button', { name: 'Reply' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Reply' }), { target: { value: 'Agreed, @Pi?' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(backend.mutations['threads:reply']).toHaveBeenCalledWith({ threadId: 't1', body: 'Agreed, @Pi?' }));
  });
});

describe('settling and reopening', () => {
  it('moves a settled thread into the collapsed Settled section, and Reopen moves it back', async () => {
    backend.mutations['threads:settle'] = setThreadState('settled');
    backend.mutations['threads:reopen'] = setThreadState('open');
    threads = [thread('t1', 'b1', 'per seat', 9, [comment('c1', ROBERT, 'Or per team?')])];
    const margin = await openRoom();
    fireEvent.click(within(threadCard('per seat')).getByRole('button', { name: 'Settle' }));
    await waitFor(() => expect(backend.mutations['threads:settle']).toHaveBeenCalledWith({ threadId: 't1' }));

    const toggle = await within(margin).findByRole('button', { name: 'Settled (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(margin).queryByRole('article')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(within(threadCard('per seat')).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(backend.mutations['threads:reopen']).toHaveBeenCalledWith({ threadId: 't1' }));
    expect(within(margin).queryByRole('button', { name: /Settled/ })).not.toBeInTheDocument();
    expect(within(threadCard('per seat')).getByRole('button', { name: 'Settle' })).toBeInTheDocument();
  });
});

describe('a thread whose passage was removed', () => {
  it('says so and opens the version just before the change that removed it', async () => {
    backend.queries['history:versionBefore'] = ({ changeSetId }) =>
      changeSetId === 'cs9'
        ? {
            changeSetId: 'cs9',
            rev: 8,
            blocks: [
              { blockId: 'h1', order: 'a0', kind: 'heading', text: 'Ideas & notes', author: { kind: 'participant', participantId: ROBERT } },
              { blockId: 'b0', order: 'a05', kind: 'paragraph', text: 'Offer an annual discount.', author: { kind: 'participant', participantId: DANA } },
            ],
          }
        : null;
    threads = [
      thread('t1', 'b0', 'annual discount', 9, [comment('c1', ROBERT, 'How much?')], { detachedBeforeChangeSetId: 'cs9' }),
    ];
    await openRoom();
    const card = threadCard('annual discount');
    expect(within(card).getByText('Passage removed')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'View original' }));

    const original = await screen.findByRole('dialog', { name: 'Original passage' });
    expect(within(original).getByText('Offer an annual discount.')).toBeInTheDocument();
    expect(within(original).getByText('Offer an annual discount.').closest('[data-mark="commented"]')).not.toBeNull();
  });
});

describe('mentions of models', () => {
  it('shows "waiting for Claude" while Claude is busy, and its reply under its name once it arrives', async () => {
    threads = [thread('t1', 'b1', 'per seat', 9, [comment('c1', ROBERT, '@Claude is this right?', [{ participantId: CLAUDE, state: 'waiting' }])])];
    await openRoom();
    const card = threadCard('per seat');
    expect(within(card).getByText('waiting for Claude')).toBeInTheDocument();

    threads = [
      thread('t1', 'b1', 'per seat', 9, [
        comment('c1', ROBERT, '@Claude is this right?', [{ participantId: CLAUDE, state: 'replied' }]),
        comment('c2', CLAUDE, 'Yes, per seat matches the cost.'),
      ]),
    ];
    act(() => pushBackend());
    expect(within(card).queryByText('waiting for Claude')).not.toBeInTheDocument();
    expect(within(card).getByText('Claude replied')).toBeInTheDocument();
    expect(within(card).getByText('Yes, per seat matches the cost.').closest('li')).toHaveTextContent('Claude');
  });

  it("shows each mention's delivery state", async () => {
    threads = [
      thread('t1', 'b1', 'per seat', 9, [
        comment('c1', ROBERT, '@Claude @Pi thoughts?', [
          { participantId: CLAUDE, state: 'answering' },
          { participantId: PI, state: 'waitingForRunner' },
        ]),
        comment('c2', DANA, '@Pi again?', [{ participantId: PI, state: 'failed' }]),
      ]),
    ];
    await openRoom();
    const card = threadCard('per seat');
    expect(within(card).getByText('Claude is answering')).toBeInTheDocument();
    expect(within(card).getByText('waiting for the runner')).toBeInTheDocument();
    expect(within(card).getByText('Pi could not reply')).toBeInTheDocument();
  });
});
