import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ChevronLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { MessagePage, PageSpinner, SignedInOnly } from '~/components/page';
import { Button } from '~/components/ui/button';

export const Route = createFileRoute('/rooms/$roomId')({ component: RoomPage });

function RoomPage() {
  const { roomId } = Route.useParams();
  return (
    <SignedInOnly>
      <RoomGate roomId={roomId} />
    </SignedInOnly>
  );
}

// Members must accept the current join notice before entering. The owner runs
// the agents, so the notice is not shown to them.
function RoomGate({ roomId }: { roomId: string }) {
  const access = useQuery(api.rooms.access, { roomId });
  const id = roomId as Id<'rooms'>;
  const notice = useQuery(api.members.notice, access === 'member' ? { roomId: id } : 'skip');

  if (access === undefined) return <PageSpinner />;
  if (access === 'none') {
    return <NoAccess title="You don't have access" description="This room doesn't exist or you haven't been invited to it." />;
  }
  if (access === 'removed') {
    return <NoAccess title="You no longer have access" description="You were removed from this room." />;
  }
  if (access === 'member') {
    if (notice === undefined) return <PageSpinner />;
    if (notice.acceptedVersion !== notice.currentVersion) {
      return <JoinNotice roomId={id} version={notice.currentVersion} changed={notice.acceptedVersion !== null} />;
    }
  }
  return <RoomPlaceholder roomId={id} />;
}

function NoAccess({ title, description }: { title: string; description: string }) {
  return (
    <MessagePage title={title} description={description}>
      <Button variant="outline" render={<Link to="/" />}>
        Your rooms
      </Button>
    </MessagePage>
  );
}

function JoinNotice({ roomId, version, changed }: { roomId: Id<'rooms'>; version: number; changed: boolean }) {
  const acceptNotice = useMutation(api.members.acceptNotice);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      await acceptNotice({ roomId, version });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };

  return (
    <MessagePage
      title="Before you enter"
      description={
        <>
          {changed ? <p className="mb-3">The notice has changed since you last accepted it. Please read it again.</p> : null}
          <ul className="list-disc space-y-2 pl-5">
            <li>Team chat and agent activity in this room are recorded permanently.</li>
            <li>The agents run on Robert's machine.</li>
            <li>
              Your prompts can reach anything Robert's agents can, including files outside the room's folder and Robert's
              connected tools.
            </li>
          </ul>
        </>
      }
    >
      <Button disabled={pending} onClick={() => void accept()}>
        I understand, enter the room
      </Button>
      <Button variant="ghost" render={<Link to="/" />}>
        Not now
      </Button>
      {error ? <p className="w-full text-sm text-destructive-foreground">{error}</p> : null}
    </MessagePage>
  );
}

// The two-pane room view replaces this.
function RoomPlaceholder({ roomId }: { roomId: Id<'rooms'> }) {
  const data = useQuery(api.rooms.get, { roomId });
  if (data === undefined) return <PageSpinner />;
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4 sm:px-6">
      <header className="flex items-center gap-2 py-4">
        <Button variant="ghost" size="icon-sm" aria-label="Your rooms" render={<Link to="/" />}>
          <ChevronLeftIcon />
        </Button>
        <h1 className="text-lg font-medium tracking-tight">{data?.room.name ?? 'Room'}</h1>
      </header>
      <p className="text-sm text-muted-foreground">The room's conversation view isn't available on the web yet.</p>
    </div>
  );
}
