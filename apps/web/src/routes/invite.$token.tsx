import { api } from "@atelier/backend/api";
import {
  Navigate,
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useSignOut, useSignedInEmail } from "~/auth/ClerkShell";
import { MessagePage, PageSpinner, SignInScreen } from "~/components/page";
import { Button } from "~/components/ui/button";

const ACCEPT_FAILURES: Record<string, string> = {
  accepted: "This invite has already been used by another account.",
  email_mismatch: "This invite is for a different email address.",
  expired: "This invite has expired.",
  not_found: "This invite link isn't valid.",
  revoked: "This invite was revoked.",
};

const logSignOutFailure = (error: unknown) => {
  console.error("Sign out failed", error);
};

const WrongAccount = ({ invitedEmail }: { invitedEmail: string }) => {
  const email = useSignedInEmail();
  const signOut = useSignOut();
  return (
    <MessagePage
      title="This invite is for a different account"
      description={
        <>
          The invite was sent to{" "}
          <strong className="text-foreground">{invitedEmail}</strong>
          {email !== null && email !== "" ? (
            <>
              , but you&apos;re signed in as{" "}
              <strong className="text-foreground">{email}</strong>
            </>
          ) : null}
          . Sign out, then sign in with the invited address.
        </>
      }
    >
      <Button
        onClick={() => {
          signOut().catch(logSignOutFailure);
        }}
      >
        Sign out
      </Button>
    </MessagePage>
  );
};

const AcceptInvite = ({
  token,
  roomName,
}: {
  token: string;
  roomName: string;
}) => {
  const accept = useMutation(api.invites.accept);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await accept({ token });
      if (result.ok) {
        await navigate({
          params: { roomId: result.roomId },
          replace: true,
          to: "/rooms/$roomId",
        });
        return;
      }
      setError(
        ACCEPT_FAILURES[result.reason] ?? "This invite cannot be accepted."
      );
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    }
    setPending(false);
  };

  const showError = (error_: unknown) => {
    setError(error_ instanceof Error ? error_.message : String(error_));
    setPending(false);
  };

  return (
    <MessagePage
      title={`Join ${roomName}`}
      description="You've been invited to work in this Atelier room."
    >
      <Button
        disabled={pending}
        onClick={() => {
          join().catch(showError);
        }}
      >
        Join {roomName}
      </Button>
      {error !== null && error !== "" ? (
        <p className="text-destructive-foreground w-full text-sm">{error}</p>
      ) : null}
    </MessagePage>
  );
};

// The route's typed API, read by its component before `Route` is defined.
const inviteRoute = getRouteApi("/invite/$token");

const InvitePage = () => {
  const { token } = inviteRoute.useParams();
  const { isLoading, isAuthenticated } = useConvexAuth();
  // Wait for auth so the email match is computed for the signed-in person.
  const invite = useQuery(api.invites.lookup, isLoading ? "skip" : { token });

  if (isLoading || invite === undefined) {
    return <PageSpinner />;
  }
  if (invite === null) {
    return (
      <MessagePage
        title="This invite link isn't valid"
        description="Check that you opened the whole link, or ask Robert for a new invite."
      />
    );
  }
  if (invite.status === "expired") {
    return (
      <MessagePage
        title="This invite has expired"
        description="Invites last 7 days. Ask Robert to send you a new one."
      />
    );
  }
  if (invite.status === "revoked") {
    return (
      <MessagePage
        title="This invite was revoked"
        description="Ask Robert if you should still have access to this room."
      />
    );
  }
  if (invite.status === "accepted") {
    return (
      <Navigate
        to="/rooms/$roomId"
        params={{ roomId: invite.roomId }}
        replace
      />
    );
  }
  if (!isAuthenticated) {
    return (
      <SignInScreen
        title={`You're invited to ${invite.roomName}`}
        description={`Sign in or create your account with ${invite.email} to join.`}
      />
    );
  }
  if (!invite.matches) {
    return <WrongAccount invitedEmail={invite.email} />;
  }
  return <AcceptInvite token={token} roomName={invite.roomName} />;
};

export const Route = createFileRoute("/invite/$token")({
  component: InvitePage,
});
