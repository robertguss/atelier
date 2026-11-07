import { randomUUID } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Harness,
  HarnessEvent,
  QuestionAnswer,
  QuestionCard,
  SteerOutcome,
  TurnRequest,
} from "@atelier/shared";

import { execFileAsync } from "../exec.ts";
import { loopbackCaller } from "../room-tools-server.ts";
import {
  claudeRoomToolsServer,
  claudeTools,
  scribeTools,
} from "../room-tools.ts";
import { eventQueue } from "./events.ts";

// The in-process room tools server is named `atelier`.
const ROOM_TOOL_PREFIX = "mcp__atelier__";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
// Harness and repository control files. Writing one could add an allow rule,
// hook or extension that runs commands on a later turn.
const PROTECTED = new Set([
  ".claude",
  ".mcp.json",
  ".codex",
  ".pi",
  ".agents",
  ".git",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const summarize = (input: unknown): string => {
  if (!isRecord(input)) {
    return "";
  }
  const pick =
    input.file_path ??
    input.path ??
    input.pattern ??
    input.command ??
    input.url ??
    input.query;
  return typeof pick === "string" ? pick.slice(0, 200) : "";
};

// A prompt the SDK reads as a stream, so steers can follow the first message.
const messageStream = () => {
  const stream = eventQueue<SDKUserMessage>();
  return Object.assign(stream, {
    close: () => {
      stream.end();
    },
  });
};

// Takes a pushed message back out of the CLI's queue. The SDK has this
// control request but doesn't type the method yet.
const withdraw = async (q: Query, uuid: string) => {
  try {
    const withdrawn = await (
      q as Query & {
        cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
      }
    ).cancelAsyncMessage?.(uuid);
    return withdrawn === true;
  } catch {
    return false;
  }
};

const deny = (message: string): PermissionResult => ({
  behavior: "deny",
  message,
});

interface AskedQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

const isAskedOption = (
  value: unknown
): value is { label: string; description?: string } =>
  isRecord(value) &&
  typeof value.label === "string" &&
  (value.description === undefined || typeof value.description === "string");

const isAskedQuestion = (value: unknown): value is AskedQuestion =>
  isRecord(value) &&
  typeof value.question === "string" &&
  (value.header === undefined || typeof value.header === "string") &&
  (value.options === undefined ||
    (Array.isArray(value.options) && value.options.every(isAskedOption))) &&
  (value.multiSelect === undefined || typeof value.multiSelect === "boolean");

// The questions AskUserQuestion's input carries, or none if they don't have
// the shape its schema promises.
const askedQuestions = (value: unknown): AskedQuestion[] =>
  Array.isArray(value) && value.every(isAskedQuestion) ? value : [];

const answerNote = (name: string, via: "card" | "chat") =>
  via === "chat"
    ? `Answered in chat by ${name}. The one message answers every question on the card.`
    : `Answered by ${name}`;

// Puts Claude's question prompt to the room as a card and hands back the
// first answer in the shape AskUserQuestion expects: answers keyed by
// question text, with who answered in the notes.
const askRoom = async (
  toolInput: Record<string, unknown>,
  toolUseID: string,
  onQuestion: (card: QuestionCard) => Promise<QuestionAnswer>
): Promise<PermissionResult> => {
  const asked = askedQuestions(toolInput.questions);
  const card: QuestionCard = {
    questions: asked.map((q, i) => ({
      allowFreeText: true,
      header: q.header ?? "",
      id: `q${i + 1}`,
      multiSelect: q.multiSelect === true,
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        ...(o.description === undefined || o.description === ""
          ? {}
          : { description: o.description }),
      })),
      text: q.question,
    })),
    requestId: toolUseID,
  };
  const answer = await onQuestion(card);
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  if ("noDecision" in answer) {
    for (const q of asked) {
      answers[q.question] = answer.message;
    }
  } else {
    for (const a of answer.answers) {
      const question =
        asked[card.questions.findIndex((q) => q.id === a.questionId)]
          ?.question ?? a.question;
      answers[question] = [
        ...a.labels,
        ...(a.freeText === undefined || a.freeText === "" ? [] : [a.freeText]),
      ].join(", ");
      annotations[question] = {
        notes: answerNote(answer.answeredBy, answer.via),
      };
    }
  }
  return {
    behavior: "allow",
    updatedInput: {
      ...toolInput,
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  };
};

