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

type TestBlock = {
  _id: string;
  order: string;
  kind: 'heading' | 'paragraph' | 'listItem';
  text: string;
  author: { kind: 'participant'; participantId: string } | { kind: 'scribe'; participantId: string; credits: string[] };
  rev: number;
  humanEditedAt?: number;
  leaseHolderParticipantId?: string;
  leaseExpiresAt?: number;
  openThreads: number;
};

let blocks: TestBlock[];

function block(_id: string, order: string, kind: TestBlock['kind'], text: string, participantId: string, overrides: Partial<TestBlock> = {}): TestBlock {
  return { _id, order, kind, text, author: { kind: 'participant', participantId }, rev: 1, openThreads: 0, ...overrides };
}

// Convex wraps a function's thrown error in a longer message.
function convexError(sentence: string) {
  return new Error(`[CONVEX M(blocks:save)] [Request ID: abc] Server Error\nUncaught Error: ${sentence}\n    at handler (blocks.ts:1:1)`);
}

function room(access: 'owner' | 'member') {
  backend.queries['rooms:access'] = () => access;
  backend.queries['members:notice'] = () => ({ currentVersion: 1, acceptedVersion: 1 });
  backend.queries['me:get'] = () => ({ signedIn: true, isOwner: access === 'owner', userId: access === 'owner' ? 'u-robert' : 'u-dana', email: null, name: null });
  backend.queries['rooms:get'] = () => ({
    room: { _id: ROOM, name: 'Pricing plan', editsEnabled: false },
    participants: [
      { _id: ROBERT, kind: 'human', displayName: 'Robert', userId: 'u-robert' },
      { _id: DANA, kind: 'human', displayName: 'Dana', userId: 'u-dana' },
      { _id: CLAUDE, kind: 'harness', harness: 'claude', displayName: 'Claude' },
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
}

async function openRoom(access: 'owner' | 'member' = 'owner') {
  room(access);
  renderAt(`/rooms/${ROOM}`);
  await screen.findByRole('region', { name: 'Room document' });
}

function blockWith(text: string) {
  const found = screen.getByText(text).closest<HTMLElement>('[data-block-id]');
  if (!found) throw new Error(`No block shows "${text}"`);
  return found;
}

beforeEach(() => {
  resetBackend();
  window.localStorage.clear();
  blocks = [
    block('h1', 'a0', 'heading', 'Ideas & notes', ROBERT),
    block('b1', 'a1', 'paragraph', 'Charge per seat.', CLAUDE, { openThreads: 2 }),
    block('b2', 'a2', 'listItem', 'Try a free tier', DANA),
    block('h2', 'a3', 'heading', 'Open questions', ROBERT),
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the document', () => {
  it('seeds the document once when the room opens', async () => {
    await openRoom();
    await waitFor(() => expect(backend.mutations['documents:ensure']).toHaveBeenCalledWith({ roomId: ROOM }));
    act(() => pushBackend());
    expect(backend.mutations['documents:ensure']).toHaveBeenCalledTimes(1);
  });

  it("shows each block's text, author and open thread count", async () => {
    await openRoom();
    expect(screen.getByRole('heading', { name: 'Ideas & notes' })).toBeInTheDocument();
    const paragraph = blockWith('Charge per seat.');
    expect(within(paragraph).getByText('Claude')).toBeInTheDocument();
    expect(within(paragraph).getByText('2 open threads')).toBeInTheDocument();
    expect(within(blockWith('Try a free tier')).getByText('Dana')).toBeInTheDocument();
  });

  it('shows "Robert is editing" to the teammate on a block Robert holds, and disables its controls', async () => {
    blocks[1] = { ...blocks[1]!, leaseHolderParticipantId: ROBERT, leaseExpiresAt: Date.now() + 60_000 };
    await openRoom('member');
    const held = blockWith('Charge per seat.');
    expect(within(held).getByText('Robert is editing')).toBeInTheDocument();
    expect(within(held).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(held).getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(within(blockWith('Try a free tier')).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('ignores a lease that has already lapsed', async () => {
    blocks[1] = { ...blocks[1]!, leaseHolderParticipantId: ROBERT, leaseExpiresAt: Date.now() - 1_000 };
    await openRoom('member');
    const block = blockWith('Charge per seat.');
    expect(within(block).queryByText('Robert is editing')).not.toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });
});

describe('editing a block', () => {
  it("shows the server's sentence when starting an edit is refused", async () => {
    backend.mutations['blocks:startEdit'] = vi.fn(async () => {
      throw convexError('Robert is editing this block');
    });
    await openRoom('member');
    const paragraph = blockWith('Charge per seat.');
    fireEvent.click(within(paragraph).getByRole('button', { name: 'Edit' }));
    expect(await within(paragraph).findByText('Robert is editing this block')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Edit paragraph' })).not.toBeInTheDocument();
  });

  it('saves the edited text on Enter, Shift+Enter adds a line, and a live update re-renders the block', async () => {
    backend.mutations['blocks:save'] = vi.fn(async ({ text }: { text: string }) => {
      blocks[1] = { ...blocks[1]!, text };
      pushBackend();
      return null;
    });
    await openRoom();
    fireEvent.click(within(blockWith('Charge per seat.')).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(backend.mutations['blocks:startEdit']).toHaveBeenCalledWith({ blockId: 'b1' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit paragraph' });
    expect(editor).toHaveValue('Charge per seat.');

    fireEvent.change(editor, { target: { value: 'Charge per seat, with a floor.' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(backend.mutations['blocks:save']).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(backend.mutations['blocks:save']).toHaveBeenCalledWith({ blockId: 'b1', text: 'Charge per seat, with a floor.' }));
    await waitFor(() => expect(backend.mutations['blocks:stopEdit']).toHaveBeenCalledWith({ blockId: 'b1' }));
    expect(screen.queryByRole('textbox', { name: 'Edit paragraph' })).not.toBeInTheDocument();
    expect(screen.getByText('Charge per seat, with a floor.')).toBeInTheDocument();
  });

  it('saves when the person leaves the textarea', async () => {
    await openRoom();
    fireEvent.click(within(blockWith('Try a free tier')).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit list item' });
    fireEvent.change(editor, { target: { value: 'Try a free tier for teams' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(backend.mutations['blocks:save']).toHaveBeenCalledWith({ blockId: 'b2', text: 'Try a free tier for teams' }));
  });

  it('renews the lease while the person keeps typing', async () => {
    await openRoom();
    fireEvent.click(within(blockWith('Charge per seat.')).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit paragraph' });
    vi.useFakeTimers({ toFake: ['Date'] });
    fireEvent.change(editor, { target: { value: 'Charge per seat' } });
    expect(backend.mutations['blocks:renew']).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31_000);
    fireEvent.change(editor, { target: { value: 'Charge per seat, monthly' } });
    expect(backend.mutations['blocks:renew']).toHaveBeenCalledWith({ blockId: 'b1' });
    fireEvent.change(editor, { target: { value: 'Charge per seat, monthly.' } });
    expect(backend.mutations['blocks:renew']).toHaveBeenCalledTimes(1);
  });

  it('keeps the textarea open with the typed text when the lease has lapsed, and lets the person retake it', async () => {
    await openRoom();
    fireEvent.click(within(blockWith('Charge per seat.')).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit paragraph' });
    backend.mutations['blocks:save'] = vi.fn(async () => {
      throw convexError('Your edit lock on this block has lapsed');
    });
    fireEvent.change(editor, { target: { value: 'Charge per seat, yearly' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(await screen.findByText('Your edit lock on this block has lapsed')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Edit paragraph' })).toHaveValue('Charge per seat, yearly');
    expect(backend.mutations['blocks:stopEdit']).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retake the block' }));
    await waitFor(() => expect(backend.mutations['blocks:startEdit']).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Edit paragraph' })).toHaveValue('Charge per seat, yearly');
  });

  it('offers to copy the draft when someone else now holds the block', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openRoom('member');
    fireEvent.click(within(blockWith('Charge per seat.')).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: 'Edit paragraph' });

    blocks[1] = { ...blocks[1]!, leaseHolderParticipantId: ROBERT, leaseExpiresAt: Date.now() + 60_000 };
    act(() => pushBackend());
    backend.mutations['blocks:save'] = vi.fn(async () => {
      throw convexError('Robert is editing this block');
    });
    fireEvent.change(editor, { target: { value: 'My version' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(await screen.findByText('Robert is editing this block')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retake the block' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy my draft' }));
    expect(writeText).toHaveBeenCalledWith('My version');
  });
});

describe('adding, deleting and moving blocks', () => {
  it('adds a paragraph after a block and opens it for editing', async () => {
    backend.mutations['blocks:add'] = vi.fn(async () => {
      blocks.splice(2, 0, block('b-new', 'a1V', 'paragraph', '', ROBERT, { leaseHolderParticipantId: ROBERT, leaseExpiresAt: Date.now() + 120_000 }));
      pushBackend();
      return 'b-new';
    });
    await openRoom();
    const paragraph = blockWith('Charge per seat.');
    fireEvent.click(within(paragraph).getByRole('button', { name: 'Add below' }));
    fireEvent.click(within(paragraph).getByRole('button', { name: 'Paragraph' }));

    await waitFor(() =>
      expect(backend.mutations['blocks:add']).toHaveBeenCalledWith({ roomId: ROOM, afterBlockId: 'b1', kind: 'paragraph', text: '' }),
    );
    expect(await screen.findByRole('textbox', { name: 'Edit paragraph' })).toHaveValue('');
  });

  it('adds a list item at the end of a section', async () => {
    await openRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Ideas & notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'List item' }));
    await waitFor(() =>
      expect(backend.mutations['blocks:add']).toHaveBeenCalledWith({ roomId: ROOM, endOfSectionId: 'h1', kind: 'listItem', text: '' }),
    );
  });

  it('asks for confirmation before deleting a block', async () => {
    await openRoom();
    const item = blockWith('Try a free tier');
    fireEvent.click(within(item).getByRole('button', { name: 'Delete' }));
    expect(backend.mutations['blocks:remove']).not.toHaveBeenCalled();

    fireEvent.click(within(item).getByRole('button', { name: 'Keep it' }));
    expect(within(item).queryByRole('button', { name: 'Delete this block' })).not.toBeInTheDocument();

    fireEvent.click(within(item).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Delete this block' }));
    await waitFor(() => expect(backend.mutations['blocks:remove']).toHaveBeenCalledWith({ blockId: 'b2' }));
  });

  it('moves a block down, and offers no move up for the first block', async () => {
    await openRoom();
    fireEvent.click(within(blockWith('Charge per seat.')).getByRole('button', { name: 'Move down' }));
    await waitFor(() => expect(backend.mutations['blocks:move']).toHaveBeenCalledWith({ blockId: 'b1', direction: 'down' }));
    expect(within(blockWith('Ideas & notes')).getByRole('button', { name: 'Move up' })).toBeDisabled();
  });
});
