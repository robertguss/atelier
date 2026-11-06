import type { HarnessEvent } from '@atelier/shared';
export function eventQueue() {
  const queue: HarnessEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(event: HarnessEvent) { queue.push(event); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}
