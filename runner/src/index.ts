// Atelier runner: registers with Convex, sends heartbeats, and runs the turns
// Convex assigns to it (docs/v0-spec.md, "Runner ↔ Convex protocol").

import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

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

const mustEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    console.error(`Missing ${key}. Put it in runner/.env.local.`);
    process.exit(1);
  }
  return value;
};

const convexUrl = mustEnv("CONVEX_URL");
const secret = mustEnv("ATELIER_RUNNER_SECRET");
// Agents run as child processes and inherit this environment, so keep the
// secret out of it. An agent with full reach can still read runner/.env.local.
delete process.env.ATELIER_RUNNER_SECRET;
// The repo's post-edit lint hooks skip themselves when this is set. Otherwise a
// room agent could write a file those hooks execute (a node_modules binary or
// a lint config) and run code outside the runner's permission checks.
process.env.ATELIER_ROOM_TURN = "1";
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

const cliVersion = async (id: HarnessId): Promise<string | null> => {
  try {
    const version = await harnesses[id]?.version();
    return version ?? null;
  } catch {
    return null;
  }
};

const heartbeat = async () => {
  const versions = await Promise.all(HARNESS_IDS.map(cliVersion));
  const found = [];
  for (const [index, id] of HARNESS_IDS.entries()) {
    const version = versions[index];
    if (version !== undefined && version !== null && version !== "") {
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
};

const { runnerId, found } = await heartbeat();
await client.mutation(api.runner.reportCapabilities, {
  harnesses: found.map(({ id }) => {
    const harness = harnesses[id];
    if (harness === undefined) {
      throw new Error(`Found a ${id} version without a ${id} adapter`);
    }
    return { canRaiseCards: harness.capabilities.canRaiseCards, id };
  }),
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

setInterval(() => {
  heartbeat().catch((heartbeatError: unknown) => {
    console.error("heartbeat failed:", heartbeatError);
  });
}, HEARTBEAT_MS);

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
        .finally(() => {
          inFlight.delete(command._id);
        })
        .catch((commandError: unknown) => {
          console.error(`command ${command._id} failed:`, commandError);
        });
    }
  }
);

const shutdown = async () => {
  turns.abortAll();
  await sleep(1000);
  await client.close();
  process.exit(0);
};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // A failed shutdown still surfaces as an unhandled rejection.
    void shutdown();
  });
}
