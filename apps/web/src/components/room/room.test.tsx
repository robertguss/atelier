import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backend, pushBackend, resetBackend } from '~/test/backend';
import { renderAt } from '~/test/render';

vi.mock('convex/react', async () => (await import('~/test/backend')).convexMock);
vi.mock('~/auth/ClerkShell', async () => (await import('~/test/backend')).authMock);

const ROOM = 'room1';
const ROBERT = 'p-robert';
const DANA = 'p-dana';
const CLAUDE = 'p-claude';
const CODEX = 'p-codex';

type Pane = {
  runner: { lastHeartbeatAt: number; offlineAfterMs: number };
  editsEnabled: boolean;
  agents: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  cards: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  turnItems?: Record<string, unknown>[];
};

let pane: Pane;

function agent(participantId: string, harness: string, displayName: string, overrides: Record<string, unknown> = {}) {
  return { participantId, displayName, harness, status: 'idle', activeTurnId: null, queued: 0, canRaiseCards: true, ...overrides };
}

function message(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    at: 1_000,
    authorParticipantId: DANA,
    body: 'Hello',
    toParticipantId: CLAUDE,
    turnId: null,
    delivery: 'delivered',
    deliveredTurnId: null,
    cancelReason: null,
    ...overrides,
  };
}

function turn(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    at: 2_000,
    participantId: CLAUDE,
    status: 'running',
    partialText: '',
    error: null,
    requestedByParticipantIds: [ROBERT],
    waitingOnHandId: null,
    stoppedByParticipantId: null,
    startedAt: 2_000,
    endedAt: null,
    ...overrides,
  };
}

const scopeQuestion = {
  id: 'scope',
  header: 'Scope',
  text: 'How big should the plan be?',
  options: [{ label: 'Small' }, { label: 'Large', description: 'Everything at once' }],
  multiSelect: false,
  allowFreeText: true,
};

