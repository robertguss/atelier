import { expect, test } from "vitest";

import { codexHarness } from "./codex.ts";
import { eventQueue, turnInput } from "./events.ts";
import { piHarness } from "./pi.ts";

test("event queue drains events before completion", async () => {
  const q = eventQueue();
  q.push({ type: "final", text: "ok" });
  q.end();
  const results = [];
  for await (const event of q) results.push(event);
  expect(results).toStrictEqual([{ type: "final", text: "ok" }]);
});
test("installed harness versions and pre-aborted turns", async () => {
  for (const h of [
    piHarness({ onRaw() {} }),
    codexHarness({ executable: "codex", onRaw() {} }),
  ]) {
    expect((await h.version()).length > 0, `${h.id} version`).toBeTruthy();
    await expect((async () => {
      for await (const ev of h.runTurn(
        {
          turnId: "test",
          cwd: process.cwd(),
          prompt: "unused",
          editsEnabled: false,
          mcpServers: [],
        },
        AbortSignal.abort(),
        turnInput()
      ))
        void ev;
    })()).rejects.toThrow();
  }
});
