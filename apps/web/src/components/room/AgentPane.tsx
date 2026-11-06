import type { Id } from '@atelier/backend/dataModel';
import { BotIcon } from 'lucide-react';
import { useState } from 'react';
import { StreamingMarkdown } from '~/components/markdown/StreamingMarkdown';
import { Badge } from '~/components/ui/badge';
import { composerTarget } from '~/lib/composerTarget';
import {
  buildTimeline,
  cancelReasonText,
  formatTime,
  readLastTarget,
  toolItemsFor,
  useStickToBottom,
  writeLastTarget,
  type Names,
  type Pane,
  type PaneAgent,
  type PaneMessage,
} from '~/lib/room';
import { AgentComposer } from './AgentComposer';
import { QuestionCard } from './QuestionCard';
import { QueueStrip } from './QueueStrip';
import { TurnView } from './TurnView';

interface AgentPaneProps {
  roomId: Id<'rooms'>;
  pane: Pane;
  names: Names;
  offline: boolean;
}

/** The agents' work, live and the same for everyone in the room. */
export function AgentPane({ roomId, pane, names, offline }: AgentPaneProps) {
  const { scrollRef, contentRef } = useStickToBottom<HTMLDivElement, HTMLOListElement>();
  const [picked, setPicked] = useState<Id<'participants'> | null>(null);
  const [lastTarget, setLastTarget] = useState(() => readLastTarget(roomId));

  const openCards = pane.cards.filter((c) => c.status === 'raised');
  const defaultTarget = composerTarget({
    agents: pane.agents,
    openCardAgentIds: openCards.map((c) => c.participantId),
    lastTarget,
  });
  const targetId = picked && pane.agents.some((a) => a.participantId === picked) ? picked : defaultTarget;
  const target = pane.agents.find((a) => a.participantId === targetId) ?? null;
  const timeline = buildTimeline(pane);

  const onSent = (participantId: Id<'participants'>) => {
    writeLastTarget(roomId, participantId);
    setLastTarget(participantId);
    setPicked(null);
  };

  return (
    <section aria-label="Agents" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5">
        <BotIcon className="size-4 text-muted-foreground" />
        <h2 className="mr-1 text-sm font-medium">Agents</h2>
        {pane.agents.map((agent) => (
          <AgentStatus key={agent.participantId} agent={agent} />
        ))}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <ol ref={contentRef} className="mx-auto max-w-3xl space-y-5 px-4 py-4">
          {timeline.length === 0 ? (
            <li className="py-6 text-center text-sm text-muted-foreground">Nothing here yet. Ask an agent to get started.</li>
          ) : (
            timeline.map((item) => (
              <li key={item.key}>
                {item.kind === 'turn' ? (
                  <TurnView
                    roomId={roomId}
                    turn={item.turn}
                    replies={item.replies}
                    cards={item.cards}
                    tools={toolItemsFor(pane, item.turn)}
                    names={names}
                    offline={offline}
                  />
                ) : (
                  <MessageRow message={item.message} names={names} />
                )}
              </li>
            ))
          )}
        </ol>
      </div>
      <div className="max-h-[65%] shrink-0 overflow-y-auto border-t">
        <div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-3">
          {openCards.map((card) => (
            <QuestionCard
              key={card.id}
              roomId={roomId}
              card={card}
              agentName={names(card.participantId)}
              names={names}
              offline={offline}
            />
          ))}
          <QueueStrip pane={pane} names={names} offline={offline} />
          <AgentComposer
            roomId={roomId}
            agents={pane.agents}
            target={target}
            onPickTarget={setPicked}
            onSent={onSent}
            offline={offline}
          />
        </div>
      </div>
    </section>
  );
}

const STATUS_TEXT: Record<PaneAgent['status'], string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Working',
  waiting: 'Waiting on you',
};

function AgentStatus({ agent }: { agent: PaneAgent }) {
  return (
    <span className="flex items-center gap-1">
      <Badge variant={agent.status === 'idle' ? 'outline' : 'info'}>
        {agent.displayName}: {STATUS_TEXT[agent.status]}
      </Badge>
      {agent.queued > 0 ? <Badge variant="secondary">{agent.queued} queued</Badge> : null}
      {agent.canRaiseCards === false ? (
        <Badge variant="outline" title="It asks its questions in plain text instead">
          {agent.displayName} can't raise question cards
        </Badge>
      ) : null}
    </span>
  );
}

/** A person's message to an agent, or an agent reply whose turn isn't shown. */
function MessageRow({ message, names }: { message: PaneMessage; names: Names }) {
  const author = names(message.authorParticipantId);
  if (message.turnId) {
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">{author}</div>
        <StreamingMarkdown text={message.body} />
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-secondary px-3 py-2 text-sm">
      <div className="mb-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {message.toParticipantId ? `${author} → ${names(message.toParticipantId)}` : author}
        </span>
        <span>{formatTime(message.at)}</span>
        <DeliveryNote message={message} />
      </div>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
    </div>
  );
}

function DeliveryNote({ message }: { message: PaneMessage }) {
  switch (message.delivery) {
    case 'steered':
      return <span>Steered into the running turn</span>;
    case 'answeredCard':
      return <span>Answered the question card</span>;
    case 'cancelled':
      return <span className="text-warning-foreground">Not delivered: {cancelReasonText(message.cancelReason)}</span>;
    default:
      return null;
  }
}
