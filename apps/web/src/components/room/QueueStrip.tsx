import { api } from "@atelier/backend/api";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { isWaiting } from "~/lib/room";
import type { Names, Pane } from "~/lib/room";

import { errorText } from "./errors";

/**
 * Messages waiting for their agent's turn to end, in send order, each with
 * "Steer now" to put it into the running turn instead. A steer the harness
 * rejects comes back here as queued, marked so people know it didn't land.
 */
export const QueueStrip = ({
  pane,
  names,
  offline,
}: {
  pane: Pane;
  names: Names;
  offline: boolean;
}) => {
  const steer = useMutation(api.agent.steer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Messages this tab has seen being steered. One that is queued again was rejected.
  const seenSteering = useRef(new Set<string>());
  const steerable = new Set(
    pane.agents.filter((a) => a.takesSteer).map((a) => a.participantId)
  );
  const waiting = pane.messages
    .filter(isWaiting)
    .toSorted((a, b) => a.at - b.at);
  for (const m of waiting) {
    if (m.delivery === "steering") {
      // oxlint-disable-next-line react/refs -- Collects, during render, the messages this tab has seen steering; state would cost an extra render per change.
      seenSteering.current.add(m.id);
    }
  }
  if (waiting.length === 0) {
    return null;
  }

  type MessageId = (typeof waiting)[number]["id"];

  const showError = (messageId: MessageId, error: unknown) => {
    setErrors((all) => ({ ...all, [messageId]: errorText(error) }));
  };

  const steerNow = async (messageId: MessageId) => {
    setErrors((all) =>
      Object.fromEntries(Object.entries(all).filter(([id]) => id !== messageId))
    );
    try {
      await steer({ messageId });
    } catch (error) {
      showError(messageId, error);
    }
  };

  return (
    <ul aria-label="Queued messages" className="space-y-1.5">
      {/* oxlint-disable-next-line react/refs -- Reads the messages collected above, in the same render. */}
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
                  Couldn&apos;t steer into the running turn, so it&apos;s still
                  queued.
                </p>
              ) : null}
              {(errors[m.id] ?? "") === "" ? null : (
                <p className="text-destructive-foreground text-xs">
                  {errors[m.id]}
                </p>
              )}
            </div>
            {m.delivery === "queued" &&
            m.maySteer &&
            m.toParticipantId !== null &&
            steerable.has(m.toParticipantId) ? (
              <Button
                size="xs"
                variant="outline"
                disabled={offline}
                onClick={() => {
                  steerNow(m.id).catch((error_: unknown) => {
                    showError(m.id, error_);
                  });
                }}
              >
                Steer now
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};
