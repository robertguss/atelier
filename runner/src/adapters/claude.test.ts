import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  HarnessEvent,
  QuestionAnswer,
  QuestionCard,
  SteerOutcome,
  TurnInput,
} from "@atelier/shared";
import { assert, describe, expect, it, vi } from "vitest";

import { claudeHarness } from "./claude.ts";
import { turnInput } from "./events.ts";

// A stand-in for the `claude` CLI that speaks the stream-json and control
// protocol the Agent SDK uses. It logs its argv and every stdin line to
// calls.jsonl, then plays script.json once the first user message arrives.
// Steps: {emit}, {permission: {id, tool_name, input}}, {waitUser}, {waitFile}.
// "$STEER" in a step is replaced by the uuid of the last user message that
// arrived after the first, and "$CWD" by the folder it runs in.
// `cancelled` answers cancel_async_message.
const FAKE_CLI = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const script = JSON.parse(readFileSync('script.json', 'utf8'));
const log = (x) => appendFileSync('calls.jsonl', JSON.stringify(x) + '\\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
log({ argv: process.argv.slice(2) });
const answers = new Map();
const later = [];
let started = false, eof = false, done = false;
const exit = () => { if (eof && done) process.exit(0); };
async function play() {
  for (const raw of script.steps) {
    const step = JSON.parse(JSON.stringify(raw).replaceAll('$STEER', later.at(-1)?.uuid ?? '').replaceAll('$CWD', process.cwd()));
    if (step.emit) out({ session_id: 'S1', ...step.emit });
    if (step.permission) {
      const { id, tool_name, input } = step.permission;
      out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: id } });
      while (!answers.has(id)) await sleep(5);
      log({ permissionResult: id, response: answers.get(id) });
    }
    if (step.waitUser) while (!later.length) await sleep(5);
    if (step.waitFile) while (!existsSync(step.waitFile)) await sleep(5);
  }
  done = true; exit();
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); log(m);
  if (m.type === 'control_request') {
    const response = m.request.subtype === 'cancel_async_message' ? { cancelled: script.cancelled ?? true } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  } else if (m.type === 'control_response') answers.set(m.response.request_id, m.response.response);
  else if (m.type === 'user') { if (started) later.push(m); else { started = true; play(); } }
}).on('close', () => { eof = true; log({ eof: true }); exit(); });
`;

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

// The same expected value for every id, keyed by id.
const everyId = (ids: string[], expected: unknown) =>
  Object.fromEntries(ids.map((id) => [id, expected]));

const roomTools = {
  token: "ROOM-TOKEN-SECRET",
  url: "http://127.0.0.1:40123/mcp",
};

// The names of the Atelier tools the SDK declared in its initialize request.
const atelierToolNames = (calls: Record<string, unknown>[]) => {
  const initialize = calls.find(
    (c) =>
      c.type === "control_request" &&
      at(c, "request", "subtype") === "initialize"
  );
  const tools = at(
    initialize,
    "request",
    "sdkMcpServerManifests",
    "atelier",
    "toolsListResult",
    "tools"
  );
  return Array.isArray(tools) ? tools.map((tool) => at(tool, "name")) : [];
};

const init = { emit: { subtype: "init", type: "system", uuid: "i1" } };
const result = (text: string) => ({
  emit: {
    is_error: false,
    result: text,
    subtype: "success",
    total_cost_usd: 0.01,
    type: "result",
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: `r-${text}`,
  },
});
const backgroundTasks = (tasks: { ambient?: boolean }[]) => ({
  emit: {
    subtype: "background_tasks_changed",
    tasks: tasks.map((task, i) => ({
      description: `task ${i}`,
      task_id: `b${i}`,
      task_type: "local_bash",
      ...task,
    })),
    type: "system",
    uuid: `bg-${tasks.length}`,
  },
});
const streamed = (id: string, text: string) => [
  {
    emit: {
      event: { message: { id }, type: "message_start" },
      parent_tool_use_id: null,
      type: "stream_event",
      uuid: `ms-${id}`,
    },
  },
  {
    emit: {
      event: {
        delta: { text, type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      parent_tool_use_id: null,
      type: "stream_event",
      uuid: `d-${id}`,
    },
  },
];
const toolUse = (id: string, name: string, input: unknown) => ({
  emit: {
    message: {
      content: [{ id, input, name, type: "tool_use" }],
      role: "assistant",
    },
    parent_tool_use_id: null,
    type: "assistant",
    uuid: `a-${id}`,
  },
});
const permission = (id: string, tool_name: string, input: unknown) => ({
  permission: { id, input, tool_name },
});

interface Options {
  editsEnabled?: boolean;
  independentReview?: boolean;
  scribe?: boolean;
  resumeSessionId?: string;
  roomTools?: { url: string; token: string };
  cancelled?: boolean;
  onQuestion?: (card: QuestionCard) => Promise<QuestionAnswer>;
  onEvent?: (ev: HarnessEvent, input: TurnInput, cwd: string) => void;
  setup?: (cwd: string) => Promise<void>;
}

const runFake = async (steps: unknown[], opts: Options = {}) => {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "atelier-claude-test-"))
  );
  const cwd = path.join(dir, "room");
  await mkdir(cwd);
  const executable = path.join(dir, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLI, { mode: 0o700 });
  await writeFile(
    path.join(cwd, "script.json"),
    JSON.stringify({ cancelled: opts.cancelled, steps })
  );
  await opts.setup?.(cwd);
  const input = turnInput(opts.onQuestion);
  const events: HarnessEvent[] = [];
  try {
    const harness = claudeHarness({ executable, onRaw() {} });
    const turn = harness.runTurn(
      {
        cwd,
        editsEnabled: opts.editsEnabled ?? false,
        independentReview: opts.independentReview,
        mcpServers: [],
        prompt: "Plan the launch",
        ...(opts.scribe === true ? { scribe: true } : {}),
        ...(opts.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: opts.resumeSessionId }),
        ...(opts.roomTools === undefined ? {} : { roomTools: opts.roomTools }),
        turnId: "test",
      },
      new AbortController().signal,
      input
    );
    for await (const ev of turn) {
      events.push(ev);
      opts.onEvent?.(ev, input, cwd);
    }
    const log = await readFile(path.join(cwd, "calls.jsonl"), "utf-8");
    const calls = log
      .trim()
      .split("\n")
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        assert(isRecord(parsed), `calls.jsonl holds a non-object: ${line}`);
        return parsed;
      });
    const decision = (id: string): unknown =>
      calls.find((c) => c.permissionResult === id)?.response;
    return { calls, cwd, decision, events, input };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const finalsOf = async (steps: unknown[]) => {
  const { events } = await runFake([init, ...steps]);
  return events.filter((e) => e.type === "final");
};
describe(claudeHarness, () => {
  it("AskUserQuestion becomes a card, and the answer maps back by question text", async () => {
    const cards: QuestionCard[] = [];
    const questions = [
      {
        header: "Color",
        multiSelect: false,
        options: [
          { description: "warm", label: "Red" },
          { description: "cool", label: "Blue" },
        ],
        question: "Which color?",
      },
      {
        header: "Size",
        multiSelect: true,
        options: [
          { description: "", label: "S" },
          { description: "", label: "M" },
          { description: "", label: "L" },
        ],
        question: "Which sizes?",
      },
      {
        header: "Notes",
        multiSelect: false,
        options: [
          { description: "", label: "No" },
          { description: "", label: "Yes" },
        ],
        question: "Anything else?",
      },
    ];
    const { decision } = await runFake(
      [
        init,
        permission("ask1", "AskUserQuestion", { questions }),
        result("ok"),
      ],
      {
        onQuestion: async (card) => {
          cards.push(card);
          const [color, sizes, notes] = card.questions.map((q) => q.id);
          assert(
            color !== undefined && sizes !== undefined && notes !== undefined
          );
          return await Promise.resolve<QuestionAnswer>({
            answeredBy: "Robert",
            answers: [
              { labels: ["Blue"], question: "Which color?", questionId: color },
              {
                labels: ["S", "L"],
                question: "Which sizes?",
                questionId: sizes,
              },
              {
                freeText: "Ship it Friday",
                labels: [],
                question: "Anything else?",
                questionId: notes,
              },
            ],
            handId: "h1",
            requestId: card.requestId,
            via: "card",
          });
        },
      }
    );
    const [card] = cards;
    assert(card !== undefined, "a card was raised");
    const [first, second] = card.questions;
    assert(first !== undefined, "the card has a first question");
    expect({
      cardCount: cards.length,
      requestId: card.requestId,
      secondMultiSelect: second?.multiSelect,
      uniqueIds: new Set(card.questions.map((q) => q.id)).size,
    }).toStrictEqual({
      cardCount: 1,
      requestId: "ask1",
      secondMultiSelect: true,
      uniqueIds: 3,
    });
    expect(first).toStrictEqual({
      allowFreeText: true,
      header: "Color",
      id: first.id,
      multiSelect: false,
      options: [
        { description: "warm", label: "Red" },
        { description: "cool", label: "Blue" },
      ],
      text: "Which color?",
    });
    const response = decision("ask1");
    expect({
      answers: at(response, "updatedInput", "answers"),
      behavior: at(response, "behavior"),
      questions: at(response, "updatedInput", "questions"),
    }).toStrictEqual({
      answers: {
        "Anything else?": "Ship it Friday",
        "Which color?": "Blue",
        "Which sizes?": "S, L",
      },
      behavior: "allow",
      questions,
    });
    const mentionsRobert: unknown = expect.stringMatching(/Robert/u);
    expect(
      questions.map((q) =>
        at(response, "updatedInput", "annotations", q.question, "notes")
      )
    ).toStrictEqual(questions.map(() => mentionsRobert));
  });

  it("a chat answer tells Claude one message answers every question, and a card answer keeps its short note", async () => {
    const questions = [
      {
        header: "Color",
        options: [{ label: "Red" }],
        question: "Which color?",
      },
      { header: "Size", options: [{ label: "S" }], question: "Which size?" },
    ];
    const notesFor = async (via: "chat" | "card") => {
      const { decision } = await runFake(
        [
          init,
          permission("ask1", "AskUserQuestion", { questions }),
          result("ok"),
        ],
        {
          onQuestion: async (card) =>
            await Promise.resolve<QuestionAnswer>({
              answeredBy: "Dana",
              answers: card.questions.map((q) => ({
                freeText: "Red, small",
                labels: [],
                question: q.text,
                questionId: q.id,
              })),
              handId: "h1",
              requestId: card.requestId,
              via,
            }),
        }
      );
      const response = decision("ask1");
      return questions.map((q) =>
        at(response, "updatedInput", "annotations", q.question, "notes")
      );
    };
    const chat = await notesFor("chat");
    const card = await notesFor("card");
    expect({ card, chat }).toStrictEqual({
      card: ["Answered by Dana", "Answered by Dana"],
      chat: [
        "Answered in chat by Dana. The one message answers every question on the card.",
        "Answered in chat by Dana. The one message answers every question on the card.",
      ],
    });
  });

  it("a card closed without an answer tells Claude no decision was made", async () => {
    const questions = [
      {
        header: "Color",
        multiSelect: false,
        options: [
          { description: "", label: "Red" },
          { description: "", label: "Blue" },
        ],
        question: "Which color?",
      },
    ];
    const { decision } = await runFake(
      [
        init,
        permission("ask1", "AskUserQuestion", { questions }),
        result("ok"),
      ],
      {
        onQuestion: async (card) =>
          await Promise.resolve<QuestionAnswer>({
            handId: "h1",
            message: "No one answered in time; no decision was made.",
            noDecision: true,
            requestId: card.requestId,
          }),
      }
    );
    const response = decision("ask1");
    expect(at(response, "behavior")).toBe("allow");
    expect(at(response, "updatedInput", "answers", "Which color?")).toMatch(
      /no decision was made/iu
    );
  });

  it("with the edit switch off, edits and unapproved commands are denied", async () => {
    const { decision, calls } = await runFake([
      init,
      permission("w1", "Write", { content: "x", file_path: "plan.md" }),
      permission("b1", "Bash", { command: "rm -rf build" }),
      result("ok"),
    ]);
    expect(at(calls[0], "argv")).toContain("--permission-mode=default");
    expect(at(decision("w1"), "behavior")).toBe("deny");
    expect(at(decision("b1"), "behavior")).toBe("deny");
  });

  it("with the edit switch on, only edits inside the folder and outside control paths are allowed", async () => {
    const outside = await realpath(
      await mkdtemp(path.join(tmpdir(), "atelier-claude-outside-"))
    );
    try {
      const { decision } = await runFake(
        [
          init,
          permission("in", "Write", {
            content: "x",
            file_path: "docs/plan.md",
          }),
          permission("abs", "Edit", {
            file_path: "$CWD/notes.md",
            new_string: "b",
            old_string: "a",
          }),
          permission("nb", "NotebookEdit", {
            new_source: "x",
            notebook_path: "analysis.ipynb",
          }),
          permission("up", "Write", {
            content: "x",
            file_path: "../escape.md",
          }),
          permission("away", "Write", {
            content: "x",
            file_path: path.join(outside, "x.md"),
          }),
          permission("link", "Write", {
            content: "x",
            file_path: "linked/x.md",
          }),
          permission("dangling", "Write", {
            content: "x",
            file_path: "dangling.md",
          }),
          permission("claude", "Write", {
            content: "{}",
            file_path: ".claude/settings.local.json",
          }),
          permission("hook", "Write", {
            content: "x",
            file_path: ".git/hooks/pre-commit",
          }),
          permission("mcp", "Write", { content: "{}", file_path: ".mcp.json" }),
          permission("codex", "Write", {
            content: "x",
            file_path: ".codex/config.toml",
          }),
          permission("pi", "Write", {
            content: "x",
            file_path: "sub/.pi/x.json",
          }),
          permission("agents", "Write", {
            content: "x",
            file_path: ".agents/skills/x.md",
          }),
          permission("bash", "Bash", { command: "rm -rf build" }),
          result("ok"),
        ],
        {
          editsEnabled: true,
          async setup(cwd) {
            await mkdir(path.join(cwd, ".git", "hooks"), { recursive: true });
            await symlink(outside, path.join(cwd, "linked"));
            await symlink(
              path.join(outside, "gone.md"),
              path.join(cwd, "dangling.md")
            );
          },
        }
      );
      const allowed = ["in", "abs", "nb"];
      const denied = [
        "up",
        "away",
        "link",
        "dangling",
        "claude",
        "hook",
        "mcp",
        "codex",
        "pi",
        "agents",
        "bash",
      ];
      // Keyed by id, so a failure names the request that got the wrong decision.
      const behaviors = (ids: string[]) =>
        Object.fromEntries(ids.map((id) => [id, at(decision(id), "behavior")]));
      expect(behaviors(allowed)).toStrictEqual(everyId(allowed, "allow"));
      expect(at(decision("in"), "updatedInput")).toStrictEqual({
        content: "x",
        file_path: "docs/plan.md",
      });
      expect(behaviors(denied)).toStrictEqual(everyId(denied, "deny"));
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("turning the switch off mid-turn denies the next edit", async () => {
    const { decision } = await runFake(
      [
        init,
        permission("w1", "Write", { content: "x", file_path: "a.md" }),
        toolUse("marker", "Read", { file_path: "a.md" }),
        { waitFile: "go" },
        permission("w2", "Write", { content: "x", file_path: "b.md" }),
        result("ok"),
      ],
      {
        editsEnabled: true,
        onEvent(ev, input, cwd) {
          if (ev.type === "tool_call" && ev.id === "marker") {
            input.setEditsEnabled(false);
            void writeFile(path.join(cwd, "go"), "");
          }
        },
      }
    );
    expect(at(decision("w1"), "behavior")).toBe("allow");
    expect(at(decision("w2"), "behavior")).toBe("deny");
  });

  it("a steer goes in mid-turn with priority next and resolves steered when folded", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const { events, calls } = await runFake(
      [
        init,
        toolUse("t1", "Bash", { command: "sleep 6" }),
        { waitUser: true },
        {
          emit: {
            command_uuid: "$STEER",
            state: "queued",
            type: "command_lifecycle",
          },
        },
        {
          emit: {
            message: {
              content: [
                { content: "done", tool_use_id: "t1", type: "tool_result" },
              ],
              role: "user",
            },
            parent_tool_use_id: null,
            type: "user",
            uuid: "u1",
          },
        },
        {
          emit: {
            command_uuid: "$STEER",
            state: "started",
            type: "command_lifecycle",
          },
        },
        {
          emit: {
            status: null,
            subtype: "status",
            type: "system",
            user_message_uuids: ["first", "$STEER"],
            uuid: "s1",
          },
        },
        toolUse("t2", "Bash", { command: "false" }),
        {
          emit: {
            message: {
              content: [
                {
                  content: "exit 1",
                  is_error: true,
                  tool_use_id: "t2",
                  type: "tool_result",
                },
              ],
              role: "user",
            },
            parent_tool_use_id: null,
            type: "user",
            uuid: "u2",
          },
        },
        result("Done, in blue"),
      ],
      {
        onEvent(ev, input) {
          if (ev.type === "tool_call" && ev.id === "t1") {
            steer = input.steer("Use blue instead");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("steered");
    const pushed = calls.filter((c) => c.type === "user").slice(1);
    const [steered] = pushed;
    const uuidPattern: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/u);
    expect({
      count: pushed.length,
      message: at(steered, "message"),
      parentToolUseId: at(steered, "parent_tool_use_id"),
      priority: at(steered, "priority"),
      uuid: at(steered, "uuid"),
    }).toStrictEqual({
      count: 1,
      message: { content: "Use blue instead", role: "user" },
      parentToolUseId: null,
      priority: "next",
      uuid: uuidPattern,
    });
    expect({
      finalEvent: events.at(-1),
      inputClosesAfterResult: calls.some((c) => c.eof === true),
      tools: events.filter(
        (e) => e.type === "tool_call" || e.type === "tool_result"
      ),
    }).toStrictEqual({
      finalEvent: { narration: "", text: "Done, in blue", type: "final" },
      inputClosesAfterResult: true,
      tools: [
        { id: "t1", name: "Bash", summary: "sleep 6", type: "tool_call" },
        { id: "t1", ok: true, type: "tool_result" },
        { id: "t2", name: "Bash", summary: "false", type: "tool_call" },
        { id: "t2", ok: false, type: "tool_result" },
      ],
    });
  });

  it("the final event carries the text streamed before the answer as narration", async () => {
    const oneResult = await finalsOf([
      ...streamed("m1", "Let me check"),
      toolUse("t1", "Read", { file_path: "a.md" }),
      ...streamed("m2", "The answer"),
      result("The answer"),
    ]);
    const twoResults = await finalsOf([
      ...streamed("m1", "A"),
      toolUse("t1", "Bash", { command: "ls" }),
      result("A"),
      toolUse("t2", "Bash", { command: "ls" }),
      ...streamed("m2", "B"),
      result("B"),
    ]);
    const noNarration = await finalsOf([
      ...streamed("m1", "Just the answer"),
      result("Just the answer"),
    ]);
    expect({ noNarration, oneResult, twoResults }).toStrictEqual({
      noNarration: [{ narration: "", text: "Just the answer", type: "final" }],
      oneResult: [
        { narration: "Let me check", text: "The answer", type: "final" },
      ],
      twoResults: [
        { narration: "", text: "A", type: "final" },
        { narration: "", text: "A\n\nB", type: "final" },
      ],
    });
  });

  it("a steer not folded before the result is withdrawn and rejected", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const {
      calls,
      events,
      input: channel,
    } = await runFake(
      [
        init,
        toolUse("t1", "Bash", { command: "sleep 6" }),
        { waitUser: true },
        result("first"),
      ],
      {
        cancelled: true,
        onEvent(ev, input) {
          if (ev.type === "tool_call") {
            steer = input.steer("Too late");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("rejected");
    const [, steerMessage] = calls.filter((c) => c.type === "user");
    assert(steerMessage !== undefined, "the steer reached the CLI");
    const { uuid } = steerMessage;
    expect(
      calls.some(
        (c) =>
          c.type === "control_request" &&
          at(c, "request", "subtype") === "cancel_async_message" &&
          at(c, "request", "message_uuid") === uuid
      )
    ).toBeTruthy();
    expect(calls.some((c) => c.eof === true)).toBeTruthy();
    expect(events.at(-1)).toStrictEqual({
      narration: "",
      text: "first",
      type: "final",
    });
    await expect(channel.steer("After the turn")).resolves.toBe("rejected");
  });

  it("a late steer the CLI could not withdraw runs on in the same turn and counts as steered", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const { events } = await runFake(
      [
        init,
        toolUse("t1", "Bash", { command: "sleep 6" }),
        { waitUser: true },
        result("first"),
        {
          emit: {
            command_uuid: "$STEER",
            state: "started",
            type: "command_lifecycle",
          },
        },
        result("second"),
      ],
      {
        cancelled: false,
        onEvent(ev, input) {
          if (ev.type === "tool_call") {
            steer = input.steer("One more thing");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("steered");
    expect(events.findLast((e) => e.type === "final")).toStrictEqual({
      narration: "",
      text: "first\n\nsecond",
      type: "final",
    });
  });

  it("while a background task runs after the result, a steer is still taken and runs", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const { calls, events } = await runFake(
      [
        init,
        backgroundTasks([{ ambient: false }]),
        result("started"),
        { waitUser: true },
        {
          emit: {
            command_uuid: "$STEER",
            state: "started",
            type: "command_lifecycle",
          },
        },
        result("steered"),
        backgroundTasks([]),
        result("finished"),
      ],
      {
        onEvent(ev, input) {
          if (ev.type === "final" && ev.text === "started") {
            steer = input.steer("Say steered");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("steered");
    const [, steered] = calls.filter((c) => c.type === "user");
    expect({
      inputClosed: calls.some((c) => c.eof === true),
      last: events.findLast((e) => e.type === "final"),
      priority: at(steered, "priority"),
      withdrawn: calls.some(
        (c) =>
          c.type === "control_request" &&
          at(c, "request", "subtype") === "cancel_async_message"
      ),
    }).toStrictEqual({
      inputClosed: true,
      last: {
        narration: "",
        text: "started\n\nsteered\n\nfinished",
        type: "final",
      },
      priority: "next",
      withdrawn: false,
    });
  });

  it("an ambient background task does not hold the input open after the result", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const { calls } = await runFake(
      [
        init,
        toolUse("t1", "Bash", { command: "sleep 6" }),
        backgroundTasks([{ ambient: true }]),
        { waitUser: true },
        result("only"),
      ],
      {
        cancelled: true,
        onEvent(ev, input) {
          if (ev.type === "tool_call") {
            steer = input.steer("Too late");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("rejected");
    expect(calls.some((c) => c.eof === true)).toBeTruthy();
  });

  it("the input closes once the background tasks finish, withdrawing a steer that has not run", async () => {
    let steer: Promise<SteerOutcome> | undefined;
    const { calls } = await runFake(
      [
        init,
        backgroundTasks([{ ambient: false }]),
        result("started"),
        { waitUser: true },
        backgroundTasks([]),
        result("finished"),
      ],
      {
        cancelled: true,
        onEvent(ev, input) {
          if (ev.type === "final" && ev.text === "started") {
            steer = input.steer("Too slow");
          }
        },
      }
    );
    await expect(steer).resolves.toBe("rejected");
    expect({
      inputClosed: calls.some((c) => c.eof === true),
      withdrawn: calls.some(
        (c) =>
          c.type === "control_request" &&
          at(c, "request", "subtype") === "cancel_async_message"
      ),
    }).toStrictEqual({ inputClosed: true, withdrawn: true });
  });

  it("independent review options are unchanged, with no Atelier server even if a route is passed", async () => {
    let steered: SteerOutcome | undefined;
    const { calls } = await runFake([init, result("review")], {
      independentReview: true,
      onEvent(ev, input) {
        if (ev.type === "session") {
          void input.steer("x").then((outcome) => {
            steered = outcome;
            return outcome;
          });
        }
      },
      roomTools,
    });
    expect(at(calls[0], "argv")).toStrictEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool=stdio",
      "--allowedTools=Skill",
      "--tools=",
      "--setting-sources=user,project,local",
      "--strict-mcp-config",
      "--permission-mode=dontAsk",
      "--include-partial-messages",
      "--no-session-persistence",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
    const [, initializeCall, userCall] = calls;
    assert(initializeCall !== undefined, "the SDK sent initialize");
    const { request_id: _id, ...initialize } = initializeCall;
    expect(initialize).toStrictEqual({
      request: {
        hooks: { PreToolUse: [{ hookCallbackIds: ["hook_0"] }] },
        subtype: "initialize",
        systemPrompt: [""],
      },
      type: "control_request",
    });
    expect(userCall).toStrictEqual({
      message: {
        content: [{ text: "Plan the launch", type: "text" }],
        role: "user",
      },
      parent_tool_use_id: null,
      session_id: "",
      type: "user",
    });
    expect(steered).toBe("rejected");
  });

  it("an ordinary Claude turn gets the in-process Atelier server without raise_hand, with no route or token in its arguments", async () => {
    const { calls } = await runFake([init, result("ok")], { roomTools });
    // In-process servers are declared in initialize, not passed as --mcp-config,
    // and without --strict-mcp-config the user's own MCP servers still load.
    expect(at(calls[0], "argv")).toStrictEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool=stdio",
      "--allowedTools=Skill",
      "--setting-sources=user,project,local",
      "--permission-mode=default",
      "--include-partial-messages",
      "--settings",
      JSON.stringify({
        enabledPlugins: { "context-mode@context-mode": false },
      }),
    ]);
    expect(atelierToolNames(calls)).toStrictEqual([
      "read_document",
      "read_thread",
      "add_block",
      "update_block",
      "delete_block",
      "comment",
      "read_handbook",
      "recent_decisions",
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/ROOM-TOKEN-SECRET|40123/u);
  });

  it.each([{ resumeSessionId: "ordinary-session" }, { scribe: true }])(
    "keeps large room replies readable for resumed and scribe turns: %j",
    async (mode) => {
      const { calls } = await runFake([init, result("ok")], {
        ...mode,
        roomTools,
      });
      const argv = at(calls[0], "argv");
      assert(Array.isArray(argv));
      expect(
        JSON.parse(String(argv[argv.indexOf("--settings") + 1]))
      ).toStrictEqual({
        enabledPlugins: { "context-mode@context-mode": false },
      });
    }
  );

  it("canUseTool allows the Atelier document tools and still denies other unapproved tools", async () => {
    const { decision } = await runFake(
      [
        init,
        permission("doc", "mcp__atelier__add_block", {
          kind: "paragraph",
          text: "We chose blue.",
        }),
        permission("other", "mcp__elsewhere__post", { a: 1 }),
        permission("lookalike", "mcp__atelier_evil__post", { a: 1 }),
        permission("bash", "Bash", { command: "rm -rf build" }),
        result("ok"),
      ],
      { roomTools }
    );
    expect(at(decision("doc"), "behavior")).toBe("allow");
    expect(at(decision("doc"), "updatedInput")).toStrictEqual({
      kind: "paragraph",
      text: "We chose blue.",
    });
    expect(
      Object.fromEntries(
        ["other", "lookalike", "bash"].map((id) => [
          id,
          at(decision(id), "behavior"),
        ])
      )
    ).toStrictEqual(everyId(["other", "lookalike", "bash"], "deny"));
  });

  it("a Claude document tool call shows up as a turn item with the tool name and no token", async () => {
    const { events } = await runFake(
      [
        init,
        toolUse("doc-1", "mcp__atelier__add_block", {
          kind: "paragraph",
          text: "We chose blue.",
        }),
        {
          emit: {
            message: {
              content: [
                {
                  content: "Added block b1 at rev 1.",
                  tool_use_id: "doc-1",
                  type: "tool_result",
                },
              ],
              role: "user",
            },
            parent_tool_use_id: null,
            type: "user",
            uuid: "u1",
          },
        },
        result("ok"),
      ],
      { roomTools }
    );
    expect(
      events.filter((e) => e.type === "tool_call" || e.type === "tool_result")
    ).toStrictEqual([
      {
        id: "doc-1",
        name: "mcp__atelier__add_block",
        summary: "",
        type: "tool_call",
      },
      { id: "doc-1", ok: true, type: "tool_result" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ROOM-TOKEN-SECRET/u);
  });

  it("a Claude scribe turn starts a fresh session it never saves, gets the scribe tools, and has its question cards denied", async () => {
    const onQuestion = vi.fn<(card: QuestionCard) => Promise<QuestionAnswer>>();
    const questions = [
      {
        header: "Merge",
        multiSelect: false,
        options: [
          { description: "", label: "Yes" },
          { description: "", label: "No" },
        ],
        question: "Merge these?",
      },
    ];
    const { calls, decision } = await runFake(
      [
        init,
        permission("ask1", "AskUserQuestion", { questions }),
        permission("w1", "Write", { content: "x", file_path: "plan.md" }),
        result("ok"),
      ],
      {
        editsEnabled: false,
        onQuestion,
        resumeSessionId: "ordinary-session",
        roomTools,
        scribe: true,
      }
    );
    const argv = at(calls[0], "argv");
    expect({
      argvKeepsOrdinarySession: /ordinary-session|--resume/u.test(
        JSON.stringify(argv)
      ),
      asked: onQuestion.mock.calls.length > 0,
      persistence: Array.isArray(argv)
        ? argv.includes("--no-session-persistence")
        : undefined,
      questionDecision: [
        at(decision("ask1"), "behavior"),
        String(at(decision("ask1"), "message")).includes(
          "without asking questions"
        ),
      ],
      tools: atelierToolNames(calls),
      writeDecision: at(decision("w1"), "behavior"),
    }).toStrictEqual({
      argvKeepsOrdinarySession: false,
      asked: false,
      persistence: true,
      questionDecision: ["deny", true],
      tools: [
        "read_document",
        "draft_keep",
        "draft_replace",
        "draft_add",
        "draft_remove",
        "draft_move",
      ],
      writeDecision: "deny",
    });
  });
});
