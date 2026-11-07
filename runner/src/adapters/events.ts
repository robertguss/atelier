import { once } from "node:events";

import type {
  HarnessEvent,
  QuestionAnswer,
  QuestionCard,
  SteerOutcome,
  TurnInput,
} from "@atelier/shared";

export const eventQueue = <T = HarnessEvent>() => {
  const queue: T[] = [];
  const wake = new EventTarget();
  let ended = false;
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          // Yields exactly the oldest event, leaving later ones queued.
          yield* queue.splice(0, 1);
        } else if (ended) {
          return;
        } else {
          // oxlint-disable-next-line no-await-in-loop -- the iterator must wait for the next push before it can yield again
          await once(wake, "wake");
        }
      }
    },
    end() {
      ended = true;
      wake.dispatchEvent(new Event("wake"));
    },
    push(event: T) {
      queue.push(event);
      wake.dispatchEvent(new Event("wake"));
    },
  };
};

// A turn's input channel before its adapter installs its own handlers: steers
// are rejected and settings changes wait for the next turn.
export const turnInput = (
  onQuestion: (card: QuestionCard) => Promise<QuestionAnswer> = async () =>
    await Promise.reject(new Error("No one can answer questions here"))
): TurnInput => ({
  onQuestion,
  setEditsEnabled: () => {
    // Settings changes wait for the next turn.
  },
  steer: async () => await Promise.resolve<SteerOutcome>("rejected"),
});
