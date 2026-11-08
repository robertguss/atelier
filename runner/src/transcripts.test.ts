import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// A file's permission bits, as in "600".
const permissions = (at: string) => statSync(at).mode.toString(8).slice(-3);

describe("transcripts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("appends each record as one timestamped JSON line, in a folder and file only the runner's user can read", async () => {
    const dir = path.join(
      mkdtempSync(path.join(tmpdir(), "atelier-transcripts-")),
      "transcripts"
    );
    vi.stubEnv("ATELIER_TRANSCRIPTS_DIR", dir);
    vi.useFakeTimers({ now: 1000, toFake: ["Date"] });
    const { appendTranscript, transcriptPath } = await import("./transcripts");

    appendTranscript("t1", { type: "start" });
    appendTranscript("t1", { text: "done", type: "final" });

    const file = transcriptPath("t1");
    expect(file).toBe(path.join(dir, "t1.ndjson"));
    expect(
      readFileSync(file, "utf-8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
    ).toStrictEqual([
      { at: 1000, record: { type: "start" } },
      { at: 1000, record: { text: "done", type: "final" } },
    ]);
    expect([permissions(dir), permissions(file)]).toStrictEqual(["700", "600"]);
  });
});
