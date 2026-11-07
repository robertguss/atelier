import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useQuery } from 'convex/react';
import { PanelRightCloseIcon, UsersIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { formatTime, useStickToBottom, type Names } from '~/lib/room';
import { TeamComposer } from './TeamComposer';

/** The humans-only chat. Nothing here ever reaches an agent. */
export function TeamPane({ roomId, names, onCollapse }: { roomId: Id<'rooms'>; names: Names; onCollapse?: () => void }) {
  const messages = useQuery(api.team.list, { roomId });
  const { scrollRef, contentRef } = useStickToBottom<HTMLDivElement, HTMLOListElement>();

  return (
    <section aria-label="Team chat" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <UsersIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Team</h2>
        <span className="text-xs text-muted-foreground">Agents can't see this.</span>
        {onCollapse ? (
          <Button size="icon-xs" variant="ghost-muted" className="ml-auto" aria-label="Hide team chat" title="Hide team chat" onClick={onCollapse}>
            <PanelRightCloseIcon />
          </Button>
        ) : null}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <ol ref={contentRef} className="space-y-3 px-4 py-3">
          {messages === undefined ? (
            <li className="flex justify-center py-6">
              <Spinner size="md" tone="muted" />
            </li>
          ) : messages.length === 0 ? (
            <li className="py-6 text-center text-sm text-muted-foreground">Talk things over here before you answer the agent.</li>
          ) : (
            messages.map((m) => (
              <li key={m._id} className="text-sm">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{names(m.authorParticipantId)}</span> · {formatTime(m.at)}
                </div>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
              </li>
            ))
          )}
        </ol>
      </div>
      <div className="border-t p-3">
        <TeamComposer roomId={roomId} />
      </div>
    </section>
  );
}
