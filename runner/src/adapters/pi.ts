import { execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Harness } from "@atelier/shared";
import { RpcClient } from "@earendil-works/pi-coding-agent";

import { eventQueue } from "./events.ts";

const READ_TOOLS = "read,grep,find,ls";
const guardExtension = fileURLToPath(
  new URL("./pi-guard-extension.ts", import.meta.url)
);

// RpcClient launches a Node CLI entry point, not Pi's standalone binary.
export function piHarness(opts: {
  cliPath?: string;
  onRaw: (id: string, event: unknown) => void;
}): Harness {
  const cliPath =
    opts.cliPath ?? fileURLToPath(new URL("./pi-cli.mjs", import.meta.url));
  return {
    id: "pi",
    // Pi has no built-in question prompt, so it asks in plain text.
    capabilities: { canRaiseCards: false },
    async version() {
      const result = await promisify(execFile)(
        process.execPath,
        [cliPath, "--version"],
        { timeout: 10_000 }
      );
      return (result.stdout || result.stderr).trim();
    },
    async *runTurn(req, signal, input) {
      // Pi fixes its tools when a turn starts. Turning edits off interrupts
      // the turn instead, and turning them on applies from the next turn.
      input.setEditsEnabled = () => {};
      // Steers go into the run only while it streams. Once Pi has settled it
      // would hold a steer without starting a run to deliver it.
      let running = false;
      // Pi accepted the steer while the run was streaming, so it delivers it
      // before the next model call. The settle event can arrive in the same
      // output chunk as Pi's reply, so it must not turn an accepted steer
      // into a rejection.
      input.steer = async (text) => {
        if (!running) return "rejected";
        await client.steer(text);
        return "steered";
      };
      signal.throwIfAborted();
      if (req.mcpServers.length)
        throw new Error(
          "Configure Pi MCP through your own extension until per-turn MCP support exists"
        );
      const args = req.independentReview
        ? ["--no-tools", "--no-extensions", "--no-mcp", "--no-session"]
        : [
            "--tools",
            req.editsEnabled ? `${READ_TOOLS},edit,write` : READ_TOOLS,
            ...(req.editsEnabled ? ["--extension", guardExtension] : []),
            ...(req.resumeSessionId ? ["--session", req.resumeSessionId] : []),
          ];
      const client = new RpcClient({
        cliPath,
        cwd: req.cwd,
        model: req.model,
        args,
      });
      // RpcClient has no call for answering extension dialogs; write to Pi's stdin directly.
      const answerUi = (id: string) => {
        const child = (client as unknown as { process: ChildProcess | null })
          .process;
        child?.stdin?.write(
          JSON.stringify({
            type: "extension_ui_response",
            id,
            cancelled: true,
          }) + "\n"
        );
      };
      const events = eventQueue();
      let failed = false;
      const unsubscribe = client.onEvent((ev) => {
        opts.onRaw(req.turnId, ev);
        // No one can answer an extension's dialog here, so cancel it rather than let the turn hang.
        if ((ev as { type: string }).type === "extension_ui_request")
          answerUi((ev as unknown as { id: string }).id);
        if (
          ev.type === "message_update" &&
          ev.assistantMessageEvent.type === "text_delta"
        )
          events.push({
            type: "text_delta",
            text: ev.assistantMessageEvent.delta,
          });
        if (ev.type === "tool_execution_start")
          events.push({
            type: "tool_call",
            id: ev.toolCallId,
            name: ev.toolName,
            summary: summarize(ev.args),
          });
        if (ev.type === "tool_execution_end")
          events.push({
            type: "tool_result",
            id: ev.toolCallId,
            ok: !ev.isError,
          });
        if (ev.type === "message_end" && ev.message.role === "assistant") {
          const m = ev.message;
          events.push({
            type: "usage",
            inputTokens: m.usage.input,
            outputTokens: m.usage.output,
            costUsd: m.usage.cost.total,
          });
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            failed = true;
            events.push({
              type: "error",
              message: m.errorMessage ?? m.stopReason,
              retryable: false,
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
          type: "error",
          message: "Interrupted",
          retryable: false,
        });
        events.end();
        void client.stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 30 * 60_000);
      try {
        await client.start();
        signal.throwIfAborted();
        if (req.reasoning) await client.setThinkingLevel(req.reasoning);
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
          if (state.sessionFile)
            yield { type: "session", sessionId: state.sessionFile };
          yield {
            type: "final",
            text: (await client.getLastAssistantText()) ?? "",
          };
        }
      } finally {
        running = false;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        unsubscribe();
        await client.stop();
      }
    },
  };
}

// One line naming what a tool call works on, never its content.
function summarize(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  const pick = o.path ?? o.pattern ?? o.command ?? o.query;
  return typeof pick === "string" ? pick.split("\n")[0]!.slice(0, 200) : "";
}