// realpath for a file that may not exist yet: resolves through its nearest
// existing parent, and follows a symlink whose target is missing.
const resolveReal = async (filePath: string): Promise<string> => {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  let link: string | undefined;
  try {
    link = await readlink(filePath);
  } catch {
    // Not a symlink, or missing.
  }
  if (link !== undefined) {
    return await resolveReal(path.resolve(path.dirname(filePath), link));
  }
  const parent = path.dirname(filePath);
  if (parent === filePath) {
    return filePath;
  }
  return path.resolve(await resolveReal(parent), path.basename(filePath));
};

// True if the path, with symlinks resolved, is inside cwd and not under a
// harness or repository control path.
const editableInFolder = async (cwd: string, target: string) => {
  try {
    const root = await realpath(cwd);
    const rel = path.relative(
      root,
      await resolveReal(path.resolve(cwd, target))
    );
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return false;
    }
    return !rel.split(path.sep).some((part) => PROTECTED.has(part));
  } catch {
    return false;
  }
};

// Subagent output stays in the transcript.
const fromSubagent = (parentToolUseId: string | null) =>
  parentToolUseId !== null && parentToolUseId !== "";

// Steers the CLI reports as folded into the turn, or started as the next turn.
const steeredUuids = (msg: SDKMessage): string[] => {
  const raw: unknown = msg;
  if (!isRecord(raw)) {
    return [];
  }
  const uuids = Array.isArray(raw.user_message_uuids)
    ? raw.user_message_uuids.filter(
        (uuid): uuid is string => typeof uuid === "string"
      )
    : [];
  if (
    raw.type === "command_lifecycle" &&
    raw.state === "started" &&
    typeof raw.command_uuid === "string" &&
    raw.command_uuid !== ""
  ) {
    uuids.push(raw.command_uuid);
  }
  return uuids;
};

interface StreamState {
  sawText: boolean;
  finals: string[];
  messages: string[];
  narrations: string[];
  usage: { inputTokens: number; outputTokens: number };
}

const streamEvents = (
  msg: Extract<SDKMessage, { type: "stream_event" }>,
  state: StreamState
): HarnessEvent[] => {
  if (fromSubagent(msg.parent_tool_use_id)) {
    return [];
  }
  const ev = msg.event;
  const events: HarnessEvent[] = [];
  if (ev.type === "message_start") {
    state.messages.push("");
    if (state.sawText) {
      events.push({ text: "\n\n", type: "text_delta" });
    }
  }
  if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
    state.sawText = true;
    state.messages.push((state.messages.pop() ?? "") + ev.delta.text);
    events.push({ text: ev.delta.text, type: "text_delta" });
  }
  return events;
};

const resultEvents = (
  msg: Extract<SDKMessage, { type: "result" }>,
  state: StreamState
): HarnessEvent[] => {
  state.usage.inputTokens += msg.usage.input_tokens ?? 0;
  state.usage.outputTokens += msg.usage.output_tokens ?? 0;
  const usage: HarnessEvent = {
    type: "usage",
    ...state.usage,
    costUsd: msg.total_cost_usd,
  };
  if (msg.subtype === "success" && !msg.is_error) {
    state.finals.push(msg.result);
    const reported = state.messages.findLastIndex((m) => m !== "");
    state.narrations.push(
      ...state.messages.filter((m, i) => m !== "" && i !== reported)
    );
    state.messages = [];
    return [
      usage,
      {
        narration: state.narrations.join("\n\n"),
        text: state.finals.filter(Boolean).join("\n\n"),
        type: "final",
      },
    ];
  }
  const detail =
    "errors" in msg && Array.isArray(msg.errors)
      ? msg.errors.join("; ")
      : msg.subtype;
  return [
    usage,
    {
      message: `Claude turn ended with ${detail}`,
      retryable: false,
      type: "error",
    },
  ];
};

