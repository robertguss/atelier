import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CopyIcon } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import type { Participant } from "~/lib/room";

import { errorText } from "./errors";

const HARNESSES = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "pi", name: "Pi" },
] as const;

interface MembersSheetProps {
  roomId: Id<"rooms">;
  participants: Participant[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SentInvite {
  email: string;
  url: string;
  emailed: boolean;
}

interface MembersPanelProps {
  roomId: Id<"rooms">;
  participants: Participant[];
  sent: SentInvite | null;
  onSent: (sent: SentInvite) => void;
}

const logCopyFailure = (error: unknown) => {
  console.error("Copying the invite link failed", error);
};

const InviteForm = ({
  roomId,
  sent,
  onSent,
}: {
  roomId: Id<"rooms">;
  sent: SentInvite | null;
  onSent: (sent: SentInvite) => void;
}) => {
  const create = useAction(api.invites.create);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await create({ email: address, roomId });
      onSent({ email: address, emailed: result.emailed, url: result.url });
      setEmail("");
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  const showError = (error_: unknown) => {
    setError(errorText(error_));
  };

  return (
    <section className="space-y-2">
      <h3 className="font-medium">Invite someone</h3>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          submit(e).catch(showError);
        }}
      >
        <Input
          aria-label="Email"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
        <Button type="submit" size="sm" disabled={!email.trim() || busy}>
          Invite
        </Button>
      </form>
      {error !== null && error !== "" ? (
        <p className="text-destructive-foreground text-xs">{error}</p>
      ) : null}
      {sent ? (
        <div className="bg-muted/50 space-y-1.5 rounded-lg border p-3">
          <p className="text-muted-foreground text-xs">
            Send {sent.email} this link. It works once, for that address, for 7
            days.
            {sent.emailed
              ? " They have no account yet, so they were also emailed a sign-up invitation."
              : null}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 text-xs break-all">{sent.url}</code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy invite link"
              onClick={() => {
                navigator.clipboard?.writeText(sent.url).catch(logCopyFailure);
              }}
            >
              <CopyIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

type MembersList = FunctionReturnType<typeof api.members.list>;

const MemberRow = ({ member }: { member: MembersList["members"][number] }) => {
  const remove = useMutation(api.members.remove);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = member.displayName ?? member.email ?? "Member";
  const removeControls = confirming ? (
    <>
      <Button
        size="xs"
        variant="destructive"
        onClick={() => {
          remove({ memberId: member._id }).catch((error_: unknown) => {
            setError(errorText(error_));
          });
        }}
      >
        Remove {label}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Keep
      </Button>
    </>
  ) : (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        setConfirming(true);
      }}
    >
      Remove
    </Button>
  );
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {(member.email ?? "") !== "" && member.email !== label ? (
          <div className="text-muted-foreground text-xs">{member.email}</div>
        ) : null}
        {error !== null && error !== "" ? (
          <div className="text-destructive-foreground text-xs">{error}</div>
        ) : null}
      </div>
      {member.role === "owner" ? (
        <Badge variant="secondary">Owner</Badge>
      ) : (
        removeControls
      )}
    </li>
  );
};

const InviteRow = ({ invite }: { invite: MembersList["invites"][number] }) => {
  const revoke = useAction(api.invites.revoke);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revokeInvite = async () => {
    setBusy(true);
    setError(null);
    try {
      await revoke({ inviteId: invite._id });
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div>{invite.email}</div>
        <div className="text-muted-foreground text-xs">
          {invite.expired
            ? "Expired"
            : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
        </div>
        {error !== null && error !== "" ? (
          <div className="text-destructive-foreground text-xs">{error}</div>
        ) : null}
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          revokeInvite().catch((error_: unknown) => {
            setError(errorText(error_));
          });
        }}
      >
        Revoke
      </Button>
    </li>
  );
};

const AgentsSection = ({
  roomId,
  participants,
}: {
  roomId: Id<"rooms">;
  participants: Participant[];
}) => {
  const addParticipant = useMutation(api.rooms.addParticipant);
  const [error, setError] = useState<string | null>(null);
  const present = new Set(
    participants.filter((p) => p.kind === "harness").map((p) => p.harness)
  );
  const missing = HARNESSES.filter((h) => !present.has(h.id));
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Agents</h3>
      <p className="text-muted-foreground">
        {HARNESSES.filter((h) => present.has(h.id))
          .map((h) => h.name)
          .join(", ") || "No agents yet."}
      </p>
      {missing.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {missing.map((h) => (
            <Button
              key={h.id}
              size="xs"
              variant="outline"
              onClick={() => {
                setError(null);
                addParticipant({ harness: h.id, roomId }).catch(
                  (error_: unknown) => {
                    setError(errorText(error_));
                  }
                );
              }}
            >
              Add {h.name}
            </Button>
          ))}
        </div>
      ) : null}
      {error !== null && error !== "" ? (
        <p className="text-destructive-foreground text-xs">{error}</p>
      ) : null}
    </section>
  );
};

const MembersPanel = ({
  roomId,
  participants,
  sent,
  onSent,
}: MembersPanelProps) => {
  const data = useQuery(api.members.list, { roomId });
  return (
    <div className="space-y-6 px-6 pb-6 text-sm">
      <InviteForm roomId={roomId} sent={sent} onSent={onSent} />
      {data === undefined ? (
        <Spinner size="md" tone="muted" />
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="font-medium">People</h3>
            <ul className="divide-y rounded-lg border">
              {data.members.map((m) => (
                <MemberRow key={m._id} member={m} />
              ))}
            </ul>
          </section>
          {data.invites.length > 0 ? (
            <section className="space-y-2">
              <h3 className="font-medium">Pending invites</h3>
              <ul className="divide-y rounded-lg border">
                {data.invites.map((invite) => (
                  <InviteRow key={invite._id} invite={invite} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <AgentsSection roomId={roomId} participants={participants} />
    </div>
  );
};

export const MembersSheet = ({
  roomId,
  participants,
  open,
  onOpenChange,
}: MembersSheetProps) => {
  // The invite link can't be fetched again, so it outlives the panel until the next invite.
  const [sent, setSent] = useState<SentInvite | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Members</SheetTitle>
          <SheetDescription>
            Only you can invite or remove people and choose the room&apos;s
            agents.
          </SheetDescription>
        </SheetHeader>
        {open ? (
          <MembersPanel
            roomId={roomId}
            participants={participants}
            sent={sent}
            onSent={setSent}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
};
