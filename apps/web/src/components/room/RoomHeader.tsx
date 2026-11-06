import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import {
  ChevronLeftIcon,
  MessagesSquareIcon,
  UsersIcon,
  WifiOffIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";

import { errorText } from "./errors";

interface RoomHeaderProps {
  roomId: Id<"rooms">;
  name: string;
  isOwner: boolean;
  /** Undefined until the agent pane has loaded. */
  editsEnabled: boolean | undefined;
  offline: boolean;
  onOpenMembers: () => void;
  /** Shown in narrow windows, where the team pane is a sheet. */
  onOpenTeam?: () => void;
}

export function RoomHeader({
  roomId,
  name,
  isOwner,
  editsEnabled,
  offline,
  onOpenMembers,
  onOpenTeam,
}: RoomHeaderProps) {
  return (
    <div className="shrink-0">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Your rooms"
          render={<Link to="/" />}
        >
          <ChevronLeftIcon />
        </Button>
        <h1 className="mr-auto truncate text-base font-medium tracking-tight">
          {name}
        </h1>
        {editsEnabled === undefined ? null : (
          <EditSwitch roomId={roomId} on={editsEnabled} isOwner={isOwner} />
        )}
        {isOwner ? (
          <Button size="sm" variant="outline" onClick={onOpenMembers}>
            <UsersIcon />
            Members
          </Button>
        ) : null}
        {onOpenTeam ? (
          <Button size="sm" variant="outline" onClick={onOpenTeam}>
            <MessagesSquareIcon />
            Team chat
          </Button>
        ) : null}
      </header>
      {offline ? (
        <div
          role="alert"
          className="bg-warning-surface text-warning-foreground flex items-center gap-2 border-b px-4 py-2 text-sm"
        >
          <WifiOffIcon className="size-4 shrink-0" />
          The agents' machine is offline: no heartbeat for over 45 seconds.
          Messages to agents are refused until it's back. Team chat still works.
        </div>
      ) : null}
    </div>
  );
}

/** "Agents may edit files in this folder": the owner's toggle; everyone else sees its state. */
function EditSwitch({
  roomId,
  on,
  isOwner,
}: {
  roomId: Id<"rooms">;
  on: boolean;
  isOwner: boolean;
}) {
  const setEditsEnabled = useMutation(api.rooms.setEditsEnabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <label
      className="text-muted-foreground flex items-center gap-2 text-xs"
      title={error ?? undefined}
    >
      <Switch
        size="sm"
        aria-label="Agents may edit files in this folder"
        checked={on}
        disabled={!isOwner}
        onCheckedChange={(next) => {
          setError(null);
          setEditsEnabled({ on: next, roomId }).catch((error_: unknown) => {
            setError(errorText(error_));
          });
        }}
      />
      <span>
        Agents may edit files:{" "}
        <span className="text-foreground font-medium">{on ? "on" : "off"}</span>
      </span>
      {error ? (
        <span className="text-destructive-foreground">{error}</span>
      ) : null}
    </label>
  );
}
