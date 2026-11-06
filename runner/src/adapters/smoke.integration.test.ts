import { describe, expect, it } from "vitest";

import { codexHarness } from "./codex.ts";
import { eventQueue, turnInput } from "./events.ts";
import { piHarness } from "./pi.ts";

const ignoreRaw = () => {
  // The smoke test does not inspect raw harness events.
};

const drain = async (events: AsyncIterable<unknown>) => {
  for await (const event of events) {
    void event;
  }
};

describe("harness smoke", () => {
  it("event queue drains events before completion", async () => {
    const q = eventQueue();
    q.push({ text: "ok", type: "final" });
    q.end();
    const results = [];
    for await (const event of q) {
      results.push(event);
    }
    expect(results).toStrictEqual([{ text: "ok", type: "final" }]);
  });

  it("installed harness versions and pre-aborted turns", async () => {
    const harnesses = [
      piHarness({ onRaw: ignoreRaw }),
      codexHarness({ executable: "codex", onRaw: ignoreRaw }),
    ];
    await Promise.all(
      harnesses.map(async (h) => {
        const version = await h.version();
        expect(version.length, `${h.id} version`).toBeGreaterThan(0);
        await expect(
          drain(
            h.runTurn(
              {
                cwd: process.cwd(),
                editsEnabled: false,
                mcpServers: [],
                prompt: "unused",
                turnId: "test",
              },
              AbortSignal.abort(),
              turnInput()
            )
          )
        ).rejects.toThrow("This operation was aborted");
      })
    );
  });
});
