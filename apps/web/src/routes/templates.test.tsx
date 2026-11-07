import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backend, resetBackend } from '~/test/backend';
import { renderAt } from '~/test/render';

vi.mock('convex/react', async () => (await import('~/test/backend')).convexMock);
vi.mock('~/auth/ClerkShell', async () => (await import('~/test/backend')).authMock);

function signedInAs(isOwner: boolean) {
  backend.queries['me:get'] = () => ({ signedIn: true, isOwner, userId: 'u1', email: null, name: null });
}

beforeEach(() => {
  resetBackend();
  signedInAs(true);
  backend.queries['templates:list'] = () => [
    { _id: 'tpl1', name: 'Design review', sections: [{ heading: 'Goals' }, { heading: 'Risks', guidance: 'What could go wrong?' }] },
  ];
});

function section(index: number) {
  return within(screen.getAllByRole('group', { name: /^Section / })[index]!);
}

describe('templates page', () => {
  it('tells a teammate that only the owner can write templates', async () => {
    signedInAs(false);
    renderAt('/templates');
    expect(await screen.findByRole('heading', { name: /only robert can write templates/i })).toBeInTheDocument();
    expect(screen.queryByText('Design review')).not.toBeInTheDocument();
  });

  it("lists Robert's templates with their headings", async () => {
    renderAt('/templates');
    expect(await screen.findByText('Design review')).toBeInTheDocument();
    expect(screen.getByText('Goals · Risks')).toBeInTheDocument();
  });

  it('creates a template from headings and guidance', async () => {
    renderAt('/templates');
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Retro' } });
    fireEvent.change(section(0).getByLabelText('Heading'), { target: { value: 'What went well' } });
    fireEvent.change(section(0).getByLabelText('Guidance'), { target: { value: 'Name one thing.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    fireEvent.change(section(1).getByLabelText('Heading'), { target: { value: 'What to change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    expect(backend.mutations['templates:create']).toHaveBeenCalledWith({
      name: 'Retro',
      sections: [{ heading: 'What went well', guidance: 'Name one thing.' }, { heading: 'What to change' }],
    });
    await waitFor(() => expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument());
  });

  it('edits an existing template', async () => {
    renderAt('/templates');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Design review' }));

    expect(screen.getByLabelText('Template name')).toHaveValue('Design review');
    expect(section(1).getByLabelText('Guidance')).toHaveValue('What could go wrong?');
    fireEvent.click(section(0).getByRole('button', { name: 'Remove section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    expect(backend.mutations['templates:update']).toHaveBeenCalledWith({
      templateId: 'tpl1',
      name: 'Design review',
      sections: [{ heading: 'Risks', guidance: 'What could go wrong?' }],
    });
  });

  it('blocks saving a template with an empty heading', async () => {
    renderAt('/templates');
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Retro' } });
    fireEvent.change(section(0).getByLabelText('Heading'), { target: { value: '   ' } });

    expect(screen.getByText('Every section needs a heading.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(backend.mutations['templates:create']).not.toHaveBeenCalled();
  });

  it('deletes a template after confirming', async () => {
    renderAt('/templates');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Design review' }));
    expect(backend.mutations['templates:remove']).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(backend.mutations['templates:remove']).toHaveBeenCalledWith({ templateId: 'tpl1' });
  });
});
