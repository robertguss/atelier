import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Harness, HarnessEvent, TurnRequest } from '@atelier/shared';

const run = promisify(execFile);

// Drives the user's own `claude` CLI through the Agent SDK, so their login,
// skills, plugins, MCP servers and CLAUDE.md all load as usual.
export function claudeHarness(opts: { executable: string; onRaw: (turnId: string, msg: SDKMessage) => void }): Harness {
  return {
    id: 'claude',

    async version() {
      const { stdout } = await run(opts.executable, ['--version'], { timeout: 10_000 });
      return stdout.trim();
    },

    async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<HarnessEvent> {
      const abortController = new AbortController();
      signal.addEventListener('abort', () => abortController.abort(), { once: true });

      const options: Options = {
        cwd: req.cwd,
        pathToClaudeCodeExecutable: opts.executable,
        abortController,
        includePartialMessages: true,
        // Every filesystem source, as the CLI does: user, project, local.
        settingSources: ['user', 'project', 'local'],
        skills: 'all',
        // No approval UI yet: deny any tool that isn't pre-approved, so a
        // phone message can read and search but can't edit or run commands.
        permissionMode: 'dontAsk',
        ...(req.model ? { model: req.model } : {}),
        ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
      };

      let sawText = false;
      for await (const msg of query({ prompt: req.prompt, options })) {
        opts.onRaw(req.turnId, msg);

        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') yield { type: 'session', sessionId: msg.session_id };
            break;

          case 'stream_event': {
            if (msg.parent_tool_use_id) break; // subagent output stays in the transcript
            const ev = msg.event;
            if (ev.type === 'message_start' && sawText) yield { type: 'text_delta', text: '\n\n' };
            if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              sawText = true;
              yield { type: 'text_delta', text: ev.delta.text };
            }
            break;
          }

          case 'assistant':
            if (msg.parent_tool_use_id) break;
            for (const block of msg.message.content) {
              if (block.type === 'tool_use') {
                yield { type: 'tool_call', name: block.name, summary: summarize(block.input) };
              }
            }
            break;

          case 'result':
            yield {
              type: 'usage',
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              costUsd: msg.total_cost_usd,
            };
            if (msg.subtype === 'success' && !msg.is_error) {
              yield { type: 'final', text: msg.result };
            } else {
              const detail = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : msg.subtype;
              yield { type: 'error', message: `Claude turn ended with ${detail}`, retryable: false };
            }
            break;
        }
      }
    },
  };
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.url ?? o.query;
  return typeof pick === 'string' ? pick.slice(0, 200) : '';
}
