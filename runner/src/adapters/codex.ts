import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { Harness } from '@atelier/shared';
import { eventQueue } from './events.ts';

export function codexHarness(opts: { executable: string; onRaw: (id: string, event: unknown) => void }): Harness {
  return {
    id: 'codex',
    async version() { return (await promisify(execFile)(opts.executable, ['--version'])).stdout.trim(); },
    async *runTurn(req, signal) {
      signal.throwIfAborted();
      if (req.mcpServers.length) throw new Error('Per-turn MCP injection is not implemented');
      const child = spawn(opts.executable, ['app-server'], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const events = eventQueue();
      let sequence = 0;
      const privateResponses = new Set<number>();
      const pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
      const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const id = ++sequence;
        if (method === 'config/read') privateResponses.add(id);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
        pending.set(id, { method, resolve, reject, timer }); send({ id, method, params });
      });
      const fail = (error: Error) => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
        pending.clear(); events.push({ type: 'error', message: error.message, retryable: false }); events.end();
      };
      const abort = () => { fail(new Error('Interrupted')); child.kill(); };
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.on('exit', () => fail(new Error('Codex process exited')));
      child.stderr.on('data', (data) => opts.onRaw(req.turnId, { stderr: String(data) }));
      let final = '';
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // config/read can contain secrets; never put that response in a transcript.
          if (!privateResponses.has(msg.id)) opts.onRaw(req.turnId, msg);
          if (msg.id !== undefined && !msg.method) {
            const p = pending.get(msg.id); if (!p) return;
            clearTimeout(p.timer); pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
          } else if (msg.id !== undefined) {
            // No interactive approvals or tool execution through the host yet.
            send({ id: msg.id, error: { code: -32601, message: 'Atelier does not support interactive requests yet' } });
          } else {
            const p = msg.params;
            if (msg.method === 'item/agentMessage/delta') events.push({ type: 'text_delta', text: p.delta });
            if (msg.method === 'item/completed' && p.item.type === 'agentMessage') final += (final ? '\n\n' : '') + p.item.text;
            if (msg.method === 'thread/tokenUsage/updated') events.push({ type: 'usage', inputTokens: p.tokenUsage.last.inputTokens, outputTokens: p.tokenUsage.last.outputTokens });
            if (msg.method === 'turn/completed') {
              if (p.turn.status === 'completed') events.push({ type: 'final', text: final });
              else events.push({ type: 'error', message: p.turn.error?.message ?? p.turn.status, retryable: false });
              events.end();
            }
          }
        } catch (error) { fail(error as Error); }
      });
      try {
        await call('initialize', { clientInfo: { name: 'atelier', version: '0.0.0' } });
        send({ method: 'initialized', params: {} });
        let reviewConfig: Record<string, unknown> | undefined;
        if (req.independentReview) {
          const { config } = await call('config/read', { cwd: req.cwd, includeLayers: false });
          reviewConfig = {
            'features.shell_tool': false, 'features.unified_exec': false,
            'features.apps': false, 'features.plugins': false, 'features.hooks': false,
            'features.multi_agent': false, 'features.multi_agent_v2': false,
            'features.goals': false, 'features.runtime_agent_instances': false,
            'features.js_repl': false,
            'features.code_mode': false, 'features.code_mode_host': false,
            'features.computer_use': false, 'features.browser_use': false,
            'features.image_generation': false, 'features.view_image': false,
            'features.memory_tool': false, 'features.skill_mcp_dependency_install': false,
            web_search: 'disabled',
            'plugins._default.enabled': false,
          };
          for (const section of ['mcp_servers', 'plugins'] as const) {
            for (const name of Object.keys(config[section] ?? {})) {
              // Config override keys use dotted paths. Never accidentally leave
              // an unusual server name enabled by addressing a different key.
              if (!/^[A-Za-z0-9_@-]+$/.test(name)) throw new Error(`Cannot safely disable ${section} entry for review: ${name}`);
              reviewConfig[`${section}.${name}.enabled`] = false;
            }
          }
        }
        const resume = req.independentReview ? undefined : req.resumeSessionId;
        const { thread } = await call(resume ? 'thread/resume' : 'thread/start', {
          ...(resume ? { threadId: resume } : {}),
          ...(req.independentReview ? { config: reviewConfig, ephemeral: true } : {}),
          cwd: req.cwd, model: req.model, approvalPolicy: 'never', sandbox: 'read-only',
        });
        yield { type: 'session', sessionId: thread.id };
        await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: req.prompt }], model: req.model, effort: req.reasoning, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
        yield* events;
      } finally {
        signal.removeEventListener('abort', abort); lines.close();
        for (const p of pending.values()) clearTimeout(p.timer);
        child.kill();
        const kill = setTimeout(() => child.kill('SIGKILL'), 2000); kill.unref();
      }
    },
  };
}
