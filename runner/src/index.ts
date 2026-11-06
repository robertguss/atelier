// Atelier runner. Step 1: register with Convex and send a heartbeat with the
// installed harness versions. Claiming commands and running turns come next
// (docs/v0-spec.md, "Runner ↔ Convex protocol").

import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@atelier/backend/api';
import { HARNESS_IDS, type HarnessId } from '@atelier/shared';

const run = promisify(execFile);
const HEARTBEAT_MS = 15_000;

const convexUrl = mustEnv('CONVEX_URL');
const secret = mustEnv('ATELIER_RUNNER_SECRET');
const name = process.env.ATELIER_RUNNER_NAME ?? hostname();

const client = new ConvexHttpClient(convexUrl);

async function harnessVersion(id: HarnessId): Promise<string | null> {
  try {
    const { stdout } = await run(id, ['--version'], { timeout: 10_000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

async function heartbeat() {
  const harnesses = [];
  for (const id of HARNESS_IDS) {
    const version = await harnessVersion(id);
    if (version) harnesses.push({ id, version });
  }
  await client.mutation(api.runners.heartbeat, { secret, name, machine: hostname(), harnesses });
  return harnesses;
}

function mustEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing ${key}. Put it in runner/.env.local.`);
    process.exit(1);
  }
  return value;
}

const harnesses = await heartbeat();
console.log(`runner "${name}" registered with`, harnesses.map((h) => `${h.id} ${h.version}`).join(', '));
setInterval(() => {
  heartbeat().catch((err) => console.error('heartbeat failed:', err));
}, HEARTBEAT_MS);
