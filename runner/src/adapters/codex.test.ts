import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessEvent, TurnRequest } from "@atelier/shared";
import { expect, test } from "vitest";

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

async function fakeCodex(spec: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "atelier-codex-test-"));
  const executable = join(dir, "fake.mjs");
  await writeFile(executable, FAKE, { mode: 0o700 });
  await writeFile(join(dir, "fake.json"), JSON.stringify(spec));
  return {
    dir,
    executable,
    async calls(): Promise<any[]> {
      return (await readFile(join(dir, "calls.jsonl"), "utf-8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    },
    [Symbol.asyncDispose]: async () =>
      rm(dir, { force: true, recursive: true }),
  };
}

function request(dir: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    cwd: dir,
    editsEnabled: false,
    mcpServers: [],
    prompt: "go",
    turnId: "test",
    ...extra,
  };
}

async function collect(
  events: AsyncIterable<HarnessEvent>,
  each?: (event: HarnessEvent) => void
) {
  const results: HarnessEvent[] = [];
  for await (const event of events) {
    results.push(event);
    each?.(event);
  }
  return results;
}

test("Codex review starts fresh with denied tools, disabled MCP, and never logs effective config, even a late reply", async () => {
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
  expect(calls.find((c) => c.id === 2).method).toBe("config/read");
  const start = calls.find((c) => c.method === "thread/start");
  expect(start.params.threadId).toBeUndefined();
  expect(start.params.ephemeral).toBe(true);
  expect(start.params.config["mcp_servers.fixture.enabled"]).toBe(false);
  expect(start.params.config["features.shell_tool"]).toBe(false);
  expect(start.params.config["features.goals"]).toBe(false);
  expect(start.params.config["features.multi_agent"]).toBe(false);
  expect(start.params.config["features.hooks"]).toBe(false);
  expect(start.params.sandbox).toBe("read-only");
  expect(JSON.stringify(raw)).not.toMatch(/CONFIG_SECRET/);
  expect(
    results.some((e) => e.type === "final" && e.text === "Independent answer")
  ).toBeTruthy();
});

test("Codex initialize opts into the experimental API", async () => {
  await using fake = await fakeCodex({ steps: [{ send: completed }] });
  await collect(
    codexHarness({ executable: fake.executable, onRaw() {} }).runTurn(
      request(fake.dir),
      new AbortController().signal,
      turnInput()
    )
  );
  const init = (await fake.calls()).find((c) => c.method === "initialize");
  expect(init.params.capabilities).toStrictEqual({
    experimentalApi: true,
    requestAttestation: false,
  });
});

test("Codex steers into the running turn by its id, and a refused steer resolves rejected", async () => {
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

  const steers = (await fake.calls()).filter((c) => c.method === "turn/steer");
  expect(steers).toHaveLength(2);
  expect(steers[0].params).toStrictEqual({
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "Use the second option", text_elements: [] }],
    threadId: "thread-1",
  });
});

test("Codex stop interrupts the turn before the process is killed", async () => {
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
  const interrupt = (await fake.calls()).find(
    (c) => c.method === "turn/interrupt"
  );
  expect(interrupt.params).toStrictEqual({
    threadId: "thread-1",
    turnId: "turn-1",
  });
  expect(results.some((e) => e.type === "error")).toBeTruthy();
  expect(!results.some((e) => e.type === "final")).toBeTruthy();
});

test("Codex with edits off keeps the read-only sandbox, never asks, and raises no cards", async () => {
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
  expect(harness.capabilities.canRaiseCards).toBe(false);
  await collect(
    harness.runTurn(
      request(fake.dir),
      new AbortController().signal,
      turnInput()
    )
  );
  const calls = await fake.calls();
  const thread = calls.find((c) => c.method === "thread/start");
  expect(thread.params.sandbox).toBe("read-only");
  expect(thread.params.approvalPolicy).toBe("never");
  const turn = calls.find((c) => c.method === "turn/start");
  expect(turn.params.sandboxPolicy).toStrictEqual({ type: "readOnly" });
  expect(turn.params.approvalPolicy).toBe("never");
  expect(calls.find((c) => c.id === "q1").error.code).toBe(-32_601);
});

test("Codex with edits on declines commands and accepts file changes only inside the folder and outside control files", async () => {
  await using fake = await fakeCodex({});
  const { dir } = fake;
  const outside = await mkdtemp(join(tmpdir(), "atelier-codex-outside-"));
  await mkdir(join(dir, "docs"));
  await symlink(outside, join(dir, "linked"));
  await symlink(join(outside, "missing"), join(dir, "dangling"));

  const change = (path: string, kind: object = { type: "add" }) => ({
    diff: "",
    kind,
    path,
  });
  const files: Record<string, object[]> = {
    agents: [change(join(dir, ".agents/skills/x.md"))],
    claude: [change(join(dir, ".claude/settings.json"))],
    codex: [change(join(dir, ".codex/config.toml"))],
    git: [change(join(dir, ".git/hooks/pre-commit"))],
    inside: [change(join(dir, "docs/plan.md"))],
    mcp: [change(join(dir, ".mcp.json"))],
    mixed: [change(join(dir, "ok.md")), change(join(dir, ".git/config"))],
    movedIntoGit: [
      change(join(dir, "notes.md"), {
        type: "update",
        move_path: join(dir, ".git/notes.md"),
      }),
    ],
    nestedGit: [change(join(dir, "sub/.git/config"))],
    outside: [change(join(outside, "plan.md"))],
    parent: [change(join(dir, "../escape.md"))],
    pi: [change(join(dir, ".pi/extensions/x.ts"))],
    relative: [change("notes.md", { type: "update", move_path: null })],
    throughDangling: [change(join(dir, "dangling"))],
    throughLink: [change(join(dir, "linked/plan.md"))],
    underMcp: [change(join(dir, ".mcp.json/x"))],
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
  await writeFile(join(dir, "fake.json"), JSON.stringify({ steps }));

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
    expect(thread.params.sandbox).toBe("workspace-write");
    expect(thread.params.approvalPolicy).toBe("untrusted");
    const turn = calls.find((c) => c.method === "turn/start");
    expect(turn.params.approvalPolicy).toBe("untrusted");
    expect(turn.params.sandboxPolicy).toStrictEqual({
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      networkAccess: false,
      type: "workspaceWrite",
      writableRoots: [dir],
    });

    const decision = (id: string) =>
      calls.find((c) => c.id === `approve-${id}` && !c.method)?.result
        ?.decision;
    expect(decision("cmd")).toBe("decline");
    expect(decision("inside")).toBe("accept");
    expect(decision("relative")).toBe("accept");
    for (const id of [
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
    ]) {
      expect(decision(id), id).toBe("decline");
    }

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
