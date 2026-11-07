import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { execFileAsync } from "./exec.ts";
import { reviewSnapshot } from "./review.ts";

describe(reviewSnapshot, () => {
  it("includes tracked text, excludes secrets, untracked transcripts, symlinks and large files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atelier-snapshot-"));
    try {
      await execFileAsync("git", ["init", "-q", dir]);
      await writeFile(
        path.join(dir, "source.ts"),
        "export const visible = true;"
      );
      await writeFile(path.join(dir, ".env.local"), "SECRET_ENV");
      await writeFile(path.join(dir, "untracked.ndjson"), "SECRET_ANSWER");
      await writeFile(path.join(dir, "large.txt"), "x".repeat(60_001));
      await symlink("/etc/hostname", path.join(dir, "outside"));
      await execFileAsync(
        "git",
        ["add", "source.ts", ".env.local", "large.txt", "outside"],
        { cwd: dir }
      );
      const snapshot = await reviewSnapshot(dir);
      expect(snapshot).toMatch(/export const visible/u);
      expect(snapshot).not.toMatch(/SECRET_ENV|SECRET_ANSWER|x{100}/u);
      expect(snapshot).toMatch(/Omitted files:.*outside/u);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
