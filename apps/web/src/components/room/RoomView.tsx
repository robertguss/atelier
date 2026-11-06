import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import { PageSpinner } from "~/components/page";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import {
  isOffline,
  namesFrom,
  useLastDefined,
  useMediaQuery,
  useNow,
  withLive,
} from "~/lib/room";

import { AgentPane } from "./AgentPane";
import { MembersSheet } from "./MembersSheet";
import { RoomHeader } from "./RoomHeader";
import { TeamPane } from "./TeamPane";

const TEAM_MIN = 260;
const TEAM_DEFAULT = 360;
// Turns per page of agent history; matches PANE_PAGE in the backend.
const PANE_PAGE = 40;

export function RoomView({
  roomId,
  isOwner,
}: {
  roomId: Id<"rooms">;
  isOwner: boolean;
}) {
  const data = useQuery(api.rooms.get, { roomId });
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
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamWidth, setTeamWidth] = useState(TEAM_DEFAULT);
  const layoutRef = useRef<HTMLDivElement>(null);

  if (data === undefined) {
    return <PageSpinner />;
  }
  if (data === null) {
    return null;
  }

  const names = namesFrom(data.participants);
  const offline = pane ? isOffline(pane, now) : false;

  const resizeTo = (clientX: number) => {
    const box = layoutRef.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setTeamWidth(
      Math.round(
        Math.min(Math.max(box.right - clientX, TEAM_MIN), box.width * 0.6)
      )
    );
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      resizeTo(e.clientX);
    }
  };
  const onSeparatorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      setTeamWidth((w) => w + 24);
    }
    if (e.key === "ArrowRight") {
      setTeamWidth((w) => Math.max(TEAM_MIN, w - 24));
    }
  };

  const team = <TeamPane roomId={roomId} names={names} />;

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
        onOpenTeam={
          narrow
            ? () => {
                setTeamOpen(true);
              }
            : undefined
        }
      />
      <div ref={layoutRef} className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {pane === undefined ? (
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
            />
          )}
        </div>
        {narrow ? (
          <Sheet open={teamOpen} onOpenChange={setTeamOpen}>
            <SheetPopup
              side="right"
              keepMounted
              className="w-[min(88vw,24rem)]"
            >
              {team}
            </SheetPopup>
          </Sheet>
        ) : (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize team pane"
              aria-valuenow={teamWidth}
              tabIndex={0}
              className="hover:bg-accent focus-visible:bg-accent w-1 shrink-0 cursor-col-resize border-l bg-transparent"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onKeyDown={onSeparatorKey}
            />
            <aside className="bg-card/40 shrink-0" style={{ width: teamWidth }}>
              {team}
            </aside>
          </>
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
}
