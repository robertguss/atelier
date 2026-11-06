import { api } from "@atelier/backend/api";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useSignOut, useSignedInEmail } from "~/auth/ClerkShell";
import { MessagePage, PageSpinner, SignInScreen } from "~/components/page";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/invite/$token")({
  component: InvitePage,
});

const ACCEPT_FAILURES: Record<string, string> = {
  not_found: "This invite link isn't valid.",
  expired: "This invite has expired.",
  revoked: "This invite was revoked.",
  accepted: "This invite has already been used by another account.",
  email_mismatch: "This invite is for a different email address.",
};

function InvitePage() {
  const { token } = Route.useParams();
  const { isLoading, isAuthenticated } = useConvexAuth();
  // Wait for auth so the email match is computed for the signed-in person.
  const invite = useQuery(api.invites.lookup, isLoading ? "skip" : { token });

  if (isLoading || invite === undefined) return <PageSpinner />;
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
  if (!invite.matches) return <WrongAccount invitedEmail={invite.email} />;
  return <AcceptInvite token={token} roomName={invite.roomName} />;
}

function WrongAccount({ invitedEmail }: { invitedEmail: string }) {
  const email = useSignedInEmail();
  const signOut = useSignOut();
  return (
    <MessagePage
      title="This invite is for a different account"
      description={
        <>
          The invite was sent to{" "}
          <strong className="text-foreground">{invitedEmail}</strong>
          {email ? (
            <>
              , but you're signed in as{" "}
              <strong className="text-foreground">{email}</strong>
            </>
          ) : null}
          . Sign out, then sign in with the invited address.
        </>
      }
    >
      <Button onClick={() => void signOut()}>Sign out</Button>
    </MessagePage>
  );
}

function AcceptInvite({
  token,
  roomName,
}: {
  token: string;
  roomName: string;
}) {
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
          to: "/rooms/$roomId",
          params: { roomId: result.roomId },
          replace: true,
        });
        return;
      }
      setError(
        ACCEPT_FAILURES[result.reason] ?? "This invite cannot be accepted."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPending(false);
  };

  return (
    <MessagePage
      title={`Join ${roomName}`}
      description="You've been invited to work in this Atelier room."
    >
      <Button disabled={pending} onClick={() => void join()}>
        Join {roomName}
      </Button>
      {error ? (
        <p className="text-destructive-foreground w-full text-sm">{error}</p>
      ) : null}
    </MessagePage>
  );
}
