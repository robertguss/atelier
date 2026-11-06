import { api } from "@atelier/backend/api";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { isWaiting, type Names, type Pane } from "~/lib/room";

import { errorText } from "./errors";

/**
 * Messages waiting for their agent's turn to end, in send order, each with
 * "Steer now" to put it into the running turn instead. A steer the harness
 * rejects comes back here as queued, marked so people know it didn't land.
 */
export function QueueStrip({
  pane,
  names,
  offline,
}: {
  pane: Pane;
  names: Names;
  offline: boolean;
}) {
  const steer = useMutation(api.agent.steer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Messages this tab has seen being steered. One that is queued again was rejected.
  const seenSteering = useRef(new Set<string>());
  const waiting = pane.messages.filter(isWaiting).sort((a, b) => a.at - b.at);
  for (const m of waiting)
    if (m.delivery === "steering") seenSteering.current.add(m.id);
  if (waiting.length === 0) return null;

  const steerNow = async (messageId: (typeof waiting)[number]["id"]) => {
    setErrors(({ [messageId]: _, ...rest }) => rest);
    try {
      await steer({ messageId });
    } catch (e) {
      setErrors((all) => ({ ...all, [messageId]: errorText(e) }));
    }
  };

  return (
    <ul aria-label="Queued messages" className="space-y-1.5">
      {waiting.map((m) => {
        const rejected =
          m.delivery === "queued" && seenSteering.current.has(m.id);
        return (
          <li
            key={m.id}
            className="bg-muted/50 flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="text-muted-foreground text-xs">
                <span>
                  {names(m.authorParticipantId)} → {names(m.toParticipantId)}
                </span>
                <span>
                  {" "}
                  ·{" "}
                  {m.delivery === "steering"
                    ? "Steering…"
                    : "Queued until the turn ends"}
                </span>
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap">{m.body}</p>
              {rejected ? (
                <p className="text-warning-foreground text-xs">
                  Couldn't steer into the running turn, so it's still queued.
                </p>
              ) : null}
              {errors[m.id] ? (
                <p className="text-destructive-foreground text-xs">
                  {errors[m.id]}
                </p>
              ) : null}
            </div>
            {m.delivery === "queued" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={offline}
                onClick={() => void steerNow(m.id)}
              >
                Steer now
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
