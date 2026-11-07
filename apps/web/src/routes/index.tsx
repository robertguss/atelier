import { api } from '@atelier/backend/api';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { ChevronRightIcon, PlusIcon } from 'lucide-react';
import { useSignOut, useSignedInEmail } from '~/auth/ClerkShell';
import { PageSpinner, SignedInOnly } from '~/components/page';
import { Button } from '~/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty';

export const Route = createFileRoute('/')({
  component: () => (
    <SignedInOnly>
      <RoomList />
    </SignedInOnly>
  ),
});

function RoomList() {
  const rooms = useQuery(api.rooms.list, {});
  const me = useQuery(api.me.get, {});
  const isOwner = me?.signedIn === true && me.isOwner;
  const email = useSignedInEmail();
  const signOut = useSignOut();

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-4">
        <span className="text-lg font-medium tracking-tight">Atelier</span>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {email}
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      {isOwner ? (
        <div className="flex gap-2 pb-2">
          <Button size="sm" render={<Link to="/rooms/new" />}>
            <PlusIcon />
            New room
          </Button>
          <Button size="sm" variant="ghost" render={<Link to="/templates" />}>
            Templates
          </Button>
        </div>
      ) : null}
      {rooms === undefined ? (
        <PageSpinner />
      ) : rooms.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No rooms yet</EmptyTitle>
            <EmptyDescription>
              {isOwner ? 'Create a room to start working with your agents.' : 'When Robert invites you to a room, open the invite link he sends you.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="mt-2 divide-y rounded-xl border bg-card">
          {rooms.map((room) => (
            <li key={room._id}>
              <Link
                to="/rooms/$roomId"
                params={{ roomId: room._id }}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent"
              >
                <span className="font-medium">{room.name}</span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {room.role === 'owner' ? 'Owner' : 'Member'}
                  <ChevronRightIcon className="size-4" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
