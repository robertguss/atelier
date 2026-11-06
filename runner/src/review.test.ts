import { execFile } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { promisify } from "node:util";

import { reviewSnapshot } from "./review.ts";

test("review snapshot includes tracked text, excludes secrets, untracked transcripts, symlinks and large files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-snapshot-"));
  const run = promisify(execFile);
  try {
    await run("git", ["init", "-q", dir]);
    await writeFile(join(dir, "source.ts"), "export const visible = true;");
    await writeFile(join(dir, ".env.local"), "SECRET_ENV");
    await writeFile(join(dir, "untracked.ndjson"), "SECRET_ANSWER");
    await writeFile(join(dir, "large.txt"), "x".repeat(60_001));
    await symlink("/etc/hostname", join(dir, "outside"));
    await run(
      "git",
      ["add", "source.ts", ".env.local", "large.txt", "outside"],
      { cwd: dir }
    );
    const snapshot = await reviewSnapshot(dir);
    expect(snapshot).toMatch(/export const visible/);
    expect(snapshot).not.toMatch(/SECRET_ENV|SECRET_ANSWER|x{100}/);
    expect(snapshot).toMatch(/Omitted files:.*outside/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
