import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useQuery } from "convex/react";
import { BotIcon, MessagesSquareIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { DocumentPane } from "~/components/document/DocumentPane";
import { PageSpinner } from "~/components/page";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import {
  agentAttention,
  isOffline,
  namesFrom,
  readPanels,
  unreadTeamCount,
  useLastDefined,
  useMediaQuery,
  useNow,
  useTeamSeen,
  withLive,
  writePanels,
} from "~/lib/room";
import type { SidePanels } from "~/lib/room";

import { AgentPane } from "./AgentPane";
import { MembersSheet } from "./MembersSheet";
import { RoomHeader } from "./RoomHeader";
import { FoldablePane } from "./SidePanel";
import { TeamPane } from "./TeamPane";

const AGENT_MIN = 300;

const AGENT_DEFAULT = 400;

const TEAM_MIN = 260;

const TEAM_DEFAULT = 340;

// Turns per page of agent history; matches PANE_PAGE in the backend.
const PANE_PAGE = 40;

export const RoomView = ({
  roomId,
  isOwner,
}: {
  roomId: Id<"rooms">;
  isOwner: boolean;
}) => {
  const data = useQuery(api.rooms.get, { roomId });
  const me = useQuery(api.me.get, {});
  const teamMessages = useQuery(api.team.list, { roomId });
  const [paneLimit, setPaneLimit] = useState(PANE_PAGE);
  // Keeps the shorter history on screen while a longer one loads.
  const history = useLastDefined(
    useQuery(api.agent.pane, { limit: paneLimit, roomId })
  );
  const live = useQuery(api.agent.live, { roomId });
  const pane = useMemo(
    () => (history ? withLive(history, live) : undefined),
    [history, live]
  );
  // Ticks so the offline banner appears when heartbeats stop, with no new data.
  const now = useNow(5000);
  const narrow = useMediaQuery("(max-width: 759px)");
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
  const teamSeen = useTeamSeen(roomId, teamMessages?.length, teamVisible);

  if (data === undefined) {
    return <PageSpinner />;
  }
  if (data === null) {
    return null;
  }

  const names = namesFrom(data.participants);
  const offline = pane ? isOffline(pane, now) : false;
  const meId =
    me?.signedIn === true
      ? (data.participants.find((p) => p.userId === me.userId)?._id ?? null)
      : null;
  const attention = pane ? agentAttention(pane) : null;
  const unread =
    teamVisible || !teamMessages
      ? 0
      : unreadTeamCount(teamMessages, teamSeen, meId);
  const unreadText = unread > 0 ? `${unread} unread` : null;

  const setPanel = (which: keyof SidePanels, open: boolean) => {
    const next = { ...panels, [which]: open };
    setPanels(next);
    writePanels(roomId, next);
  };

  // Wide windows fold a panel away; narrow ones show it as a sheet instead.
  const collapse = (which: keyof SidePanels) =>
    narrow
      ? undefined
      : () => {
          setPanel(which, false);
        };
  const openSheet = (setOpen: (open: boolean) => void) =>
    narrow
      ? () => {
          setOpen(true);
        }
      : undefined;

  const agent =
    pane === undefined ? (
      <PageSpinner />
    ) : (
      <AgentPane
        roomId={roomId}
        pane={pane}
        names={names}
        offline={offline}
        onShowEarlier={() => {
          setPaneLimit((n) => n + PANE_PAGE);
        }}
        onCollapse={collapse("agent")}
      />
    );
  const team = (
    <TeamPane roomId={roomId} names={names} onCollapse={collapse("team")} />
  );

  return (
    <div className="flex h-full flex-col">
      <RoomHeader
        roomId={roomId}
        name={data.room.name}
        isOwner={isOwner}
        editsEnabled={pane?.editsEnabled}
        offline={offline}
        onOpenMembers={() => {
          setMembersOpen(true);
        }}
        onOpenAgents={openSheet(setAgentSheetOpen)}
        agentBadge={attention}
        onOpenTeam={openSheet(setTeamSheetOpen)}
        teamBadge={unreadText}
      />
      <div ref={layoutRef} className="flex min-h-0 flex-1">
        {narrow ? null : (
          <FoldablePane
            side="left"
            open={panels.agent}
            width={agentWidth}
            min={AGENT_MIN}
            layoutRef={layoutRef}
            onWidth={setAgentWidth}
            separatorLabel="Resize agent pane"
            handleLabel="Show agents"
            handleIcon={BotIcon}
            badge={attention}
            onOpen={() => {
              setPanel("agent", true);
            }}
          >
            {agent}
          </FoldablePane>
        )}
        <main className="min-w-0 flex-1">
          <DocumentPane
            roomId={roomId}
            names={names}
            meId={meId}
            models={data.participants.filter((p) => p.kind === "harness")}
            isOwner={isOwner}
          />
        </main>
        {narrow ? (
          <>
            <Sheet open={agentSheetOpen} onOpenChange={setAgentSheetOpen}>
              <SheetPopup
                side="left"
                keepMounted
                className="w-[min(92vw,28rem)]"
              >
                {agent}
              </SheetPopup>
            </Sheet>
            <Sheet open={teamSheetOpen} onOpenChange={setTeamSheetOpen}>
              <SheetPopup
                side="right"
                keepMounted
                className="w-[min(88vw,24rem)]"
              >
                {team}
              </SheetPopup>
            </Sheet>
          </>
        ) : (
          <FoldablePane
            side="right"
            open={panels.team}
            width={teamWidth}
            min={TEAM_MIN}
            layoutRef={layoutRef}
            onWidth={setTeamWidth}
            separatorLabel="Resize team pane"
            handleLabel="Show team chat"
            handleIcon={MessagesSquareIcon}
            badge={unreadText}
            onOpen={() => {
              setPanel("team", true);
            }}
          >
            {team}
          </FoldablePane>
        )}
      </div>
      {isOwner ? (
        <MembersSheet
          roomId={roomId}
          participants={data.participants}
          open={membersOpen}
          onOpenChange={setMembersOpen}
        />
      ) : null}
    </div>
  );
};
