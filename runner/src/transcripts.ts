import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Raw harness events stay on the runner's disk, one append-only ndjson file
// per turn. Convex only stores the path (docs/v0-spec.md, "The ledger and the
// transcript are different things").
const dir = process.env.ATELIER_TRANSCRIPTS_DIR ?? join(homedir(), '.atelier', 'transcripts');
mkdirSync(dir, { recursive: true, mode: 0o700 });

export function transcriptPath(turnId: string) {
  return join(dir, `${turnId}.ndjson`);
}

export function appendTranscript(turnId: string, record: unknown) {
  appendFileSync(transcriptPath(turnId), JSON.stringify({ at: Date.now(), record }) + '\n', { mode: 0o600 });
}
