import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { execFileAsync } from "./exec.ts";

const SECRET_PATH =
  /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key)|credentials[^/]*|auth\.json|.*\.ndjson)$/u;

// The file's text when it is a tracked regular text file inside `root` that
// fits in `remaining` bytes, otherwise undefined.
const readTracked = async (
  root: string,
  file: string,
  remaining: number
): Promise<string | undefined> => {
  const filePath = path.join(root, file);
  try {
    const stat = await lstat(filePath);
    const resolved = await realpath(filePath);
    const rel = path.relative(root, resolved);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      rel.startsWith("..") ||
      path.isAbsolute(rel) ||
      stat.size > 60_000 ||
      stat.size > remaining
    ) {
      return undefined;
    }
    const text = await readFile(filePath, "utf-8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
};

// Reviews receive repository text, never credentials, local transcripts, or
// arbitrary filesystem tools. Only tracked regular files are eligible.
export const reviewSnapshot = async (cwd: string): Promise<string> => {
  const root = await realpath(cwd);
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached"],
    { cwd: root, maxBuffer: 4_000_000 }
  );
  let remaining = 300_000;
  const included: string[] = [];
  const omitted: string[] = [];
  const files = [...new Set(stdout.split("\0").filter(Boolean))].toSorted();
  for (const file of files) {
    if (SECRET_PATH.test(file)) {
      omitted.push(file);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- files fill a shared byte budget in sorted order, so each read depends on what the previous ones used
    const text = await readTracked(root, file, remaining);
    if (text === undefined) {
      omitted.push(file);
      continue;
    }
    included.push(`\n--- ${file} ---\n${text}`);
    remaining -= Buffer.byteLength(text);
  }
  return `\nRepository snapshot (tracked text files, maximum 300 KB). Tools are disabled for this independent review. Base your findings on the supplied evidence; say when omitted material prevents a conclusion.\n${included.join("\n")}\nOmitted files: ${omitted.join(", ") || "none"}`;
};
