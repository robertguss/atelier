import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Harness, HarnessEvent } from "@atelier/shared";

import { execFileAsync } from "../exec.ts";
import { eventQueue } from "./events.ts";

// Harness and repository control files. Writing one could grant the agent
// commands, hooks or extensions on its next turn.
const PROTECTED = new Set([
  ".git",
  ".codex",
  ".agents",
  ".claude",
  ".pi",
  ".mcp.json",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const present = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

const exists = async (filePath: string) => {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
};

// Walks up from `filePath` to its deepest existing part, carrying the missing
// names in `rest`.
const realTargetFrom = async (
  filePath: string,
  rest: string[]
): Promise<string | null> => {
  try {
    return path.join(await realpath(filePath), ...rest);
  } catch {
    if (path.dirname(filePath) === filePath || (await exists(filePath))) {
      return null;
    }
    return await realTargetFrom(path.dirname(filePath), [
      path.basename(filePath),
      ...rest,
    ]);
  }
};

// Where a write to `filePath` lands: symlinks resolved through its deepest
// existing part. Null for a dangling symlink or an unreadable path, which
// can't be checked.
const realTarget = async (filePath: string): Promise<string | null> =>
  await realTargetFrom(filePath, []);

/** Whether every path lands inside `cwd`, once symlinks resolve, and outside control files. */
const editAllowed = async (cwd: string, paths: string[]) => {
  if (paths.length === 0) {
    return false;
  }
  const root = await realpath(cwd);
  const allowed = await Promise.all(
    paths.map(async (filePath) => {
      const target = await realTarget(path.resolve(cwd, filePath));
      if (target === null || target === "") {
        return false;
      }
      const rel = path.relative(root, target);
      if (
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
      ) {
        return false;
      }
      const parts = rel.split(path.sep);
      return !parts.some((part) => PROTECTED.has(part));
    })
  );
  return allowed.every(Boolean);
};

const changesOf = (item: Record<string, unknown>) =>
  Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];

// Paths a file change will write. Empty, so the change is declined, if any of
// them isn't a path.
const changedPaths = (item: Record<string, unknown>): string[] => {
  const paths: string[] = [];
  for (const change of changesOf(item)) {
    const movePath = isRecord(change.kind) ? change.kind.move_path : undefined;
    for (const candidate of [change.path, movePath]) {
      if (typeof candidate === "string") {
        if (candidate !== "") {
          paths.push(candidate);
        }
      } else if (candidate !== undefined && candidate !== null) {
        return [];
      }
    }
  }
  return paths;
};

const oneLine = (text: string) =>
  text.replaceAll(/\s+/gu, " ").trim().slice(0, 200);

const toolCall = (
  cwd: string,
  item: Record<string, unknown>
): { name: string; summary: string } | undefined => {
  if (item.type === "commandExecution") {
    return {
      name: "Shell",
      summary: oneLine(typeof item.command === "string" ? item.command : ""),
    };
  }
  if (item.type === "fileChange") {
    return {
      name: "Edit",
      summary: oneLine(
        changesOf(item)
          .flatMap((c) =>
            typeof c.path === "string"
              ? [path.relative(cwd, path.resolve(cwd, c.path))]
              : []
          )
          .join(", ")
      ),
    };
  }
  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    return {
      name: `${server}.${tool}`,
      summary: oneLine(JSON.stringify(item.arguments ?? {})),
    };
  }
  return undefined;
};

// The id Codex returns for a started thread or turn.
const startedId = (result: unknown, key: "thread" | "turn"): string => {
  const started = isRecord(result) ? result[key] : undefined;
  if (!isRecord(started) || typeof started.id !== "string") {
    throw new Error(`Codex did not return a ${key} id`);
  }
  return started.id;
};

// The config a review turn starts with: no tools beyond reading the prompt.
const reviewConfigFor = (read: unknown): Record<string, unknown> => {
  if (!isRecord(read) || !isRecord(read.config)) {
    throw new Error("Codex config/read returned no config");
  }
  const { config } = read;
  const reviewConfig: Record<string, unknown> = {
    "features.apps": false,
    "features.browser_use": false,
    "features.code_mode": false,
    "features.code_mode_host": false,
    "features.computer_use": false,
    "features.goals": false,
    "features.hooks": false,
    "features.image_generation": false,
    "features.js_repl": false,
    "features.memory_tool": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.plugins": false,
    "features.runtime_agent_instances": false,
    "features.shell_tool": false,
    "features.skill_mcp_dependency_install": false,
    "features.unified_exec": false,
    "features.view_image": false,
    "plugins._default.enabled": false,
    web_search: "disabled",
  };
  for (const section of ["mcp_servers", "plugins"] as const) {
    const entries = config[section];
    for (const name of Object.keys(isRecord(entries) ? entries : {})) {
      // Config override keys use dotted paths. Never accidentally leave
      // an unusual server name enabled by addressing a different key.
      if (!/^[A-Za-z0-9_@-]+$/u.test(name)) {
        throw new Error(
          `Cannot safely disable ${section} entry for review: ${name}`
        );
      }
      reviewConfig[`${section}.${name}.enabled`] = false;
    }
  }
  return reviewConfig;
};

