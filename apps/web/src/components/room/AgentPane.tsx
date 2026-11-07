import type { Id } from "@atelier/backend/dataModel";
import { BotIcon, PanelLeftCloseIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { composerTarget } from "~/lib/composerTarget";
import {
  buildTimeline,
  readLastTarget,
  toolItemsFor,
  useStickToBottom,
  writeLastTarget,
} from "~/lib/room";
import type { Names, Pane, PaneAgent } from "~/lib/room";

import { AgentComposer } from "./AgentComposer";
import { MessageRow } from "./MessageRow";
import { QuestionCard } from "./QuestionCard";
import { QueueStrip } from "./QueueStrip";
import { TurnView } from "./TurnView";

interface AgentPaneProps {
  roomId: Id<"rooms">;
  pane: Pane;
  names: Names;
  offline: boolean;
  onShowEarlier: () => void;
  /** Folds the pane away beside the document. */
  onCollapse?: () => void;
}

const STATUS_TEXT: Record<PaneAgent["status"], string> = {
  idle: "Idle",
  running: "Working",
  starting: "Starting",
  waiting: "Waiting on you",
};

const AgentStatus = ({ agent }: { agent: PaneAgent }) => (
  <span className="flex items-center gap-1">
    <Badge variant={agent.status === "idle" ? "outline" : "info"}>
      {agent.displayName}: {STATUS_TEXT[agent.status]}
    </Badge>
    {agent.queued > 0 ? (
      <Badge variant="secondary">{agent.queued} queued</Badge>
    ) : null}
    {agent.canRaiseCards === false ? (
      <Badge
        variant="outline"
        title="It asks its questions in plain text instead"
      >
        {agent.displayName} can&apos;t raise question cards
      </Badge>
    ) : null}
  </span>
);

export const AgentPane = ({
  roomId,
  pane,
  names,
  offline,
  onShowEarlier,
  onCollapse,
}: AgentPaneProps) => {
  const { scrollRef, contentRef, jumpToEnd } = useStickToBottom<
    HTMLDivElement,
    HTMLOListElement
  >();
  const [picked, setPicked] = useState<Id<"participants"> | null>(null);
  const [lastTarget, setLastTarget] = useState(() => readLastTarget(roomId));

  const openCards = pane.cards.filter((c) => c.status === "raised");
  const defaultTarget = composerTarget({
    agents: pane.agents,
    lastTarget,
    openCardAgentIds: openCards.map((c) => c.participantId),
  });
  const targetId =
    picked && pane.agents.some((a) => a.participantId === picked)
      ? picked
      : defaultTarget;
  const target = pane.agents.find((a) => a.participantId === targetId) ?? null;
  const timeline = buildTimeline(pane);

  // Earlier history arrives above what the reader is looking at; keep their
  // place by holding the distance from the bottom.
  const fromBottom = useRef<number | null>(null);
  const firstKey = timeline[0]?.key;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (fromBottom.current === null || !scroller) {
      return;
    }
    scroller.scrollTop = scroller.scrollHeight - fromBottom.current;
    fromBottom.current = null;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- firstKey is the trigger: the effect restores the reader's place once earlier history renders above.
  }, [firstKey, scrollRef]);
  const showEarlier = () => {
    const scroller = scrollRef.current;
    if (scroller) {
      fromBottom.current = scroller.scrollHeight - scroller.scrollTop;
    }
    onShowEarlier();
  };

  const onSent = (participantId: Id<"participants">) => {
    writeLastTarget(roomId, participantId);
    setLastTarget(participantId);
    setPicked(null);
    jumpToEnd();
  };

  return (
    <section aria-label="Agents" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5">
        <BotIcon className="text-muted-foreground size-4" />
        <h2 className="mr-1 text-sm font-medium">Agents</h2>
        {pane.agents.map((agent) => (
          <AgentStatus key={agent.participantId} agent={agent} />
        ))}
        {onCollapse ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="ml-auto"
            aria-label="Hide agents"
            title="Hide agents"
            onClick={onCollapse}
          >
            <PanelLeftCloseIcon />
          </Button>
        ) : null}
      </header>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
      >
        <ol ref={contentRef} className="mx-auto max-w-3xl space-y-5 px-4 py-4">
          {pane.hasOlder ? (
            <li className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={showEarlier}>
                Show earlier
              </Button>
            </li>
          ) : null}
          {timeline.length === 0 ? (
            <li className="text-muted-foreground py-6 text-center text-sm">
              Nothing here yet. Ask an agent to get started.
            </li>
          ) : (
            timeline.map((item) => (
              <li key={item.key}>
                {item.kind === "turn" ? (
                  <TurnView
                    roomId={roomId}
                    turn={item.turn}
                    replies={item.replies}
                    delivered={item.delivered}
                    cards={item.cards}
                    tools={toolItemsFor(item.turn)}
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
};
