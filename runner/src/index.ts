// Atelier runner: registers with Convex, sends heartbeats, and runs the turns
// Convex assigns to it (docs/v0-spec.md, "Runner ↔ Convex protocol").

import { hostname } from "node:os";

import { api } from "@atelier/backend/api";
import { HARNESS_IDS } from "@atelier/shared";
import type { Harness, HarnessId } from "@atelier/shared";
import { ConvexClient } from "convex/browser";

import { claudeHarness } from "./adapters/claude.ts";
import { codexHarness } from "./adapters/codex.ts";
import { piHarness } from "./adapters/pi.ts";
import { appendTranscript, transcriptPath } from "./transcripts.ts";
import { createTurns } from "./turns.ts";

const HEARTBEAT_MS = 15_000;

const convexUrl = mustEnv("CONVEX_URL");
const secret = mustEnv("ATELIER_RUNNER_SECRET");
// Agents run as child processes and inherit this environment, so keep the
// secret out of it. An agent with full reach can still read runner/.env.local.
delete process.env.ATELIER_RUNNER_SECRET;
const name = process.env.ATELIER_RUNNER_NAME ?? hostname();

const client = new ConvexClient(convexUrl);

const harnesses: Partial<Record<HarnessId, Harness>> = {
  claude: claudeHarness({
    executable: process.env.ATELIER_CLAUDE_PATH ?? "claude",
    onRaw: (turnId, msg) => {
      appendTranscript(turnId, msg);
    },
  }),
  codex: codexHarness({
    executable: process.env.ATELIER_CODEX_PATH ?? "codex",
    onRaw: appendTranscript,
  }),
  pi: piHarness({
    cliPath: process.env.ATELIER_PI_CLI_PATH,
    onRaw: appendTranscript,
  }),
};

const turns = createTurns({
  appendTranscript,
  client,
  defaultModels: { pi: process.env.ATELIER_PI_MODEL },
  harnesses,
  secret,
  transcriptPath,
});

async function cliVersion(id: HarnessId): Promise<string | null> {
  try {
    return (await harnesses[id]?.version()) ?? null;
  } catch {
    return null;
  }
}

async function heartbeat() {
  const found = [];
  for (const id of HARNESS_IDS) {
    const version = await cliVersion(id);
    if (version) {
      found.push({ id, version });
    }
  }
  const runnerId = await client.mutation(api.runners.heartbeat, {
    harnesses: found,
    machine: hostname(),
    name,
    secret,
  });
  return { found, runnerId };
}

function mustEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing ${key}. Put it in runner/.env.local.`);
    process.exit(1);
  }
  return value;
}

const { runnerId, found } = await heartbeat();
await client.mutation(api.runner.reportCapabilities, {
  harnesses: found.map(({ id }) => ({
    id,
    canRaiseCards: harnesses[id]!.capabilities.canRaiseCards,
  })),
  runnerId,
  secret,
});
const recovered = await client.mutation(api.runner.recover, {
  runnerId,
  secret,
});
console.log(
  `runner "${name}" registered with ${found.map((h) => `${h.id} ${h.version}`).join(", ")}`
);
if (recovered) {
  console.log(
    `marked ${recovered} unfinished turn(s) from a previous run as interrupted`
  );
}

setInterval(
  async () =>
    heartbeat().catch((error) => {
      console.error("heartbeat failed:", error);
    }),
  HEARTBEAT_MS
);

const inFlight = new Set<string>();
client.onUpdate(
  api.runner.pendingCommands,
  { runnerId, secret },
  (commands) => {
    for (const command of commands) {
      if (inFlight.has(command._id)) {
        continue;
      }
      inFlight.add(command._id);
      turns
        .handle(command._id)
        .catch((error) => {
          console.error(`command ${command._id} failed:`, error);
        })
        .finally(() => inFlight.delete(command._id));
    }
  }
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    turns.abortAll();
    await new Promise((r) => setTimeout(r, 1000));
    await client.close();
    process.exit(0);
  });
}
