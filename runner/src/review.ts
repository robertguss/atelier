import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

// Reviews receive repository text, never credentials, local transcripts, or
// arbitrary filesystem tools. Only tracked regular files are eligible.
export async function reviewSnapshot(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  const { stdout } = await promisify(execFile)(
    "git",
    ["ls-files", "-z", "--cached"],
    { cwd: root, maxBuffer: 4_000_000 }
  );
  let remaining = 300_000;
  const included: string[] = [];
  const omitted: string[] = [];
  for (const file of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    if (
      /(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key)|credentials[^/]*|auth\.json|.*\.ndjson)$/.test(
        file
      )
    ) {
      omitted.push(file);
      continue;
    }
    const path = join(root, file);
    try {
      const stat = await lstat(path);
      const resolved = await realpath(path);
      const rel = relative(root, resolved);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        rel.startsWith("..") ||
        isAbsolute(rel) ||
        stat.size > 60_000 ||
        stat.size > remaining
      ) {
        omitted.push(file);
        continue;
      }
      const text = await readFile(path, "utf-8");
      if (text.includes("\0")) {
        omitted.push(file);
        continue;
      }
      included.push(`\n--- ${file} ---\n${text}`);
      remaining -= Buffer.byteLength(text);
    } catch {
      omitted.push(file);
    }
  }
  return `\nRepository snapshot (tracked text files, maximum 300 KB). Tools are disabled for this independent review. Base your findings on the supplied evidence; say when omitted material prevents a conclusion.\n${included.join("\n")}\nOmitted files: ${omitted.join(", ") || "none"}`;
}
