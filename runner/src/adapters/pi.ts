import { RpcClient } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Harness } from '@atelier/shared';
import { eventQueue } from './events.ts';

// RpcClient launches a Node CLI entry point, not Pi's standalone binary.
export function piHarness(opts: { cliPath?: string; onRaw: (id: string, event: unknown) => void }): Harness {
  const cliPath = opts.cliPath ?? fileURLToPath(new URL('./pi-cli.mjs', import.meta.url));
  return {
    id: 'pi',
    async version() { const result = await promisify(execFile)(process.execPath, [cliPath, '--version'], { timeout: 10_000 }); return (result.stdout || result.stderr).trim(); },
    async *runTurn(req, signal) {
      signal.throwIfAborted();
      if (req.mcpServers.length) throw new Error('Configure Pi MCP through your own extension until per-turn MCP support exists');
      const client = new RpcClient({ cliPath, cwd: req.cwd, model: req.model, args: ['--tools', 'read,grep,find,ls', ...(req.resumeSessionId ? ['--session', req.resumeSessionId] : [])] });
      const events = eventQueue();
      let failed = false;
      const unsubscribe = client.onEvent((ev) => {
        opts.onRaw(req.turnId, ev);
        if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') events.push({ type: 'text_delta', text: ev.assistantMessageEvent.delta });
        if (ev.type === 'message_end' && ev.message.role === 'assistant') {
          const m = ev.message;
          events.push({ type: 'usage', inputTokens: m.usage.input, outputTokens: m.usage.output, costUsd: m.usage.cost.total });
          if (m.stopReason === 'error' || m.stopReason === 'aborted') { failed = true; events.push({ type: 'error', message: m.errorMessage ?? m.stopReason, retryable: false }); }
        }
        if (ev.type === 'agent_settled') events.end();
      });
      const abort = () => { failed = true; events.push({ type: 'error', message: 'Interrupted', retryable: false }); events.end(); void client.stop(); };
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 30 * 60_000);
      try {
        await client.start(); signal.throwIfAborted();
        if (req.reasoning) await client.setThinkingLevel(req.reasoning);
        const disposition = await client.prompt(req.prompt);
        opts.onRaw(req.turnId, { disposition });
        if (disposition === 'handled') events.end();
        yield* events;
        if (!failed) {
          const state = await client.getState();
          if (state.sessionFile) yield { type: 'session', sessionId: state.sessionFile };
          yield { type: 'final', text: await client.getLastAssistantText() ?? '' };
        }
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); unsubscribe(); await client.stop(); }
    },
  };
}