function card(overrides: Record<string, unknown>) {
  return {
    id: 'h1',
    turnId: 't1',
    participantId: CLAUDE,
    questions: [scopeQuestion],
    status: 'raised',
    answers: null,
    answeredByParticipantId: null,
    answeredAt: null,
    via: null,
    raisedAt: 3_000,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function room(access: 'owner' | 'member' = 'owner') {
  backend.queries['rooms:access'] = () => access;
  backend.queries['members:notice'] = () => ({ currentVersion: 1, acceptedVersion: 1 });
  backend.queries['me:get'] = () => ({
    signedIn: true,
    isOwner: access === 'owner',
    userId: access === 'owner' ? 'u-robert' : 'u-dana',
    email: null,
    name: null,
  });
  backend.queries['rooms:get'] = () => ({
    room: { _id: ROOM, name: 'Pricing plan', editsEnabled: pane.editsEnabled },
    participants: [
      { _id: ROBERT, kind: 'human', displayName: 'Robert', userId: 'u-robert' },
      { _id: DANA, kind: 'human', displayName: 'Dana', userId: 'u-dana' },
      { _id: CLAUDE, kind: 'harness', harness: 'claude', displayName: 'Claude' },
      { _id: CODEX, kind: 'harness', harness: 'codex', displayName: 'Codex' },
    ],
  });
  backend.queries['agent:pane'] = () => pane;
  backend.queries['team:list'] = () => [];
  backend.queries['members:list'] = () => ({ members: [], invites: [] });
}

async function openRoom(access: 'owner' | 'member' = 'owner') {
  room(access);
  const rendered = renderAt(`/rooms/${ROOM}`);
  await screen.findByRole('heading', { name: 'Pricing plan' });
  return rendered;
}

beforeEach(() => {
  resetBackend();
  pane = {
    runner: { lastHeartbeatAt: Date.now(), offlineAfterMs: 45_000 },
    editsEnabled: false,
    agents: [agent(CLAUDE, 'claude', 'Claude'), agent(CODEX, 'codex', 'Codex', { canRaiseCards: false })],
    messages: [],
    cards: [],
    turns: [],
  };
});

describe('composers', () => {
  it('labels each composer by its audience', async () => {
    await openRoom();
    expect(screen.getByRole('textbox', { name: 'To Claude' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'To team only' })).toBeInTheDocument();
  });

  it('sends Enter in the team composer to the team only and keeps focus there', async () => {
    await openRoom();
    const team = screen.getByRole('textbox', { name: 'To team only' });
    team.focus();
    fireEvent.change(team, { target: { value: 'between us, this plan is too big' } });
    fireEvent.keyDown(team, { key: 'Enter' });

    await waitFor(() =>
      expect(backend.mutations['team:post']).toHaveBeenCalledWith({ roomId: ROOM, body: 'between us, this plan is too big' }),
    );
    expect(backend.mutations['messages:send']).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(team);
  });

  it('sends Enter in the agent composer to the target agent, and Shift+Enter adds a line', async () => {
    await openRoom();
    const toClaude = screen.getByRole('textbox', { name: 'To Claude' });
    toClaude.focus();
    fireEvent.change(toClaude, { target: { value: 'Draft the plan' } });
    fireEvent.keyDown(toClaude, { key: 'Enter', shiftKey: true });
    expect(backend.mutations['messages:send']).not.toHaveBeenCalled();

    fireEvent.keyDown(toClaude, { key: 'Enter' });
    await waitFor(() =>
      expect(backend.mutations['messages:send']).toHaveBeenCalledWith({ roomId: ROOM, body: 'Draft the plan', toParticipantId: CLAUDE }),
    );
    expect(backend.mutations['team:post']).not.toHaveBeenCalled();
  });

  it('defaults the agent composer to the agent waiting on an open card', async () => {
    pane.turns = [turn({ participantId: CODEX })];
    pane.cards = [card({ participantId: CODEX })];
    await openRoom();
    expect(screen.getByRole('textbox', { name: 'To Codex' })).toBeInTheDocument();
  });

  it('switches the target when the person picks another agent', async () => {
    await openRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(screen.getByRole('textbox', { name: 'To Codex' })).toBeInTheDocument();
  });

  it('offers "Send and steer now" while the target agent works, and steers the sent message', async () => {
    pane.agents = [agent(CLAUDE, 'claude', 'Claude', { status: 'running', activeTurnId: 't1' })];
    pane.turns = [turn({})];
    backend.mutations['messages:send'] = vi.fn(async ({ body }: { body: string }) => {
      pane.messages = [message({ id: 'm-new', at: 5_000, authorParticipantId: ROBERT, body, delivery: 'queued' })];
      return null;
    });
    await openRoom();

    const toClaude = screen.getByRole('textbox', { name: 'To Claude' });
    fireEvent.change(toClaude, { target: { value: 'Stop, keep it short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send and steer now' }));

    await waitFor(() => expect(backend.mutations['agent:steer']).toHaveBeenCalledWith({ messageId: 'm-new' }));
    expect(backend.mutations['messages:send']).toHaveBeenCalledWith({ roomId: ROOM, body: 'Stop, keep it short', toParticipantId: CLAUDE });
  });

  it('offers only "Send" while the target agent is idle', async () => {
    await openRoom();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send and steer now' })).not.toBeInTheDocument();
  });
});

describe('question cards', () => {
  it('answers an open card with the chosen option without moving focus to the agent composer', async () => {
    pane.agents = [agent(CLAUDE, 'claude', 'Claude', { status: 'waiting', activeTurnId: 't1' })];
    pane.turns = [turn({ waitingOnHandId: 'h1' })];
    pane.cards = [card({})];
    await openRoom();

    const open = screen.getByRole('group', { name: /Claude asks/ });
    expect(within(open).getByText('How big should the plan be?')).toBeInTheDocument();
    const large = within(open).getByRole('button', { name: /Large/ });
    large.focus();
    fireEvent.click(large);
    fireEvent.click(within(open).getByRole('button', { name: 'Answer' }));

    await waitFor(() =>
      expect(backend.mutations['hands:answer']).toHaveBeenCalledWith({ handId: 'h1', answers: [{ questionId: 'scope', labels: ['Large'] }] }),
    );
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'To Claude' }));
  });

  it('shows who answered a card and what they chose', async () => {
    pane.turns = [turn({ status: 'done' })];
    pane.cards = [card({ status: 'answered', via: 'card', answeredByParticipantId: DANA, answers: [{ questionId: 'scope', labels: ['Large'] }] })];
    await openRoom();
    expect(screen.getByText('Answered by Dana')).toBeInTheDocument();
    expect(screen.getByText('Large')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('shows a card answered in chat', async () => {
    pane.turns = [turn({ status: 'done' })];
    pane.cards = [
      card({ status: 'answered', via: 'chat', answeredByParticipantId: DANA, answers: [{ questionId: 'scope', labels: [], freeText: 'go with option B but keep it short' }] }),
    ];
    await openRoom();
    expect(screen.getByText('Answered in chat by Dana')).toBeInTheDocument();
    expect(screen.getAllByText('go with option B but keep it short').length).toBeGreaterThan(0);
  });

  it('shows a card cancelled because the turn was stopped', async () => {
    pane.turns = [turn({ status: 'interrupted', error: 'Cancelled by Dana' })];
    pane.cards = [card({ status: 'cancelled', closeReason: 'Cancelled by Dana' })];
    await openRoom();
    expect(screen.getByText(/Cancelled: the turn was stopped/)).toBeInTheDocument();
  });

  it('offers to send a late answer to an expired card as a message', async () => {
    pane.turns = [turn({ status: 'done' })];
    pane.cards = [card({ status: 'expired', closeReason: 'No answer within 2 hours' })];
    await openRoom();
    expect(screen.getByText(/Expired with no decision/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send a late answer as a message' }));
    const late = screen.getByRole('textbox', { name: 'Late answer to Claude' });
    fireEvent.change(late, { target: { value: 'Small, please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send late answer' }));
    await waitFor(() =>
      expect(backend.mutations['messages:send']).toHaveBeenCalledWith({ roomId: ROOM, body: 'Small, please', toParticipantId: CLAUDE }),
    );
  });

  it("marks an agent that can't raise question cards", async () => {
    await openRoom();
    expect(screen.getByText("Codex can't raise question cards")).toBeInTheDocument();
    expect(screen.queryByText("Claude can't raise question cards")).not.toBeInTheDocument();
  });
});

describe('queue, delivery and stopping', () => {
  it('steers a queued message on request', async () => {
    pane.agents = [agent(CLAUDE, 'claude', 'Claude', { status: 'running', activeTurnId: 't1', queued: 1 })];
    pane.turns = [turn({})];
    pane.messages = [message({ id: 'm-q', at: 3_000, body: 'Use the old pricing', delivery: 'queued' })];
    await openRoom();

    const queue = screen.getByRole('list', { name: 'Queued messages' });
    expect(within(queue).getByText('Use the old pricing')).toBeInTheDocument();
    fireEvent.click(within(queue).getByRole('button', { name: 'Steer now' }));
    expect(backend.mutations['agent:steer']).toHaveBeenCalledWith({ messageId: 'm-q' });
  });

  it('shows a rejected steer back in the queue', async () => {
    pane.agents = [agent(CLAUDE, 'claude', 'Claude', { status: 'running', activeTurnId: 't1', queued: 1 })];
    pane.turns = [turn({})];
    pane.messages = [message({ id: 'm-q', at: 3_000, body: 'Use the old pricing', delivery: 'steering' })];
    await openRoom();
    expect(screen.getByText(/Steering…/)).toBeInTheDocument();

    pane.messages = [message({ id: 'm-q', at: 3_000, body: 'Use the old pricing', delivery: 'queued' })];
    act(() => pushBackend());
    expect(await screen.findByText(/Couldn't steer into the running turn/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Steer now' })).toBeInTheDocument();
  });

  it('says why a message was never delivered', async () => {
    pane.messages = [
      message({ id: 'm-a', body: 'From a removed member', delivery: 'cancelled', cancelReason: 'removed' }),
      message({ id: 'm-b', at: 1_500, body: 'Sent while offline', delivery: 'cancelled', cancelReason: 'runner offline' }),
    ];
    await openRoom();
    expect(screen.getByText(/Not delivered: its author was removed from the room/)).toBeInTheDocument();
    expect(screen.getByText(/Not delivered: the agents' machine was offline/)).toBeInTheDocument();
  });

  it('shows who wrote each message and to which agent', async () => {
    pane.messages = [message({ body: 'Draft the plan' })];
    await openRoom();
    expect(screen.getByText('Dana → Claude')).toBeInTheDocument();
  });

  it('stops a running turn', async () => {
    pane.agents = [agent(CLAUDE, 'claude', 'Claude', { status: 'running', activeTurnId: 't1' })];
    pane.turns = [turn({ partialText: 'Working on **it**' })];
    await openRoom();
    expect(screen.getByText('it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Claude' }));
    expect(backend.mutations['messages:cancel']).toHaveBeenCalledWith({ turnId: 't1' });
  });

  it("keeps a finished turn's streamed text and tool activity next to its answer", async () => {
    pane.turns = [turn({ status: 'done', partialText: 'Looking at the files first.' })];
    pane.messages = [message({ id: 'm-r', at: 9_000, authorParticipantId: CLAUDE, toParticipantId: null, turnId: 't1', delivery: null, body: 'Here is the plan.' })];
    pane.turnItems = [{ turnId: 't1', name: 'Read', summary: 'docs/plan.md', ok: true, sequence: 1 }];
    await openRoom();
    expect(screen.getByText('Looking at the files first.')).toBeInTheDocument();
    expect(screen.getByText('Here is the plan.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 tool call/ }));
    expect(screen.getByText('docs/plan.md')).toBeInTheDocument();
  });
});

describe('room header and access', () => {
  it('shows the offline banner and refuses to send to agents when the runner is silent', async () => {
    pane.runner.lastHeartbeatAt = Date.now() - 60_000;
    await openRoom();
    expect(screen.getByRole('alert')).toHaveTextContent(/machine is offline/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('lets the owner flip the edit switch', async () => {
    await openRoom('owner');
    fireEvent.click(screen.getByRole('switch', { name: /agents may edit files/i }));
    expect(backend.mutations['rooms:setEditsEnabled']).toHaveBeenCalledWith({ roomId: ROOM, on: true });
  });

  it('shows members the edit switch read-only and no members sheet', async () => {
    pane.editsEnabled = true;
    await openRoom('member');
    const editSwitch = screen.getByRole('switch', { name: /agents may edit files/i });
    expect(editSwitch).toBeChecked();
    expect(editSwitch).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
  });

  it('lets the owner invite by email and shows the link to share', async () => {
    backend.actions['invites:create'] = vi.fn(async () => ({ inviteId: 'i1', url: 'https://atelier.example/invite/tok', emailed: true }));
    await openRoom('owner');
    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    const email = await screen.findByRole('textbox', { name: 'Email' });
    fireEvent.change(email, { target: { value: 'dana@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('https://atelier.example/invite/tok')).toBeInTheDocument();
    expect(backend.actions['invites:create']).toHaveBeenCalledWith({ roomId: ROOM, email: 'dana@example.com' });
  });

  it("swaps a removed member's open room for the no-access page", async () => {
    await openRoom('member');
    backend.queries['rooms:access'] = () => 'removed';
    const gone = () => {
      throw new Error('Not a member of this room');
    };
    backend.queries['agent:pane'] = gone;
    backend.queries['team:list'] = gone;
    backend.queries['rooms:get'] = gone;
    act(() => pushBackend());
    expect(await screen.findByRole('heading', { name: 'You no longer have access' })).toBeInTheDocument();
  });
});