export const codexHarness = (opts: {
  executable: string;
  onRaw: (id: string, event: unknown) => void;
}): Harness => ({
  // Codex asks in plain text: its question prompt only reaches a client in Plan mode.
  capabilities: { canRaiseCards: false },
  id: "codex",
  async *runTurn(req, signal, input) {
    signal.throwIfAborted();
    if (req.mcpServers.length) {
      throw new Error("Per-turn MCP injection is not implemented");
    }

    let threadId: string | undefined;
    let turnId: string | undefined;
    let closed = false;
    let turnStarted!: (id: string | undefined) => void;
    // oxlint-disable-next-line promise/avoid-new -- Codex reports the turn id later, which settles this promise from outside
    const started = new Promise<string | undefined>((resolve) => {
      turnStarted = resolve;
    });

    const child = spawn(opts.executable, ["app-server"], {
      cwd: req.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = eventQueue();
    let sequence = 0;
    const privateResponses = new Set<number>();
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    const send = (value: unknown) => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const call = async (
      method: string,
      params: unknown,
      timeoutMs = 30_000
    ): Promise<unknown> => {
      sequence += 1;
      const id = sequence;
      if (method === "config/read") {
        privateResponses.add(id);
      }
      // oxlint-disable-next-line promise/avoid-new -- the JSON-RPC reply arrives later on stdout, which settles this promise from outside
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { method, reject, resolve, timer });
        send({ id, method, params });
      });
    };
    input.steer = async (text) => {
      const expectedTurnId = turnId ?? (await started);
      if (closed || !present(threadId) || !present(expectedTurnId)) {
        return "rejected";
      }
      try {
        await call("turn/steer", {
          expectedTurnId,
          input: [{ text, text_elements: [], type: "text" }],
          threadId,
        });
        return "steered";
      } catch {
        // Codex refuses a steer once the turn has ended or another has started.
        return "rejected";
      }
    };
    // Permissions are fixed when a turn starts. Switching edits off interrupts
    // the turn; switching them on applies from the next turn.
    input.setEditsEnabled = () => {
      // Nothing changes mid-turn.
    };

    const fail = (error: Error) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      events.push({
        message: error.message,
        retryable: false,
        type: "error",
      });
      events.end();
    };
    const stop = () => {
      fail(new Error("Interrupted"));
      child.kill();
    };
    const interrupt = async (thread: string, turn: string) => {
      try {
        await call("turn/interrupt", { threadId: thread, turnId: turn }, 5000);
      } catch {
        // Stopped below either way.
      }
      stop();
    };
    const abort = () => {
      // Stop the turn inside Codex first, so the thread is left resumable.
      if (present(threadId) && present(turnId)) {
        // interrupt handles its own failure by stopping anyway.
        void interrupt(threadId, turnId);
      } else {
        stop();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", () => {
      fail(new Error("Codex process exited"));
    });
    child.stderr.on("data", (data: Buffer) => {
      opts.onRaw(req.turnId, { stderr: String(data) });
    });

    // Paths each file change will write, from its `item/started`: Codex's
    // approval request names only the item.
    const changePaths = new Map<string, string[]>();
    const toolsSeen = new Set<string>();
    const answer = async (method: string, params: unknown) => {
      // Commands stay limited to what Codex runs unprompted.
      if (method === "item/commandExecution/requestApproval") {
        return { result: { decision: "decline" } };
      }
      if (method === "item/fileChange/requestApproval") {
        const itemId = isRecord(params) ? params.itemId : undefined;
        const paths =
          (typeof itemId === "string" ? changePaths.get(itemId) : undefined) ??
          [];
        const allowed =
          req.editsEnabled &&
          (await editAllowed(req.cwd, paths).catch(() => false));
        return { result: { decision: allowed ? "accept" : "decline" } };
      }
      return {
        error: {
          code: -32_601,
          message: "Atelier does not support this request",
        },
      };
    };
    const respond = async (id: unknown, method: string, params: unknown) => {
      let reply: Awaited<ReturnType<typeof answer>>;
      try {
        reply = await answer(method, params);
      } catch {
        send({
          error: {
            code: -32_603,
            message: "Atelier could not answer this request",
          },
          id,
        });
        return;
      }
      send({ id, ...reply });
    };

    let final = "";
    const onResponse = (id: unknown, msg: Record<string, unknown>) => {
      const p = typeof id === "number" ? pending.get(id) : undefined;
      if (p === undefined || typeof id !== "number") {
        return;
      }
      clearTimeout(p.timer);
      pending.delete(id);
      if (isRecord(msg.error)) {
        const { message } = msg.error;
        p.reject(new Error(typeof message === "string" ? message : undefined));
      } else {
        p.resolve(msg.result);
      }
    };
    const onItem = (method: string, item: Record<string, unknown>) => {
      if (
        method === "item/completed" &&
        item.type === "agentMessage" &&
        typeof item.text === "string"
      ) {
        final += (final === "" ? "" : "\n\n") + item.text;
      }
      const { id } = item;
      if (typeof id !== "string") {
        return;
      }
      if (item.type === "fileChange" && method === "item/started") {
        changePaths.set(id, changedPaths(item));
      }
      const tool = toolCall(req.cwd, item);
      if (tool && !toolsSeen.has(id)) {
        toolsSeen.add(id);
        events.push({ id, type: "tool_call", ...tool });
      }
      if (tool && method === "item/completed") {
        events.push({
          id,
          ok: item.status === "completed",
          type: "tool_result",
        });
      }
    };
    const turnEnded = (turn: Record<string, unknown>): HarnessEvent => {
      if (turn.status === "completed") {
        return { text: final, type: "final" };
      }
      const status = typeof turn.status === "string" ? turn.status : "";
      const reason = isRecord(turn.error) ? turn.error.message : undefined;
      let message = status;
      if (signal.aborted) {
        message = "Interrupted";
      } else if (typeof reason === "string") {
        message = reason;
      }
      return { message, retryable: false, type: "error" };
    };
    const onNotification = (
      method: string,
      params: Record<string, unknown>
    ) => {
      if (
        method === "item/agentMessage/delta" &&
        typeof params.delta === "string"
      ) {
        events.push({ text: params.delta, type: "text_delta" });
      }
      if (
        (method === "item/started" || method === "item/completed") &&
        isRecord(params.item)
      ) {
        onItem(method, params.item);
      }
      const last = isRecord(params.tokenUsage)
        ? params.tokenUsage.last
        : undefined;
      if (
        method === "thread/tokenUsage/updated" &&
        isRecord(last) &&
        typeof last.inputTokens === "number" &&
        typeof last.outputTokens === "number"
      ) {
        events.push({
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          type: "usage",
        });
      }
      if (method === "turn/completed") {
        events.push(turnEnded(isRecord(params.turn) ? params.turn : {}));
        events.end();
      }
    };
    const onLine = (line: string) => {
      const parsed: unknown = JSON.parse(line);
      const msg = isRecord(parsed) ? parsed : {};
      // config/read can contain secrets; never put that response in a transcript.
      if (!(typeof msg.id === "number" && privateResponses.has(msg.id))) {
        opts.onRaw(req.turnId, parsed);
      }
      const method =
        typeof msg.method === "string" && msg.method !== ""
          ? msg.method
          : undefined;
      if (msg.id !== undefined && method === undefined) {
        onResponse(msg.id, msg);
      } else if (msg.id === undefined) {
        onNotification(method ?? "", isRecord(msg.params) ? msg.params : {});
      } else if (method !== undefined) {
        // respond sends an error reply itself when answering fails.
        void respond(msg.id, method, msg.params);
      }
    };

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        onLine(line);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      await call("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "atelier", version: "0.0.0" },
      });
      send({ method: "initialized", params: {} });
      const reviewConfig =
        req.independentReview === true
          ? reviewConfigFor(
              await call("config/read", {
                cwd: req.cwd,
                includeLayers: false,
              })
            )
          : undefined;
      // Edits on: Codex may write only inside the folder, and asks before
      // every file change and every command outside its own safe set. The
      // runner answers those requests. Edits off: read-only, never asks.
      const approvalPolicy = req.editsEnabled ? "untrusted" : "never";
      const sandboxPolicy = req.editsEnabled
        ? {
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
            networkAccess: false,
            type: "workspaceWrite",
            writableRoots: [req.cwd],
          }
        : { type: "readOnly" };
      const resume =
        req.independentReview === true ? undefined : req.resumeSessionId;
      const thread = startedId(
        await call(present(resume) ? "thread/resume" : "thread/start", {
          ...(present(resume) ? { threadId: resume } : {}),
          ...(req.independentReview === true
            ? { config: reviewConfig, ephemeral: true }
            : {}),
          approvalPolicy,
          cwd: req.cwd,
          model: req.model,
          sandbox: req.editsEnabled ? "workspace-write" : "read-only",
        }),
        "thread"
      );
      threadId = thread;
      yield { sessionId: thread, type: "session" };
      turnId = startedId(
        await call("turn/start", {
          approvalPolicy,
          effort: req.reasoning,
          input: [{ text: req.prompt, type: "text" }],
          model: req.model,
          sandboxPolicy,
          threadId: thread,
        }),
        "turn"
      );
      turnStarted(turnId);
      yield* events;
    } finally {
      closed = true;
      turnStarted(undefined);
      signal.removeEventListener("abort", abort);
      lines.close();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
      }
      child.kill();
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      kill.unref();
    }
  },
  async version() {
    const { stdout } = await execFileAsync(opts.executable, ["--version"]);
    return stdout.trim();
  },
});