// The room events one SDK message stands for.
const harnessEvents = (msg: SDKMessage, state: StreamState): HarnessEvent[] => {
  switch (msg.type) {
    case "system": {
      return msg.subtype === "init"
        ? [{ sessionId: msg.session_id, type: "session" }]
        : [];
    }
    case "stream_event": {
      return streamEvents(msg, state);
    }
    case "assistant": {
      if (fromSubagent(msg.parent_tool_use_id)) {
        return [];
      }
      return msg.message.content.flatMap((block): HarnessEvent[] =>
        block.type === "tool_use"
          ? [
              {
                id: block.id,
                name: block.name,
                summary: summarize(block.input),
                type: "tool_call",
              },
            ]
          : []
      );
    }
    case "user": {
      const { content } = msg.message;
      if (fromSubagent(msg.parent_tool_use_id) || typeof content === "string") {
        return [];
      }
      return content.flatMap((block): HarnessEvent[] =>
        block.type === "tool_result"
          ? [
              {
                id: block.tool_use_id,
                ok: block.is_error !== true,
                type: "tool_result",
              },
            ]
          : []
      );
    }
    case "result": {
      return resultEvents(msg, state);
    }
    case "auth_status":
    case "conversation_reset":
    case "prompt_suggestion":
    case "rate_limit_event":
    case "tool_progress":
    case "tool_use_summary": {
      return [];
    }
    default: {
      // Messages the SDK doesn't type yet, such as command_lifecycle.
      return [];
    }
  }
};

// A scribe turn starts fresh and is never saved, like a review.
const sessionOptions = (req: TurnRequest): Options => {
  if (req.scribe === true) {
    return { persistSession: false };
  }
  return req.resumeSessionId === undefined || req.resumeSessionId === ""
    ? {}
    : { resume: req.resumeSessionId };
};

const turnOptions = (
  req: TurnRequest,
  executable: string,
  abortController: AbortController,
  canUseTool: CanUseTool
): Options =>
  req.independentReview === true
    ? {
        abortController,
        cwd: req.cwd,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: executable,
        permissionMode: "dontAsk",
        // Every filesystem source, as the CLI does: user, project, local.
        settingSources: ["user", "project", "local"],
        skills: "all",
        ...(req.model === undefined || req.model === ""
          ? {}
          : { model: req.model }),
        canUseTool: async () =>
          await Promise.resolve({
            behavior: "deny" as const,
            message: "Independent reviews cannot execute tools",
          }),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () =>
                  await Promise.resolve({
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason:
                        "Independent reviews cannot execute tools",
                    },
                  }),
              ],
            },
          ],
        },
        mcpServers: {},
        persistSession: false,
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        tools: [],
      }
    : {
        abortController,
        canUseTool,
        cwd: req.cwd,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: executable,
        // Pre-approved tools run; everything else asks canUseTool. Not
        // acceptEdits, which would also approve rm, mv and sed in the folder.
        permissionMode: "default",
        settingSources: ["user", "project", "local"],
        skills: "all",
        ...(req.model === undefined || req.model === ""
          ? {}
          : { model: req.model }),
        // Reviews never get the room tools. Elsewhere they run in-process,
        // so the route and token never reach the CLI's arguments.
        ...(req.roomTools
          ? {
              mcpServers: {
                atelier: claudeRoomToolsServer(
                  loopbackCaller(req.roomTools),
                  req.scribe === true ? scribeTools : claudeTools
                ),
              },
            }
          : {}),
        ...sessionOptions(req),
      };

