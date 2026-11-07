import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { useQuery } from 'convex/react';
import { BotIcon, MessagesSquareIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { DocumentPane } from '~/components/document/DocumentPane';
import { PageSpinner } from '~/components/page';
import { Badge } from '~/components/ui/badge';
import { Sheet, SheetPopup } from '~/components/ui/sheet';
import {
  agentAttention,
  isOffline,
  namesFrom,
  readPanels,
  readTeamSeen,
  unreadTeamCount,
  useLastDefined,
  useMediaQuery,
  useNow,
  withLive,
  writePanels,
  writeTeamSeen,
  type SidePanels,
} from '~/lib/room';
import { AgentPane } from './AgentPane';
import { MembersSheet } from './MembersSheet';
import { RoomHeader } from './RoomHeader';
import { TeamPane } from './TeamPane';

const AGENT_MIN = 300;
const AGENT_DEFAULT = 400;
const TEAM_MIN = 260;
const TEAM_DEFAULT = 340;
// Either side panel may take at most this share of the room's width.
const PANEL_MAX_SHARE = 0.4;
// Turns per page of agent history; matches PANE_PAGE in the backend.
const PANE_PAGE = 40;

export function RoomView({ roomId, isOwner }: { roomId: Id<'rooms'>; isOwner: boolean }) {
  const data = useQuery(api.rooms.get, { roomId });
  const me = useQuery(api.me.get, {});
  const teamMessages = useQuery(api.team.list, { roomId });
  const [paneLimit, setPaneLimit] = useState(PANE_PAGE);
  // Keeps the shorter history on screen while a longer one loads.
  const history = useLastDefined(useQuery(api.agent.pane, { roomId, limit: paneLimit }));
  const live = useQuery(api.agent.live, { roomId });
  const pane = useMemo(() => (history ? withLive(history, live) : undefined), [history, live]);
  // Ticks so the offline banner appears when heartbeats stop, with no new data.
  const now = useNow(5_000);
  const narrow = useMediaQuery('(max-width: 759px)');
  const [membersOpen, setMembersOpen] = useState(false);
  // Wide windows show the side panels beside the document, open as last left
  // in this room. Narrow windows show them as sheets, closed until asked for.
  const [panels, setPanels] = useState(() => readPanels(roomId));
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [teamSheetOpen, setTeamSheetOpen] = useState(false);
  const [agentWidth, setAgentWidth] = useState(AGENT_DEFAULT);
  const [teamWidth, setTeamWidth] = useState(TEAM_DEFAULT);
  const layoutRef = useRef<HTMLDivElement>(null);

  const teamVisible = narrow ? teamSheetOpen : panels.team;
  const [teamSeen, setTeamSeen] = useState(() => readTeamSeen(roomId));
  const teamCount = teamMessages?.length;
  useEffect(() => {
    if (!teamVisible || teamCount === undefined) return;
    setTeamSeen(teamCount);
    writeTeamSeen(roomId, teamCount);
  }, [roomId, teamVisible, teamCount]);

  if (data === undefined) return <PageSpinner />;
  if (data === null) return null;

  const names = namesFrom(data.participants);
  const offline = pane ? isOffline(pane, now) : false;
  const userId = me?.signedIn ? me.userId : null;
  const meId = (userId && data.participants.find((p) => p.userId === userId)?._id) || null;
  const attention = pane ? agentAttention(pane) : null;
  const unread = teamVisible || !teamMessages ? 0 : unreadTeamCount(teamMessages, teamSeen, meId);
  const unreadText = unread ? `${unread} unread` : null;

  const setPanel = (which: keyof SidePanels, open: boolean) => {
    const next = { ...panels, [which]: open };
    setPanels(next);
    writePanels(roomId, next);
  };

  const agent =
    pane === undefined ? (
      <PageSpinner />
    ) : (
      <AgentPane
        roomId={roomId}
        pane={pane}
        names={names}
        offline={offline}
        onShowEarlier={() => setPaneLimit((n) => n + PANE_PAGE)}
        onCollapse={narrow ? undefined : () => setPanel('agent', false)}
      />
    );
  const team = <TeamPane roomId={roomId} names={names} onCollapse={narrow ? undefined : () => setPanel('team', false)} />;

  return (
    <div className="flex h-full flex-col">
      <RoomHeader
        roomId={roomId}
        name={data.room.name}
        isOwner={isOwner}
        editsEnabled={pane?.editsEnabled}
        offline={offline}
        onOpenMembers={() => setMembersOpen(true)}
        onOpenAgents={narrow ? () => setAgentSheetOpen(true) : undefined}
        agentBadge={attention}
        onOpenTeam={narrow ? () => setTeamSheetOpen(true) : undefined}
        teamBadge={unreadText}
      />
      <div ref={layoutRef} className="flex min-h-0 flex-1">
        {narrow ? null : (
          <>
            {panels.agent ? null : (
              <PanelHandle side="left" label="Show agents" icon={BotIcon} badge={attention} onClick={() => setPanel('agent', true)} />
            )}
            <aside hidden={!panels.agent} className="shrink-0 bg-card/40" style={{ width: agentWidth }}>
              {agent}
            </aside>
            {panels.agent ? (
              <PanelSeparator
                label="Resize agent pane"
                side="left"
                width={agentWidth}
                min={AGENT_MIN}
                layoutRef={layoutRef}
                onWidth={setAgentWidth}
              />
            ) : null}
          </>
        )}
        <main className="min-w-0 flex-1">
          <DocumentPane roomId={roomId} names={names} meId={meId} />
        </main>
        {narrow ? (
          <>
            <Sheet open={agentSheetOpen} onOpenChange={setAgentSheetOpen}>
              <SheetPopup side="left" keepMounted className="w-[min(92vw,28rem)]">
                {agent}
              </SheetPopup>
            </Sheet>
            <Sheet open={teamSheetOpen} onOpenChange={setTeamSheetOpen}>
              <SheetPopup side="right" keepMounted className="w-[min(88vw,24rem)]">
                {team}
              </SheetPopup>
            </Sheet>
          </>
        ) : (
          <>
            {panels.team ? (
              <PanelSeparator
                label="Resize team pane"
                side="right"
                width={teamWidth}
                min={TEAM_MIN}
                layoutRef={layoutRef}
                onWidth={setTeamWidth}
              />
            ) : null}
            <aside hidden={!panels.team} className="shrink-0 bg-card/40" style={{ width: teamWidth }}>
              {team}
            </aside>
            {panels.team ? null : (
              <PanelHandle
                side="right"
                label="Show team chat"
                icon={MessagesSquareIcon}
                badge={unreadText}
                onClick={() => setPanel('team', true)}
              />
            )}
          </>
        )}
      </div>
      {isOwner ? (
        <MembersSheet roomId={roomId} participants={data.participants} open={membersOpen} onOpenChange={setMembersOpen} />
      ) : null}
    </div>
  );
}

/** A folded side panel: a narrow strip that opens it, flagging what is waiting there. */
function PanelHandle({
  side,
  label,
  icon: Icon,
  badge,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  icon: LucideIcon;
  badge: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={badge ? `${label}: ${badge}` : label}
      title={label}
      className={`flex w-10 shrink-0 cursor-pointer flex-col items-center gap-2 bg-card/40 py-3 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent ${side === 'left' ? 'border-r' : 'border-l'}`}
      onClick={onClick}
    >
      <Icon className="size-4" />
      {badge ? (
        <Badge variant="info" className="[writing-mode:vertical-rl]">
          {badge}
        </Badge>
      ) : null}
    </button>
  );
}

/** Drag or arrow keys resize the side panel on `side` of the document. */
function PanelSeparator({
  label,
  side,
  width,
  min,
  layoutRef,
  onWidth,
}: {
  label: string;
  side: 'left' | 'right';
  width: number;
  min: number;
  layoutRef: RefObject<HTMLDivElement | null>;
  onWidth: (update: (width: number) => number) => void;
}) {
  const clamp = (next: number) => {
    const box = layoutRef.current?.getBoundingClientRect();
    const max = box && box.width > 0 ? box.width * PANEL_MAX_SHARE : Infinity;
    return Math.round(Math.max(min, Math.min(next, Math.max(min, max))));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = layoutRef.current?.getBoundingClientRect();
    if (!box) return;
    const next = side === 'left' ? e.clientX - box.left : box.right - e.clientX;
    onWidth(() => clamp(next));
  };
  // Arrow keys move the separator the way they point.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 24 : e.key === 'ArrowLeft' ? -24 : 0;
    if (step) onWidth((w) => clamp(w + (side === 'left' ? step : -step)));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      className={`w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent focus-visible:bg-accent ${side === 'left' ? 'border-r' : 'border-l'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
}
