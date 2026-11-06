import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useMutation } from 'convex/react';
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, SquareIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { StreamingMarkdown } from '~/components/markdown/StreamingMarkdown';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { formatTime, type Names, type PaneCard, type PaneMessage, type PaneTurn, type ToolItem } from '~/lib/room';
import { cn } from '~/lib/utils';
import { errorText } from './errors';
import { QuestionCard } from './QuestionCard';

interface TurnViewProps {
  roomId: Id<'rooms'>;
  turn: PaneTurn;
  replies: PaneMessage[];
  cards: PaneCard[];
  tools: ToolItem[];
  names: Names;
  offline: boolean;
}

export function TurnView({ roomId, turn, replies, cards, tools, names, offline }: TurnViewProps) {
  const agentName = names(turn.participantId);
  const active = turn.status === 'queued' || turn.status === 'running';
  const streamed = streamedText(turn.partialText, replies);

  return (
    <article aria-label={`${agentName}'s turn`} className="space-y-2">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{agentName}</span>
        {turn.requestedByParticipantIds.length > 0 ? (
          <span>for {turn.requestedByParticipantIds.map((id) => names(id)).join(', ')}</span>
        ) : null}
        <span>{formatTime(turn.at)}</span>
        <TurnStatus turn={turn} names={names} />
        {active ? <StopButton turnId={turn.id} agentName={agentName} /> : null}
      </header>
      {tools.length > 0 ? <ToolActivity items={tools} defaultOpen={active} /> : null}
      {streamed ? (
        <StreamingMarkdown
          text={streamed}
          streaming={turn.status === 'running'}
          className={cn(replies.length > 0 && 'text-muted-foreground')}
        />
      ) : turn.status === 'running' && !turn.waitingOnHandId && tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">Thinking…</p>
      ) : null}
      {replies.map((reply) => (
        <StreamingMarkdown key={reply.id} text={reply.body} />
      ))}
      {turn.waitingOnHandId ? (
        <p className="text-sm text-info-foreground">Waiting for an answer to the question card below.</p>
      ) : null}
      {turn.error && (turn.status === 'failed' || turn.status === 'interrupted') ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive-foreground">
          <CircleAlertIcon className="size-3.5" />
          {turn.error}
        </p>
      ) : null}
      {cards.map((card) => (
        <QuestionCard key={card.id} roomId={roomId} card={card} agentName={agentName} names={names} offline={offline} />
      ))}
    </article>
  );
}

/**
 * The text streamed during the turn. When it ends with the final answer, only
 * the part before it is shown, so the answer isn't repeated.
 */
function streamedText(partialText: string, replies: PaneMessage[]) {
  let text = partialText.trim();
  for (const reply of replies) {
    const answer = reply.body.trim();
    if (answer && text.endsWith(answer)) text = text.slice(0, -answer.length).trim();
  }
  return text;
}

function TurnStatus({ turn, names }: { turn: PaneTurn; names: Names }) {
  switch (turn.status) {
    case 'queued':
      return <Badge variant="secondary">Starting</Badge>;
    case 'running':
      return turn.waitingOnHandId ? (
        <Badge variant="info">Waiting on you</Badge>
      ) : (
        <Badge variant="info">
          <Spinner size="xs" />
          Working
        </Badge>
      );
    case 'done':
      return null;
    case 'failed':
      return <Badge variant="error">Failed</Badge>;
    case 'interrupted':
      return <Badge variant="warning">{turn.stoppedByParticipantId ? `Stopped by ${names(turn.stoppedByParticipantId)}` : 'Interrupted'}</Badge>;
  }
}

function StopButton({ turnId, agentName }: { turnId: Id<'turns'>; agentName: string }) {
  const cancel = useMutation(api.messages.cancel);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        aria-label={`Stop ${agentName}`}
        onClick={() => {
          setError(null);
          cancel({ turnId }).catch((e: unknown) => setError(errorText(e)));
        }}
      >
        <SquareIcon className="size-3" />
        Stop
      </Button>
      {error ? <span className="text-destructive-foreground">{error}</span> : null}
    </>
  );
}

function ToolActivity({ items, defaultOpen }: { items: ToolItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <WrenchIcon className="size-3" />
        {items.length} tool {items.length === 1 ? 'call' : 'calls'}
      </button>
      {open ? (
        <ul className="mt-1 space-y-0.5 border-l pl-3">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-1.5">
              {item.ok === null ? (
                <Spinner size="xs" tone="muted" />
              ) : item.ok ? (
                <CheckIcon className="size-3 text-success-foreground" />
              ) : (
                <CircleAlertIcon className="size-3 text-destructive-foreground" />
              )}
              <span className="font-medium">{item.name}</span>
              <span className="truncate font-mono text-muted-foreground">{item.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
