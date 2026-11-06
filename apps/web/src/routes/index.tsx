import { api } from "@atelier/backend/api";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ChevronRightIcon } from "lucide-react";

import { useSignOut, useSignedInEmail } from "~/auth/ClerkShell";
import { PageSpinner, SignedInOnly } from "~/components/page";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";

export const Route = createFileRoute("/")({
  component: () => (
    <SignedInOnly>
      <RoomList />
    </SignedInOnly>
  ),
});

function RoomList() {
  const rooms = useQuery(api.rooms.list, {});
  const email = useSignedInEmail();
  const signOut = useSignOut();

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-4">
        <span className="text-lg font-medium tracking-tight">Atelier</span>
        <div className="text-muted-foreground flex items-center gap-3 text-sm">
          {email}
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      {rooms === undefined ? (
        <PageSpinner />
      ) : rooms.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No rooms yet</EmptyTitle>
            <EmptyDescription>
              When Robert invites you to a room, open the invite link he sends
              you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="bg-card mt-2 divide-y rounded-xl border">
          {rooms.map((room) => (
            <li key={room._id}>
              <Link
                to="/rooms/$roomId"
                params={{ roomId: room._id }}
                className="hover:bg-accent flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="font-medium">{room.name}</span>
                <span className="text-muted-foreground flex items-center gap-2 text-sm">
                  {room.role === "owner" ? "Owner" : "Member"}
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
