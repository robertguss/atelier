// Atelier runner: registers with Convex, sends heartbeats, and runs the turns
// Convex assigns to it (docs/v0-spec.md, "Runner ↔ Convex protocol").

import { hostname } from 'node:os';
import { ConvexClient } from 'convex/browser';
import { api } from '@atelier/backend/api';
import type { Id } from '@atelier/backend/dataModel';
import { HARNESS_IDS, type Harness, type HarnessId } from '@atelier/shared';
import { codexHarness } from './adapters/codex.ts';
import { piHarness } from './adapters/pi.ts';
import { claudeHarness } from './adapters/claude.ts';
import { appendTranscript, transcriptPath } from './transcripts.ts';

const HEARTBEAT_MS = 15_000;
const PROGRESS_MS = 500;

const convexUrl = mustEnv('CONVEX_URL');
const secret = mustEnv('ATELIER_RUNNER_SECRET');
const name = process.env.ATELIER_RUNNER_NAME ?? hostname();

const client = new ConvexClient(convexUrl);

const harnesses: Partial<Record<HarnessId, Harness>> = {
  codex: codexHarness({ executable: process.env.ATELIER_CODEX_PATH ?? 'codex', onRaw: appendTranscript }),
  pi: piHarness({ cliPath: process.env.ATELIER_PI_CLI_PATH, onRaw: appendTranscript }),
  claude: claudeHarness({
    executable: process.env.ATELIER_CLAUDE_PATH ?? 'claude',
    onRaw: (turnId, msg) => appendTranscript(turnId, msg),
  }),
};

async function cliVersion(id: HarnessId): Promise<string | null> {
  try {
    return await harnesses[id]?.version() ?? null;
  } catch {
    return null;
  }
}

async function heartbeat() {
  const found = [];
  for (const id of HARNESS_IDS) {
    const version = await cliVersion(id);
    if (version) found.push({ id, version });
  }
  const runnerId = await client.mutation(api.runners.heartbeat, { secret, name, machine: hostname(), harnesses: found });
  return { runnerId, found };
}

const running = new Map<Id<'turns'>, AbortController>();

async function handle(commandId: Id<'commands'>) {
  const job = await client.mutation(api.runner.claim, { secret, commandId });
  if (!job || job.type !== 'run_turn') return;
  const turnId = job.turn.id;
  const harness = harnesses[job.participant.harness];
  const transcriptRef = transcriptPath(turnId);

  if (!harness) {
    await client.mutation(api.runner.fail, {
      secret, turnId, commandId, error: `The ${job.participant.harness} adapter isn't built yet`,
    });
    return;
  }

  const abort = new AbortController();
  running.set(turnId, abort);
  let text = '';
  let finalText: string | null = null;
  let error: string | null = null;
  let sessionId = job.participant.sessionId;
  let usage: { inputTokens: number; outputTokens: number; costUsd?: number } | undefined;

  const flush = async () => {

    const active = await client.mutation(api.runner.progress, { secret, turnId, commandId, partialText: text });
    if (!active) abort.abort();
  };
  let timer: ReturnType<typeof setInterval> | undefined;

  try {
    await client.mutation(api.runner.start, { secret, turnId, harnessVersion: await harness.version() });
    // Start polling only after start commits: a queued turn is not cancelled.
    timer = setInterval(() => flush().catch((e) => console.error('progress failed:', e)), PROGRESS_MS);
    console.log(`turn ${turnId}: ${harness.id} in ${job.room.cwd}`);
    appendTranscript(turnId, { atelier: 'request', prompt: job.turn.prompt, cwd: job.room.cwd, resume: sessionId });

    for await (const ev of harness.runTurn(
      {
        turnId,
        cwd: job.room.cwd,
        prompt: job.turn.prompt,
        model: job.participant.model ?? (harness.id === 'pi' ? process.env.ATELIER_PI_MODEL : undefined),
        reasoning: parseReasoning(job.participant.reasoning),
        resumeSessionId: sessionId,
        readOnly: true,
        mcpServers: [],
      },
      abort.signal,
    )) {
      if (ev.type === 'session') sessionId = ev.sessionId;
      else if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'usage') usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd };
      else if (ev.type === 'final') finalText = ev.text;
      else if (ev.type === 'error') error = ev.message;
    }
  } catch (e) {
    error = abort.signal.aborted ? 'Interrupted' : e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(timer);
    running.delete(turnId);
  }

  if (finalText !== null && !error) {
    await client.mutation(api.runner.finish, {
      secret, turnId, commandId, finalText: finalText || text, sessionId, usage, transcriptRef,
    });
    console.log(`turn ${turnId}: done${usage?.costUsd ? ` ($${usage.costUsd.toFixed(4)})` : ''}`);
  } else {
    await client.mutation(api.runner.fail, {
      secret, turnId, commandId, error: error ?? 'Turn ended without a result', interrupted: abort.signal.aborted, transcriptRef,
    });
    console.error(`turn ${turnId}: ${error}`);
  }
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
const recovered = await client.mutation(api.runner.recover, { secret, runnerId });
console.log(`runner "${name}" registered with ${found.map((h) => `${h.id} ${h.version}`).join(', ')}`);
if (recovered) console.log(`marked ${recovered} unfinished turn(s) from a previous run as interrupted`);

setInterval(() => heartbeat().catch((err) => console.error('heartbeat failed:', err)), HEARTBEAT_MS);

const inFlight = new Set<string>();
client.onUpdate(api.runner.pendingCommands, { secret, runnerId }, (commands) => {
  for (const command of commands) {
    if (inFlight.has(command._id)) continue;
    inFlight.add(command._id);
    handle(command._id)
      .catch((e) => console.error(`command ${command._id} failed:`, e))
      .finally(() => inFlight.delete(command._id));
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    for (const abort of running.values()) abort.abort();
    await new Promise((r) => setTimeout(r, 1000));
    await client.close();
    process.exit(0);
  });
}

function parseReasoning(value: string | undefined) {
  if (value === undefined || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  throw new Error(`Unsupported reasoning level: ${value}`);
}
