import { describe, expect, it } from "vitest";

import { buildTimeline } from "./room";
import type { Pane } from "./room";

interface Fixture {
  turns?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
}

const turn = (id: string, at: number) => ({
  at,
  endedAt: null,
  error: null,
  id,
  items: [],
  partialText: "",
  participantId: "p-claude",
  requestedByParticipantIds: [],
  startedAt: at,
  status: "running",
  stoppedByParticipantId: null,
  threadId: null,
  waitingOnHandId: null,
});

const message = (
  id: string,
  at: number,
  overrides: Record<string, unknown>
) => ({
  at,
  authorParticipantId: "p-dana",
  body: id,
  cancelReason: null,
  deliveredTurnId: null,
  delivery: "delivered",
  id,
  maySteer: true,
  streamOffset: null,
  toParticipantId: "p-claude",
  turnId: null,
  ...overrides,
});

const paneOf = ({ turns = [], messages = [] }: Fixture) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixtures carry only the fields buildTimeline reads; building Convex ids for the rest would add nothing.
  ({
    agents: [],
    cards: [],
    editsEnabled: false,
    hasOlder: false,
    messages,
    runner: { lastHeartbeatAt: 0, offlineAfterMs: 1 },
    turns,
  }) as unknown as Pane;

const summary = (pane: Pane) =>
  buildTimeline(pane).map((item) =>
    item.kind === "turn"
      ? {
          delivered: item.delivered.map((m) => m.id),
          replies: item.replies.map((m) => m.id),
          turn: item.key,
        }
      : { message: item.key }
  );

describe(buildTimeline, () => {
  it("puts a steered message inside the turn it was steered into", () => {
    expect(
      summary(
        paneOf({
          messages: [
            message("steer", 3000, {
              deliveredTurnId: "t1",
              delivery: "steered",
            }),
            message("answer", 4000, {
              authorParticipantId: "p-claude",
              delivery: null,
              toParticipantId: null,
              turnId: "t1",
            }),
          ],
          turns: [turn("t1", 2000)],
        })
      )
    ).toStrictEqual([
      { delivered: ["steer"], replies: ["answer"], turn: "t1" },
    ]);
  });

  it("puts a chat message that answered a card inside the turn that asked", () => {
    expect(
      summary(
        paneOf({
          messages: [
            message("chat", 3000, {
              deliveredTurnId: "t1",
              delivery: "answeredCard",
            }),
          ],
          turns: [turn("t1", 2000)],
        })
      )
    ).toStrictEqual([{ delivered: ["chat"], replies: [], turn: "t1" }]);
  });

  it("keeps a steered message standalone when its turn is outside the window", () => {
    expect(
      summary(
        paneOf({
          messages: [
            message("steer", 3000, {
              deliveredTurnId: "t0",
              delivery: "steered",
            }),
          ],
          turns: [turn("t1", 4000)],
        })
      )
    ).toStrictEqual([
      { message: "steer" },
      { delivered: [], replies: [], turn: "t1" },
    ]);
  });
});
