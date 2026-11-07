import type { HarnessEvent, QuestionAnswer, QuestionCard, TurnInput } from '@atelier/shared';
export function eventQueue<T = HarnessEvent>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(event: T) { queue.push(event); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}

// A turn's input channel before its adapter installs its own handlers: steers
// are rejected and settings changes wait for the next turn.
export function turnInput(
  onQuestion: (card: QuestionCard) => Promise<QuestionAnswer> = async () => { throw new Error('No one can answer questions here'); },
): TurnInput {
  return { onQuestion, steer: async () => 'rejected', setEditsEnabled: () => {} };
}
