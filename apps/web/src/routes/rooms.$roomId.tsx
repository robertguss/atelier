import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Component, useState } from "react";
import type { ReactNode } from "react";

import { MessagePage, PageSpinner, SignedInOnly } from "~/components/page";
import { RoomView } from "~/components/room/RoomView";
import { Button } from "~/components/ui/button";

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const NoAccess = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => (
  <MessagePage title={title} description={description}>
    <Button variant="outline" render={<Link to="/" />}>
      Your rooms
    </Button>
  </MessagePage>
);

const JoinNotice = ({
  roomId,
  version,
  changed,
}: {
  roomId: Id<"rooms">;
  version: number;
  changed: boolean;
}) => {
  const acceptNotice = useMutation(api.members.acceptNotice);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showError = (error_: unknown) => {
    setError(describeError(error_));
    setPending(false);
  };

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      await acceptNotice({ roomId, version });
    } catch (error_) {
      showError(error_);
    }
  };

  return (
    <MessagePage
      title="Before you enter"
      description={
        <>
          {changed ? (
            <p className="mb-3">
              The notice has changed since you last accepted it. Please read it
              again.
            </p>
          ) : null}
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Team chat and agent activity in this room are recorded
              permanently.
            </li>
            <li>The agents run on Robert&apos;s machine.</li>
            <li>
              Your prompts can reach anything Robert&apos;s agents can,
              including files outside the room&apos;s folder and Robert&apos;s
              connected tools.
            </li>
            <li>
              The room document is shared with the agents and kept permanently.
            </li>
          </ul>
        </>
      }
    >
      <Button
        disabled={pending}
        onClick={() => {
          accept().catch(showError);
        }}
      >
        I understand, enter the room
      </Button>
      <Button variant="ghost" render={<Link to="/" />}>
        Not now
      </Button>
      {error !== null && error !== "" ? (
        <p className="text-destructive-foreground w-full text-sm">{error}</p>
      ) : null}
    </MessagePage>
  );
};

// A room query that fails (for example in the moment someone is removed,
// before the gate's access check catches up) shows a message instead of a
// blank page. A change in access re-renders the gate and clears it.
class RoomErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Returns its children, whose ReactNode type includes promises; a render method cannot be async.
  render() {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <NoAccess
        title="This room couldn't load"
        description={describeError(error)}
      />
    );
  }
}

// Members must accept the current join notice before entering. The owner runs
// the agents, so the notice is not shown to them.
const RoomGate = ({ roomId }: { roomId: string }) => {
  const access = useQuery(api.rooms.access, { roomId });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route params are plain strings; rooms.access checks this id before the room renders.
  const id = roomId as Id<"rooms">;
  const notice = useQuery(
    api.members.notice,
    access === "member" ? { roomId: id } : "skip"
  );

  if (access === undefined) {
    return <PageSpinner />;
  }
  if (access === "none") {
    return (
      <NoAccess
        title="You don't have access"
        description="This room doesn't exist or you haven't been invited to it."
      />
    );
  }
  if (access === "removed") {
    return (
      <NoAccess
        title="You no longer have access"
        description="You were removed from this room."
      />
    );
  }
  if (access === "member") {
    if (notice === undefined) {
      return <PageSpinner />;
    }
    if (notice.acceptedVersion !== notice.currentVersion) {
      return (
        <JoinNotice
          roomId={id}
          version={notice.currentVersion}
          changed={notice.acceptedVersion !== null}
        />
      );
    }
  }
  return (
    <RoomErrorBoundary key={access}>
      <RoomView key={id} roomId={id} isOwner={access === "owner"} />
    </RoomErrorBoundary>
  );
};

// The route's typed API, read by its component before `Route` is defined.
const roomRoute = getRouteApi("/rooms/$roomId");

const RoomPage = () => {
  const { roomId } = roomRoute.useParams();
  return (
    <SignedInOnly>
      <RoomGate roomId={roomId} />
    </SignedInOnly>
  );
};

export const Route = createFileRoute("/rooms/$roomId")({ component: RoomPage });
