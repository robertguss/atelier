// Rotates the runner's shared secret: sets a new one on Convex and in
// runner/.env.local, then asks you to restart the runner. The secret is never
// printed. Run it after removing someone from a room (docs/shared-rooms.md).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "ATELIER_RUNNER_SECRET";

/** The .env text with KEY set to `value`, replacing its line or adding one. */
export function withEnvValue(text: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) =>
    l.replace(/^export\s+/, "").startsWith(`${key}=`)
  );
  if (at !== -1) {
    lines[at] = line;
  } else {
    lines.splice(lines.at(-1) === "" ? -1 : lines.length, 0, line);
  }
  return lines.join("\n") + (lines.at(-1) === "" ? "" : "\n");
}

if (import.meta.main) {
  const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
  const backendDir = fileURLToPath(
    new URL("../../packages/backend", import.meta.url)
  );
  const secret = randomBytes(32).toString("base64url");

  let current = "";
  try {
    current = readFileSync(envFile, "utf-8");
  } catch {
    // No file yet; the new one holds just the secret.
  }
  // Stage the file first, so Convex never holds a secret the runner can't find.
  const staged = `${envFile}.rotating`;
  writeFileSync(staged, withEnvValue(current, KEY, secret), { mode: 0o600 });

  // Piped through stdin, so the secret stays out of process listings and shell history.
  const set = spawnSync("npx", ["convex", "env", "set", KEY], {
    cwd: backendDir,
    input: secret,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (set.status !== 0) {
    rmSync(staged, { force: true });
    console.error("Could not set the secret on Convex. Nothing changed.");
    process.exit(1);
  }
  renameSync(staged, envFile);
  console.log(
    "Rotated the runner secret on Convex and in runner/.env.local. Restart the runner now; until then it is refused and agents show as offline."
  );
}
