// A Pi extension the runner loads when the room lets agents edit files. It
// blocks Pi's edit and write tools outside the room folder, and inside it on
// harness and repository control files, so an agent can't write an allow rule,
// hook or extension that would run commands on a later turn.
// Pi loads this file itself, so it imports nothing but Node built-ins.
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED = ['.claude', '.mcp.json', '.codex', '.pi', '.agents', '.git'];
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Resolves a tool's path argument the way Pi's edit and write tools do.
function piToolPath(raw: string, cwd: string): string {
  let path = raw.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else if (path.startsWith('file://')) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

// Follows symlinks through the deepest part of the path that exists, since
// the file being written may not exist yet. Undefined for a dangling symlink,
// whose target can't be checked before a write would create it.
function realPath(path: string): string | undefined {
  const missing: string[] = [];
  let existing = path;
  while (!lstatSync(existing, { throwIfNoEntry: false }) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  try { return resolve(realpathSync(existing), ...missing); } catch { return undefined; }
}

/** Why an edit or write to `path` must be blocked in a room at `cwd`, or undefined to allow it. */
export function blockedEditReason(cwd: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return 'Edits need a file path';
  const room = realpathSync(cwd);
  const target = realPath(piToolPath(path, cwd));
  if (!target) return `${path} is a symlink to a missing file`;
  const rel = relative(room, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `Edits outside the room folder ${room} are blocked`;
  const first = rel.split(sep)[0] ?? '';
  if (PROTECTED.includes(first)) return `Edits to ${first} are blocked in Atelier rooms`;
  return undefined;
}

interface ToolCallEvent { toolName: string; input: { path?: unknown } }
interface ExtensionApi {
  on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: { cwd?: string }) => Promise<{ block: true; reason: string } | undefined>): void;
}

export default function atelierEditGuard(pi: ExtensionApi) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    const reason = blockedEditReason(ctx.cwd ?? process.cwd(), event.input.path);
    return reason ? { block: true, reason } : undefined;
  });
}
