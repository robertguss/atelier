import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HarnessEvent, TurnRequest } from "@atelier/shared";
import { assert, describe, expect, it } from "vitest";

import { codexHarness } from "./codex.ts";
import { turnInput } from "./events.ts";

// A fake `codex app-server`. It reads `fake.json` from its cwd:
// - `replies[method]`: the reply to a client request, or a list used call by call;
// - `steps`: run after `turn/start` is answered. `{send}` writes a message,
//   `{response: id}` waits for the client's answer to a server request, and
//   `{request: method}` waits for a client request.
// Every line the client writes is appended to `calls.jsonl`.
const FAKE = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync, readFileSync} from 'node:fs';
const spec = JSON.parse(readFileSync('fake.json', 'utf8'));
const defaults = {
  'thread/start': {result: {thread: {id: 'thread-1'}}},
  'thread/resume': {result: {thread: {id: 'thread-1'}}},
  'turn/start': {result: {turn: {id: 'turn-1'}}},
  'config/read': {result: {config: {}}},
};
const out = (v) => console.log(JSON.stringify(v));
const counts = {};
const waiters = [];
const wait = (match) => new Promise((resolve) => waiters.push({match, resolve}));
async function run() {
  for (const step of spec.steps ?? []) {
    if (step.send) out(step.send);
    else if (step.response !== undefined) await wait((m) => m.id === step.response && !m.method);
    else if (step.request) await wait((m) => m.method === step.request);
  }
}
createInterface({input: process.stdin}).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync('calls.jsonl', line + '\\n');
  if (msg.method && msg.id !== undefined) {
    const n = counts[msg.method] = (counts[msg.method] ?? 0) + 1;
    const configured = spec.replies?.[msg.method];
    const reply = (Array.isArray(configured) ? configured[n - 1] : configured) ?? defaults[msg.method] ?? {result: {}};
    out({id: msg.id, ...reply});
    if (msg.method === 'turn/start') run();
  }
  const i = waiters.findIndex((w) => w.match(msg));
  if (i >= 0) waiters.splice(i, 1)[0].resolve();
});
`;

const completed = {
  method: "turn/completed",
  params: { turn: { id: "turn-1", status: "completed" } },
};
const message = (text: string) => ({
  method: "item/completed",
  params: { item: { id: "m1", text, type: "agentMessage" } },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The value at `keys` inside parsed JSON, or undefined where the path breaks.
const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

const ADD = { type: "add" };
const change = (filePath: string, kind: object = ADD) => ({
  diff: "",
  kind,
  path: filePath,
});

const fakeCodex = async (spec: unknown) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atelier-codex-test-"));
  const executable = path.join(dir, "fake.mjs");
  await writeFile(executable, FAKE, { mode: 0o700 });
  await writeFile(path.join(dir, "fake.json"), JSON.stringify(spec));
  return {
    async calls(): Promise<Record<string, unknown>[]> {
      const log = await readFile(path.join(dir, "calls.jsonl"), "utf-8");
      return log
        .trim()
        .split("\n")
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          assert(isRecord(parsed), `calls.jsonl holds a non-object: ${line}`);
          return parsed;
        });
    },
    dir,
    executable,
    [Symbol.asyncDispose]: async () => {
      await rm(dir, { force: true, recursive: true });
    },
  };
};

const request = (
  dir: string,
  extra: Partial<TurnRequest> = {}
): TurnRequest => ({
  cwd: dir,
  editsEnabled: false,
  mcpServers: [],
  prompt: "go",
  turnId: "test",
  ...extra,
});

const collect = async (
  events: AsyncIterable<HarnessEvent>,
  each?: (event: HarnessEvent) => void
) => {
  const results: HarnessEvent[] = [];
  for await (const event of events) {
    results.push(event);
    each?.(event);
  }
  return results;
};

describe(codexHarness, () => {
  it("Codex review starts fresh with denied tools, disabled MCP, and never logs effective config, even a late reply", async () => {
    const secretConfig = {
      config: {
        mcp_servers: { fixture: { enabled: true, token: "CONFIG_SECRET" } },
      },
    };
    await using fake = await fakeCodex({
      replies: { "config/read": { result: secretConfig } },
      // The client's second request is config/read; this repeats its reply after the pending call is gone.
      steps: [
        { send: { id: 2, result: secretConfig } },
        { send: message("Independent answer") },
        { send: completed },
      ],
    });
    const raw: unknown[] = [];
    const results = await collect(
      codexHarness({
        executable: fake.executable,
        onRaw(_id, e) {
          raw.push(e);
        },
      }).runTurn(
        request(fake.dir, {
          independentReview: true,
          prompt: "review",
          resumeSessionId: "ordinary",
        }),
        new AbortController().signal,
        turnInput()
      )
    );
    const calls = await fake.calls();
    expect(
      at(
        calls.find((c) => c.id === 2),
        "method"
      )
    ).toBe("config/read");
    const start = calls.find((c) => c.method === "thread/start");
    const config = at(start, "params", "config");
    expect({
      ephemeral: at(start, "params", "ephemeral"),
      goals: at(config, "features.goals"),
      hooks: at(config, "features.hooks"),
      mcpFixture: at(config, "mcp_servers.fixture.enabled"),
      multiAgent: at(config, "features.multi_agent"),
      sandbox: at(start, "params", "sandbox"),
      shellTool: at(config, "features.shell_tool"),
      threadId: at(start, "params", "threadId"),
    }).toStrictEqual({
      ephemeral: true,
      goals: false,
      hooks: false,
      mcpFixture: false,
      multiAgent: false,
      sandbox: "read-only",
      shellTool: false,
      threadId: undefined,
    });
    expect(JSON.stringify(raw)).not.toMatch(/CONFIG_SECRET/u);
    expect(
      results.some((e) => e.type === "final" && e.text === "Independent answer")
    ).toBeTruthy();
  });

  it("Codex initialize opts into the experimental API", async () => {
    await using fake = await fakeCodex({ steps: [{ send: completed }] });
    await collect(
      codexHarness({ executable: fake.executable, onRaw() {} }).runTurn(
        request(fake.dir),
        new AbortController().signal,
        turnInput()
      )
    );
    const calls = await fake.calls();
    const init = calls.find((c) => c.method === "initialize");
    expect(at(init, "params", "capabilities")).toStrictEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
  });

  it("Codex steers into the running turn by its id, and a refused steer resolves rejected", async () => {
    await using fake = await fakeCodex({
      replies: {
        "turn/steer": [
          { result: { turnId: "turn-1" } },
          {
            error: {
              code: -32_600,
              message: "expected active turn id `turn-1` but found `turn-2`",
            },
          },
        ],
      },
      steps: [
        { request: "turn/steer" },
        { request: "turn/steer" },
        { send: message("Done") },
        { send: completed },
      ],
    });
    const input = turnInput();
    const running = collect(
      codexHarness({ executable: fake.executable, onRaw() {} }).runTurn(
        request(fake.dir),
        new AbortController().signal,
        input
      )
    );
    await expect(input.steer("Use the second option")).resolves.toBe("steered");
    await expect(input.steer("Too late")).resolves.toBe("rejected");
    await running;
    await expect(input.steer("After the turn")).resolves.toBe("rejected");

    const calls = await fake.calls();
    const steers = calls.filter((c) => c.method === "turn/steer");
    expect(steers).toHaveLength(2);
    expect(at(steers[0], "params")).toStrictEqual({
      expectedTurnId: "turn-1",
      input: [
        { text: "Use the second option", text_elements: [], type: "text" },
      ],
      threadId: "thread-1",
    });
  });

  it("Codex stop interrupts the turn before the process is killed", async () => {
    const started = {
      method: "item/started",
      params: {
        item: {
          command: "sleep 60",
          id: "c1",
          status: "inProgress",
          type: "commandExecution",
        },
      },
    };
    await using fake = await fakeCodex({
      steps: [
        { send: started },
        { request: "turn/interrupt" },
        {
          send: {
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "interrupted" } },
          },
        },
      ],
    });
    const stop = new AbortController();
    const results = await collect(
      codexHarness({ executable: fake.executable, onRaw() {} }).runTurn(
        request(fake.dir),
        stop.signal,
        turnInput()
      ),
      (e) => {
        if (e.type === "tool_call") {
          stop.abort();
        }
      }
    );
    const calls = await fake.calls();
    const interrupt = calls.find((c) => c.method === "turn/interrupt");
    expect(at(interrupt, "params")).toStrictEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(results.some((e) => e.type === "error")).toBeTruthy();
    expect(!results.some((e) => e.type === "final")).toBeTruthy();
  });

  it("Codex with edits off keeps the read-only sandbox, never asks, and raises no cards", async () => {
    await using fake = await fakeCodex({
      steps: [
        {
          send: {
            id: "q1",
            method: "item/tool/requestUserInput",
            params: {
              itemId: "u1",
              questions: [{ id: "color", options: [], question: "Which?" }],
            },
          },
        },
        { response: "q1" },
        { send: completed },
      ],
    });
    const harness = codexHarness({ executable: fake.executable, onRaw() {} });
    await collect(
      harness.runTurn(
        request(fake.dir),
        new AbortController().signal,
        turnInput()
      )
    );
    const calls = await fake.calls();
    const thread = calls.find((c) => c.method === "thread/start");
    const turn = calls.find((c) => c.method === "turn/start");
    expect({
      canRaiseCards: harness.capabilities.canRaiseCards,
      questionErrorCode: at(
        calls.find((c) => c.id === "q1"),
        "error",
        "code"
      ),
      threadApprovalPolicy: at(thread, "params", "approvalPolicy"),
      threadSandbox: at(thread, "params", "sandbox"),
      turnApprovalPolicy: at(turn, "params", "approvalPolicy"),
      turnSandboxPolicy: at(turn, "params", "sandboxPolicy"),
    }).toStrictEqual({
      canRaiseCards: false,
      questionErrorCode: -32_601,
      threadApprovalPolicy: "never",
      threadSandbox: "read-only",
      turnApprovalPolicy: "never",
      turnSandboxPolicy: { type: "readOnly" },
    });
  });

  it("Codex with edits on declines commands and accepts file changes only inside the folder and outside control files", async () => {
    await using fake = await fakeCodex({});
    const { dir } = fake;
    const outside = await mkdtemp(
      path.join(tmpdir(), "atelier-codex-outside-")
    );
    await mkdir(path.join(dir, "docs"));
    await symlink(outside, path.join(dir, "linked"));
    await symlink(path.join(outside, "missing"), path.join(dir, "dangling"));

    const files: Record<string, object[]> = {
      agents: [change(path.join(dir, ".agents/skills/x.md"))],
      claude: [change(path.join(dir, ".claude/settings.json"))],
      codex: [change(path.join(dir, ".codex/config.toml"))],
      git: [change(path.join(dir, ".git/hooks/pre-commit"))],
      inside: [change(path.join(dir, "docs/plan.md"))],
      mcp: [change(path.join(dir, ".mcp.json"))],
      mixed: [
        change(path.join(dir, "ok.md")),
        change(path.join(dir, ".git/config")),
      ],
      movedIntoGit: [
        change(path.join(dir, "notes.md"), {
          move_path: path.join(dir, ".git/notes.md"),
          type: "update",
        }),
      ],
      nestedGit: [change(path.join(dir, "sub/.git/config"))],
      outside: [change(path.join(outside, "plan.md"))],
      parent: [change(path.join(dir, "../escape.md"))],
      pi: [change(path.join(dir, ".pi/extensions/x.ts"))],
      relative: [change("notes.md", { move_path: null, type: "update" })],
      throughDangling: [change(path.join(dir, "dangling"))],
      throughLink: [change(path.join(dir, "linked/plan.md"))],
      underMcp: [change(path.join(dir, ".mcp.json/x"))],
    };
    const steps: object[] = [
      {
        send: {
          method: "item/started",
          params: {
            item: {
              command: "touch x\nmore",
              id: "cmd",
              status: "inProgress",
              type: "commandExecution",
            },
          },
        },
      },
      {
        send: {
          id: "approve-cmd",
          method: "item/commandExecution/requestApproval",
          params: {
            command: "touch x",
            itemId: "cmd",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      { response: "approve-cmd" },
      {
        send: {
          method: "item/completed",
          params: {
            item: {
              command: "touch x\nmore",
              id: "cmd",
              status: "declined",
              type: "commandExecution",
            },
          },
        },
      },
    ];
    for (const [id, changes] of Object.entries(files)) {
      steps.push(
        {
          send: {
            method: "item/started",
            params: {
              item: { changes, id, status: "inProgress", type: "fileChange" },
            },
          },
        },
        {
          send: {
            id: `approve-${id}`,
            method: "item/fileChange/requestApproval",
            params: { itemId: id, threadId: "thread-1", turnId: "turn-1" },
          },
        },
        { response: `approve-${id}` }
      );
    }
    steps.push(
      {
        send: {
          id: "approve-unknown",
          method: "item/fileChange/requestApproval",
          params: {
            itemId: "never-started",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      { response: "approve-unknown" },
      {
        send: {
          method: "item/completed",
          params: {
            item: {
              changes: files.inside,
              id: "inside",
              status: "completed",
              type: "fileChange",
            },
          },
        },
      },
      {
        send: {
          method: "item/completed",
          params: {
            item: {
              arguments: { a: 1 },
              id: "mcp1",
              server: "atelier",
              status: "failed",
              tool: "post",
              type: "mcpToolCall",
            },
          },
        },
      },
      { send: completed }
    );
    await writeFile(path.join(dir, "fake.json"), JSON.stringify({ steps }));

    try {
      const results = await collect(
        codexHarness({ executable: fake.executable, onRaw() {} }).runTurn(
          request(dir, { editsEnabled: true }),
          new AbortController().signal,
          turnInput()
        )
      );
      const calls = await fake.calls();

      const thread = calls.find((c) => c.method === "thread/start");
      const turn = calls.find((c) => c.method === "turn/start");
      expect({
        threadApprovalPolicy: at(thread, "params", "approvalPolicy"),
        threadSandbox: at(thread, "params", "sandbox"),
        turnApprovalPolicy: at(turn, "params", "approvalPolicy"),
        turnSandboxPolicy: at(turn, "params", "sandboxPolicy"),
      }).toStrictEqual({
        threadApprovalPolicy: "untrusted",
        threadSandbox: "workspace-write",
        turnApprovalPolicy: "untrusted",
        turnSandboxPolicy: {
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
          networkAccess: false,
          type: "workspaceWrite",
          writableRoots: [dir],
        },
      });

      const decision = (id: string) =>
        at(
          calls.find((c) => c.id === `approve-${id}` && c.method === undefined),
          "result",
          "decision"
        );
      const declined = [
        "outside",
        "parent",
        "git",
        "codex",
        "agents",
        "claude",
        "pi",
        "mcp",
        "nestedGit",
        "underMcp",
        "movedIntoGit",
        "mixed",
        "throughLink",
        "throughDangling",
        "unknown",
      ];
      // Keyed by id, so a failure names the request that got the wrong decision.
      const ids = ["cmd", "inside", "relative", ...declined];
      expect(
        Object.fromEntries(ids.map((id) => [id, decision(id)]))
      ).toStrictEqual({
        cmd: "decline",
        inside: "accept",
        relative: "accept",
        ...Object.fromEntries(declined.map((id) => [id, "decline"])),
      });

      const tools = results.filter(
        (e) => e.type === "tool_call" || e.type === "tool_result"
      );
      expect(
        tools.filter(
          (e) =>
            e.type === "tool_call" &&
            (e.id === "cmd" || e.id === "inside" || e.id === "mcp1")
        )
      ).toStrictEqual([
        {
          id: "cmd",
          name: "Shell",
          summary: "touch x more",
          type: "tool_call",
        },
        {
          id: "inside",
          name: "Edit",
          summary: "docs/plan.md",
          type: "tool_call",
        },
        {
          id: "mcp1",
          name: "atelier.post",
          summary: '{"a":1}',
          type: "tool_call",
        },
      ]);
      expect(tools.filter((e) => e.type === "tool_result")).toStrictEqual([
        { id: "cmd", ok: false, type: "tool_result" },
        { id: "inside", ok: true, type: "tool_result" },
        { id: "mcp1", ok: false, type: "tool_result" },
      ]);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
