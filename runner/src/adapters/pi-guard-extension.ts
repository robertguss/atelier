// A Pi extension the runner loads when the room lets agents edit files. It
// blocks Pi's edit and write tools outside the room folder, and inside it on
// harness and repository control files at any depth, so an agent can't write
// an allow rule, hook or extension that would run commands on a later turn.
// Pi loads this file itself, so it imports nothing but Node built-ins.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTECTED = new Set([
  ".claude",
  ".mcp.json",
  ".codex",
  ".pi",
  ".agents",
  ".git",
]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

// Resolves a tool's path argument the way Pi's edit and write tools do.
const piToolPath = (raw: string, cwd: string): string => {
  let toolPath = raw.replaceAll(UNICODE_SPACES, " ");
  if (toolPath.startsWith("@")) {
    toolPath = toolPath.slice(1);
  }
  if (toolPath === "~") {
    toolPath = homedir();
  } else if (toolPath.startsWith("~/")) {
    toolPath = path.join(homedir(), toolPath.slice(2));
  } else if (toolPath.startsWith("file://")) {
    toolPath = fileURLToPath(toolPath);
  }
  return path.isAbsolute(toolPath)
    ? path.resolve(toolPath)
    : path.resolve(cwd, toolPath);
};

// Follows symlinks through the deepest part of the path that exists, since
// the file being written may not exist yet. Undefined for a dangling symlink,
// whose target can't be checked before a write would create it.
const realPath = (filePath: string): string | undefined => {
  const missing: string[] = [];
  let existing = filePath;
  while (
    !lstatSync(existing, { throwIfNoEntry: false }) &&
    path.dirname(existing) !== existing
  ) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    return path.resolve(realpathSync(existing), ...missing);
  } catch {
    return undefined;
  }
};

/** Why an edit or write to `path` must be blocked in a room at `cwd`, or undefined to allow it. */
export const blockedEditReason = (
  cwd: string,
  filePath: unknown
): string | undefined => {
  if (typeof filePath !== "string" || filePath === "") {
    return "Edits need a file path";
  }
  const room = realpathSync(cwd);
  const target = realPath(piToolPath(filePath, cwd));
  if (target === undefined) {
    return `${filePath} is a symlink to a missing file`;
  }
  const rel = path.relative(room, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return `Edits outside the room folder ${room} are blocked`;
  }
  const name = rel.split(path.sep).find((part) => PROTECTED.has(part));
  if (name !== undefined) {
    return `Edits to ${name} are blocked in Atelier rooms`;
  }
  return undefined;
};

interface ToolCallEvent {
  toolName: string;
  input: { path?: unknown };
}
interface ExtensionApi {
  on: (
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: { cwd?: string }
    ) => Promise<{ block: true; reason: string } | undefined>
  ) => void;
}

const atelierEditGuard = (pi: ExtensionApi) => {
  pi.on("tool_call", async (event, ctx) => {
    const reason =
      event.toolName === "edit" || event.toolName === "write"
        ? blockedEditReason(ctx.cwd ?? process.cwd(), event.input.path)
        : undefined;
    return await Promise.resolve(
      reason === undefined ? undefined : { block: true as const, reason }
    );
  });
};

export default atelierEditGuard;
