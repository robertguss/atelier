import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState, type FormEvent } from 'react';
import { OwnerOnly, PageSpinner, SignedInOnly } from '~/components/page';
import { errorText } from '~/components/room/errors';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { StandalonePage, StandalonePageHeader } from '~/components/ui/standalone-page';
import { useNow } from '~/lib/room';

export const Route = createFileRoute('/rooms/new')({
  component: () => (
    <SignedInOnly>
      <OwnerOnly title="Only Robert can create rooms">
        <NewRoom />
      </OwnerOnly>
    </SignedInOnly>
  ),
});

// The same default folder the phone offers.
const DEFAULT_FOLDER = '/home/exedev/Projects/';
// A runner is offline after this long without a heartbeat, as the backend decides.
const OFFLINE_AFTER_MS = 45_000;

function NewRoom() {
  const runners = useQuery(api.runners.list, {});
  const templates = useQuery(api.templates.list, {});
  const createRoom = useMutation(api.rooms.create);
  const navigate = useNavigate();
  const now = useNow(5_000);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(DEFAULT_FOLDER);
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (runners === undefined || templates === undefined) return <PageSpinner />;

  const runner = runners
    .filter((r) => now - r.lastHeartbeatAt <= OFFLINE_AFTER_MS)
    .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt)[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!runner || !name.trim() || !cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const roomId = await createRoom({
        name,
        cwd,
        runnerId: runner._id,
        // Leaving the template out gives the room Atelier's default.
        ...(templateId ? { templateId: templateId as Id<'templates'> } : {}),
      });
      await navigate({ to: '/rooms/$roomId', params: { roomId } });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader title="New room" description="The room's agents work in its project folder on the runner." />
      <form className="mt-6 space-y-4 text-sm" onSubmit={(e) => void submit(e)}>
        <label className="block space-y-1.5">
          <span className="font-medium">Room name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block space-y-1.5">
          <span className="font-medium">Project folder</span>
          <Input font="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </label>
        <div className="space-y-1.5">
          <span className="font-medium">Runner</span>
          <p className={runner ? undefined : 'text-destructive-foreground'}>{runner ? runner.name : 'No runner online'}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="new-room-template" className="block font-medium">
            Template
          </label>
          <select
            id="new-room-template"
            className="h-8.5 w-full rounded-lg border border-input bg-background px-2.5 sm:h-7.5"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">Default</option>
            {templates.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            The room's document starts with the template's sections.{' '}
            <Link to="/templates" className="underline">
              Edit templates
            </Link>
          </p>
        </div>
        {error ? <p className="text-destructive-foreground">{error}</p> : null}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="submit" disabled={!runner || !name.trim() || !cwd.trim() || busy}>
            Create room
          </Button>
          <Button variant="ghost" render={<Link to="/" />}>
            Cancel
          </Button>
        </div>
      </form>
    </StandalonePage>
  );
}
