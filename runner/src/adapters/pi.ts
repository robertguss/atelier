import { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Harness } from "@atelier/shared";
import { RpcClient } from "@earendil-works/pi-coding-agent";

import { execFileAsync } from "../exec.ts";
import { eventQueue } from "./events.ts";
import { TOOL_PREFIX } from "./pi-room-tools-extension.ts";

const READ_TOOLS = "read,grep,find,ls";
const guardExtension = fileURLToPath(
  new URL("pi-guard-extension.ts", import.meta.url)
);
const roomToolsExtension = fileURLToPath(
  new URL("pi-room-tools-extension.ts", import.meta.url)
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// One line naming what a tool call works on, never its content.
const summarize = (args: unknown): string => {
  if (!isRecord(args)) {
    return "";
  }
  const pick = args.path ?? args.pattern ?? args.command ?? args.query;
  if (typeof pick !== "string") {
    return "";
  }
  const [firstLine = ""] = pick.split("\n");
  return firstLine.slice(0, 200);
};

// RpcClient launches a Node CLI entry point, not Pi's standalone binary.
export const piHarness = (opts: {
  cliPath?: string;
  onRaw: (id: string, event: unknown) => void;
}): Harness => {
  const cliPath =
    opts.cliPath ?? fileURLToPath(new URL("pi-cli.mjs", import.meta.url));
  return {
    // Pi has no built-in question prompt, so it asks in plain text.
    capabilities: { canRaiseCards: false },
    id: "pi",
    async *runTurn(req, signal, input) {
      // Pi fixes its tools when a turn starts. Turning edits off interrupts
      // the turn instead, and turning them on applies from the next turn.
      input.setEditsEnabled = () => {
        // Pi cannot change its tools mid-turn.
      };
      signal.throwIfAborted();
      if (req.mcpServers.length) {
        throw new Error(
          "Configure Pi MCP through your own extension until per-turn MCP support exists"
        );
      }
      // Reviews never get the document tools. Elsewhere the extension offers
      // them; naming no mcp__ tool in --tools leaves the user's MCP tools as they were.
      const room = req.independentReview === true ? undefined : req.roomTools;
      let args: string[];
      if (req.independentReview === true) {
        args = ["--no-tools", "--no-extensions", "--no-mcp", "--no-session"];
      } else {
        args = [
          "--tools",
          [
            READ_TOOLS,
            ...(req.editsEnabled ? ["edit,write"] : []),
            ...(room ? [`${TOOL_PREFIX}*`] : []),
          ].join(","),
          ...(req.editsEnabled ? ["--extension", guardExtension] : []),
          ...(room ? ["--extension", roomToolsExtension] : []),
        ];
        // A scribe turn starts fresh and is never saved.
        if (req.scribe === true) {
          args.push("--no-session");
        } else if (
          req.resumeSessionId !== undefined &&
          req.resumeSessionId !== ""
        ) {
          args.push("--session", req.resumeSessionId);
        }
      }
      // The token travels in the environment only, never in argv.
      const client = new RpcClient({
        args,
        cliPath,
        cwd: req.cwd,
        model: req.model,
        ...(room
          ? {
              env: {
                ATELIER_ROOM_TOKEN: room.token,
                ATELIER_ROOM_URL: room.url,
              },
            }
          : {}),
      });
      // Steers go into the run only while it streams. Once Pi has settled it
      // would hold a steer without starting a run to deliver it.
      let running = false;
      // Pi accepted the steer while the run was streaming, so it delivers it
      // before the next model call. The settle event can arrive in the same
      // output chunk as Pi's reply, so it must not turn an accepted steer
      // into a rejection.
      input.steer = async (text) => {
        if (!running) {
          return "rejected";
        }
        await client.steer(text);
        return "steered";
      };
      // RpcClient has no call for answering extension dialogs; write to Pi's stdin directly.
      const answerUi = (id: unknown) => {
        // RpcClient keeps its child process private.
        const child: unknown = Reflect.get(client, "process");
        if (child instanceof ChildProcess) {
          child.stdin?.write(
            `${JSON.stringify({
              cancelled: true,
              id,
              type: "extension_ui_response",
            })}\n`
          );
        }
      };
      const events = eventQueue();
      let failed = false;
      const unsubscribe = client.onEvent((ev) => {
        opts.onRaw(req.turnId, ev);
        // No one can answer an extension's dialog here, so cancel it rather than let the turn hang.
        const raw: unknown = ev;
        if (isRecord(raw) && raw.type === "extension_ui_request") {
          answerUi(raw.id);
        }
        if (
          ev.type === "message_update" &&
          ev.assistantMessageEvent.type === "text_delta"
        ) {
          events.push({
            text: ev.assistantMessageEvent.delta,
            type: "text_delta",
          });
        }
        if (ev.type === "tool_execution_start") {
          events.push({
            id: ev.toolCallId,
            name: ev.toolName,
            summary: summarize(ev.args),
            type: "tool_call",
          });
        }
        if (ev.type === "tool_execution_end") {
          events.push({
            id: ev.toolCallId,
            ok: !ev.isError,
            type: "tool_result",
          });
        }
        if (ev.type === "message_end" && ev.message.role === "assistant") {
          const m = ev.message;
          events.push({
            costUsd: m.usage.cost.total,
            inputTokens: m.usage.input,
            outputTokens: m.usage.output,
            type: "usage",
          });
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            failed = true;
            events.push({
              message: m.errorMessage ?? m.stopReason,
              retryable: false,
              type: "error",
            });
          }
        }
        if (ev.type === "agent_settled") {
          running = false;
          events.end();
        }
      });
      const abort = () => {
        running = false;
        failed = true;
        events.push({
          message: "Interrupted",
          retryable: false,
          type: "error",
        });
        events.end();
        void client.stop();
      };
      // The runner's turn deadline aborts the signal. It pauses while a
      // question card waits, which a timer of Pi's own could not.
      signal.addEventListener("abort", abort, { once: true });
      try {
        await client.start();
        signal.throwIfAborted();
        if (req.reasoning) {
          await client.setThinkingLevel(req.reasoning);
        }
        running = true;
        const disposition = await client.prompt(req.prompt);
        opts.onRaw(req.turnId, { disposition });
        if (disposition === "handled") {
          running = false;
          events.end();
        }
        yield* events;
        if (!failed) {
          const state = await client.getState();
          if (state.sessionFile !== undefined && state.sessionFile !== "") {
            yield { sessionId: state.sessionFile, type: "session" };
          }
          yield {
            text: (await client.getLastAssistantText()) ?? "",
            type: "final",
          };
        }
      } finally {
        running = false;
        signal.removeEventListener("abort", abort);
        unsubscribe();
        await client.stop();
      }
    },
    async version() {
      const result = await execFileAsync(
        process.execPath,
        [cliPath, "--version"],
        { timeout: 10_000 }
      );
      return (result.stdout || result.stderr).trim();
    },
  };
};