// Drives the user's own `claude` CLI through the Agent SDK, so their login,
// skills, plugins, MCP servers and CLAUDE.md all load as usual.
export const claudeHarness = (opts: {
  executable: string;
  onRaw: (turnId: string, msg: SDKMessage) => void;
}): Harness => ({
  capabilities: { canRaiseCards: true },
  id: "claude",
  async *runTurn(req, signal, input): AsyncIterable<HarnessEvent> {
    // Installed before the first await, so no steer or switch change is lost.
    let { editsEnabled } = req;
    const prompt = messageStream();
    const steers = new Map<string, (outcome: SteerOutcome) => void>();
    const settle = (uuid: string, outcome: SteerOutcome) => {
      steers.get(uuid)?.(outcome);
      steers.delete(uuid);
    };
    let accepting = req.independentReview !== true;
    if (req.independentReview !== true) {
      // A scribe never edits files, whatever the switch does mid-turn.
      if (req.scribe !== true) {
        input.setEditsEnabled = (on) => {
          editsEnabled = on;
        };
      }
      // Sent as typed, with priority 'next': it joins the running turn at the
      // next tool result. 'now' would end the turn instead.
      input.steer = async (text) => {
        if (!accepting) {
          return "rejected";
        }
        const uuid = randomUUID();
        // oxlint-disable-next-line promise/avoid-new -- the CLI reports a steer's outcome in a later message, which settles this promise from outside
        return await new Promise<SteerOutcome>((resolve) => {
          steers.set(uuid, resolve);
          prompt.push({
            message: { content: text, role: "user" },
            parent_tool_use_id: null,
            priority: "next",
            type: "user",
            uuid,
          });
        });
      };
    }

    const abortController = new AbortController();
    signal.addEventListener(
      "abort",
      () => {
        abortController.abort();
      },
      {
        once: true,
      }
    );

    const hasRoomTools =
      req.independentReview !== true && req.roomTools !== undefined;

    const canUseTool: CanUseTool = async (
      toolName,
      toolInput,
      { toolUseID }
    ) => {
      if (toolName === "AskUserQuestion") {
        // A scribe turn must not sit waiting on a card.
        if (req.scribe === true) {
          return deny(
            "The scribe works without asking questions: decide, and keep open questions in the document."
          );
        }
        return await askRoom(toolInput, toolUseID, input.onQuestion);
      }
      if (hasRoomTools && toolName.startsWith(ROOM_TOOL_PREFIX)) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      if (EDIT_TOOLS.has(toolName)) {
        if (!editsEnabled) {
          return deny(
            'File edits are off in this room. Ask the room owner to turn on "agents may edit files in this folder".'
          );
        }
        const target = toolInput.file_path ?? toolInput.notebook_path;
        if (
          typeof target !== "string" ||
          !(await editableInFolder(req.cwd, target))
        ) {
          return deny(
            "Edits are allowed only inside this room's folder, and never to .claude, .mcp.json, .codex, .pi, .agents or .git."
          );
        }
        return { behavior: "allow", updatedInput: toolInput };
      }
      return deny(
        `${toolName} needs approval, and this room only allows what is already approved.`
      );
    };

    const options = turnOptions(
      req,
      opts.executable,
      abortController,
      canUseTool
    );
    if (req.independentReview !== true) {
      prompt.push({
        message: { content: req.prompt, role: "user" },
        parent_tool_use_id: null,
        type: "user",
      });
    }
    const q = query({
      options,
      prompt: req.independentReview === true ? req.prompt : prompt,
    });
    abortController.signal.addEventListener(
      "abort",
      () => {
        prompt.close();
      },
      {
        once: true,
      }
    );

    const state: StreamState = {
      finals: [],
      messages: [],
      narrations: [],
      sawText: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    let sawResult = false;
    let backgroundWork = 0;
    try {
      for await (const msg of q) {
        opts.onRaw(req.turnId, msg);
        for (const uuid of steeredUuids(msg)) {
          settle(uuid, "steered");
        }
        yield* harnessEvents(msg, state);
        if (msg.type === "result") {
          sawResult = true;
        }
        if (
          msg.type === "system" &&
          msg.subtype === "background_tasks_changed"
        ) {
          backgroundWork = msg.tasks.filter((t) => t.ambient !== true).length;
        }
        if (accepting && sawResult && backgroundWork === 0) {
          // Take no more steers. One that hasn't folded is withdrawn so
          // the room can queue it again. If the CLI already started it
          // as its next turn, it counts as steered once that shows.
          accepting = false;
          await Promise.all(
            [...steers.keys()].map(async (uuid) => {
              if (await withdraw(q, uuid)) {
                settle(uuid, "rejected");
              }
            })
          );
          // The query ends only once its input does.
          prompt.close();
        }
      }
    } finally {
      accepting = false;
      prompt.close();
      for (const uuid of steers.keys()) {
        settle(uuid, "rejected");
      }
    }
  },
  async version() {
    const { stdout } = await execFileAsync(opts.executable, ["--version"], {
      timeout: 10_000,
    });
    return stdout.trim();
  },
});
