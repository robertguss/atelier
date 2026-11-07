import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backend, resetBackend } from '~/test/backend';
import { renderAt } from '~/test/render';

vi.mock('convex/react', async () => (await import('~/test/backend')).convexMock);
vi.mock('~/auth/ClerkShell', async () => (await import('~/test/backend')).authMock);

function signedInAs(isOwner: boolean) {
  backend.queries['me:get'] = () => ({ signedIn: true, isOwner, userId: 'u1', email: null, name: null });
}

function runnerSeen(msAgo: number) {
  backend.queries['runners:list'] = () => [
    { _id: 'runner1', name: 'exe-vm', machine: 'vm', harnesses: [], lastHeartbeatAt: Date.now() - msAgo },
  ];
}

beforeEach(() => {
  resetBackend();
  signedInAs(true);
  runnerSeen(5_000);
  backend.queries['templates:list'] = () => [
    { _id: 'tpl1', name: 'Design review', sections: [{ heading: 'Goals' }, { heading: 'Risks', guidance: 'What could go wrong?' }] },
  ];
});

describe('new room page', () => {
  it('tells a teammate that only the owner can create rooms', async () => {
    signedInAs(false);
    renderAt('/rooms/new');
    expect(await screen.findByRole('heading', { name: /only robert can create rooms/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create room' })).not.toBeInTheDocument();
  });

  it('asks for the same details as the phone, with the default template chosen', async () => {
    renderAt('/rooms/new');
    expect(await screen.findByLabelText('Room name')).toHaveValue('');
    expect(screen.getByLabelText('Project folder')).toHaveValue('/home/exedev/Projects/');
    expect(screen.getByText('exe-vm')).toBeInTheDocument();
    const template = screen.getByLabelText('Template');
    expect(template).toHaveDisplayValue('Default');
    expect(screen.getByRole('option', { name: 'Design review' })).toBeInTheDocument();
  });

  it('creates the room with the chosen template and opens it', async () => {
    backend.mutations['rooms:create'] = vi.fn(async () => 'room9');
    const { router } = renderAt('/rooms/new');

    fireEvent.change(await screen.findByLabelText('Room name'), { target: { value: 'Pricing plan' } });
    fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: '/home/exedev/Projects/pricing' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    expect(backend.mutations['rooms:create']).toHaveBeenCalledWith({
      name: 'Pricing plan',
      cwd: '/home/exedev/Projects/pricing',
      runnerId: 'runner1',
      templateId: 'tpl1',
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/rooms/room9'));
  });

  it('sends no template when the default is kept', async () => {
    backend.mutations['rooms:create'] = vi.fn(async () => 'room9');
    renderAt('/rooms/new');

    fireEvent.change(await screen.findByLabelText('Room name'), { target: { value: 'Pricing plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    expect(backend.mutations['rooms:create']).toHaveBeenCalledWith({ name: 'Pricing plan', cwd: '/home/exedev/Projects/', runnerId: 'runner1' });
  });

  it('says no runner is online and disables Create when the runner has stopped checking in', async () => {
    runnerSeen(60_000);
    renderAt('/rooms/new');

    fireEvent.change(await screen.findByLabelText('Room name'), { target: { value: 'Pricing plan' } });
    expect(screen.getByText('No runner online')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
  });
});

describe('room list', () => {
  it('offers the owner a new room', async () => {
    backend.queries['rooms:list'] = () => [];
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'New room' })).toHaveAttribute('href', '/rooms/new');
  });

  it('offers a teammate no new room', async () => {
    signedInAs(false);
    backend.queries['rooms:list'] = () => [];
    renderAt('/');
    await screen.findByText('No rooms yet');
    expect(screen.queryByRole('link', { name: 'New room' })).not.toBeInTheDocument();
  });
});
