import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import type { PaneAgent } from '~/lib/room';
import { cn } from '~/lib/utils';
import { errorText } from './errors';

interface AgentComposerProps {
  roomId: Id<'rooms'>;
  agents: PaneAgent[];
  target: PaneAgent | null;
  onPickTarget: (participantId: Id<'participants'>) => void;
  onSent: (participantId: Id<'participants'>) => void;
  offline: boolean;
}

/**
 * Writes to one agent. A busy agent queues the message; "Send and steer now"
 * puts it into the running turn instead. Enter sends only from this box.
 */
export function AgentComposer({ roomId, agents, target, onPickTarget, onSent, offline }: AgentComposerProps) {
  const send = useMutation(api.messages.send);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!target) {
    return <p className="text-sm text-muted-foreground">This room has no agents.</p>;
  }

  const working = target.status === 'running';
  const canSend = draft.trim().length > 0 && !busy && !offline;

  const submit = async (steerNow: boolean) => {
    const body = draft.trim();
    if (!body || busy || offline) return;
    const to = target.participantId;
    setBusy(true);
    setError(null);
    try {
      await send(steerNow ? { roomId, body, toParticipantId: to, steer: true } : { roomId, body, toParticipantId: to });
      setDraft('');
      onSent(to);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit(false);
  };

  return (
    <div className="space-y-2">
      {agents.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" role="group" aria-label="Send to">
          <span className="mr-1">To</span>
          {agents.map((agent) => (
            <Button
              key={agent.participantId}
              size="xs"
              variant={agent.participantId === target.participantId ? 'secondary' : 'ghost'}
              aria-pressed={agent.participantId === target.participantId}
              onClick={() => onPickTarget(agent.participantId)}
            >
              {agent.displayName}
            </Button>
          ))}
        </div>
      ) : null}
      {target.status === 'waiting' ? (
        <p className="text-xs text-info-foreground">
          {target.displayName} is waiting on a question card. Sending a message answers it in chat.
        </p>
      ) : null}
      <Textarea
        aria-label={`To ${target.displayName}`}
        placeholder={`To ${target.displayName}`}
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {error ? <p className={cn('mr-auto text-xs text-destructive-foreground')}>{error}</p> : null}
        {working ? (
          <Button size="sm" variant="outline" disabled={!canSend} onClick={() => void submit(true)}>
            Send and steer now
          </Button>
        ) : null}
        <Button size="sm" disabled={!canSend} onClick={() => void submit(false)}>
          Send
        </Button>
      </div>
    </div>
  );
}
