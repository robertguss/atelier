import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Node gives execFile a custom promisified form that resolves { stdout, stderr }.
// oxlint-disable-next-line typescript/strict-void-return -- promisify never uses execFile's ChildProcess return value; this is the call Node documents
export const execFileAsync = promisify(execFile);
