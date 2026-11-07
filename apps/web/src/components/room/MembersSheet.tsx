import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useAction, useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { CopyIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from '~/components/ui/sheet';
import { Spinner } from '~/components/ui/spinner';
import type { Participant } from '~/lib/room';
import { errorText } from './errors';

const HARNESSES = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'pi', name: 'Pi' },
] as const;

interface MembersSheetProps {
  roomId: Id<'rooms'>;
  participants: Participant[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SentInvite {
  email: string;
  url: string;
  emailed: boolean;
}

export function MembersSheet({ roomId, participants, open, onOpenChange }: MembersSheetProps) {
  // The invite link can't be fetched again, so it outlives the panel until the next invite.
  const [sent, setSent] = useState<SentInvite | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Members</SheetTitle>
          <SheetDescription>Only you can invite or remove people and choose the room's agents.</SheetDescription>
        </SheetHeader>
        {open ? <MembersPanel roomId={roomId} participants={participants} sent={sent} onSent={setSent} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

interface MembersPanelProps {
  roomId: Id<'rooms'>;
  participants: Participant[];
  sent: SentInvite | null;
  onSent: (sent: SentInvite) => void;
}

function MembersPanel({ roomId, participants, sent, onSent }: MembersPanelProps) {
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
}

function InviteForm({ roomId, sent, onSent }: { roomId: Id<'rooms'>; sent: SentInvite | null; onSent: (sent: SentInvite) => void }) {
  const create = useAction(api.invites.create);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const result = await create({ roomId, email: address });
      onSent({ email: address, url: result.url, emailed: result.emailed });
      setEmail('');
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  return (
    <section className="space-y-2">
      <h3 className="font-medium">Invite someone</h3>
      <form className="flex gap-2" onSubmit={(e) => void submit(e)}>
        <Input aria-label="Email" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" size="sm" disabled={!email.trim() || busy}>
          Invite
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      {sent ? (
        <div className="space-y-1.5 rounded-lg border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            Send {sent.email} this link. It works once, for that address, for 7 days.
            {sent.emailed ? ' They have no account yet, so they were also emailed a sign-up invitation.' : null}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs">{sent.url}</code>
            <Button size="icon-xs" variant="ghost" aria-label="Copy invite link" onClick={() => void navigator.clipboard?.writeText(sent.url)}>
              <CopyIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type MembersList = FunctionReturnType<typeof api.members.list>;

function MemberRow({ member }: { member: MembersList['members'][number] }) {
  const remove = useMutation(api.members.remove);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = member.displayName ?? member.email ?? 'Member';
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {member.email && member.email !== label ? <div className="text-xs text-muted-foreground">{member.email}</div> : null}
        {error ? <div className="text-xs text-destructive-foreground">{error}</div> : null}
      </div>
      {member.role === 'owner' ? (
        <Badge variant="secondary">Owner</Badge>
      ) : confirming ? (
        <>
          <Button
            size="xs"
            variant="destructive"
            onClick={() => remove({ memberId: member._id }).catch((e: unknown) => setError(errorText(e)))}
          >
            Remove {label}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
    </li>
  );
}

function InviteRow({ invite }: { invite: MembersList['invites'][number] }) {
  const revoke = useAction(api.invites.revoke);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div>{invite.email}</div>
        <div className="text-xs text-muted-foreground">
          {invite.expired ? 'Expired' : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
        </div>
        {error ? <div className="text-xs text-destructive-foreground">{error}</div> : null}
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          revoke({ inviteId: invite._id })
            .catch((e: unknown) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        Revoke
      </Button>
    </li>
  );
}

function AgentsSection({ roomId, participants }: { roomId: Id<'rooms'>; participants: Participant[] }) {
  const addParticipant = useMutation(api.rooms.addParticipant);
  const [error, setError] = useState<string | null>(null);
  const present = new Set(participants.filter((p) => p.kind === 'harness').map((p) => p.harness));
  const missing = HARNESSES.filter((h) => !present.has(h.id));
  return (
    <section className="space-y-2">
      <h3 className="font-medium">Agents</h3>
      <p className="text-muted-foreground">
        {HARNESSES.filter((h) => present.has(h.id))
          .map((h) => h.name)
          .join(', ') || 'No agents yet.'}
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
                addParticipant({ roomId, harness: h.id }).catch((e: unknown) => setError(errorText(e)));
              }}
            >
              Add {h.name}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </section>
  );
}
