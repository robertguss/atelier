import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Harness } from '@atelier/shared';
import { eventQueue } from './events.ts';

const ROOM_TOKEN_ENV = 'ATELIER_ROOM_TOKEN';

export function codexHarness(opts: { executable: string; onRaw: (id: string, event: unknown) => void }): Harness {
  return {
    id: 'codex',
    // Codex asks in plain text: its question prompt only reaches a client in Plan mode.
    capabilities: { canRaiseCards: false },
    async version() { return (await promisify(execFile)(opts.executable, ['--version'])).stdout.trim(); },
    async *runTurn(req, signal, input) {
      signal.throwIfAborted();
      // Reviews never get the document tools. Elsewhere Codex reaches them as
      // the `atelier` MCP server, pre-approved so no call waits on an answer.
      // The token goes in the app-server's environment, never in argv.
      const room = req.independentReview ? undefined : req.roomTools;
      const roomConfig = room ? {
        'mcp_servers.atelier.url': room.url,
        'mcp_servers.atelier.bearer_token_env_var': ROOM_TOKEN_ENV,
        'mcp_servers.atelier.default_tools_approval_mode': 'approve',
      } : undefined;

      let threadId: string | undefined;
      let turnId: string | undefined;
      let closed = false;
      let turnStarted!: (id: string | undefined) => void;
      const started = new Promise<string | undefined>((resolve) => { turnStarted = resolve; });
      input.steer = async (text) => {
        const expectedTurnId = turnId ?? await started;
        if (closed || !threadId || !expectedTurnId) return 'rejected';
        try {
          await call('turn/steer', { threadId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId });
          return 'steered';
        } catch {
          // Codex refuses a steer once the turn has ended or another has started.
          return 'rejected';
        }
      };
      // Permissions are fixed when a turn starts. Switching edits off interrupts
      // the turn; switching them on applies from the next turn.
      input.setEditsEnabled = () => {};

      const child = spawn(opts.executable, ['app-server'], {
        cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        ...(room ? { env: { ...process.env, [ROOM_TOKEN_ENV]: room.token } } : {}),
      });
      const events = eventQueue();
      let sequence = 0;
      const privateResponses = new Set<number>();
      const pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
      const call = (method: string, params: unknown, timeoutMs = 30_000): Promise<any> => new Promise((resolve, reject) => {
        const id = ++sequence;
        if (method === 'config/read') privateResponses.add(id);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer }); send({ id, method, params });
      });
      const fail = (error: Error) => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
        pending.clear(); events.push({ type: 'error', message: error.message, retryable: false }); events.end();
      };
      const abort = () => {
        const stop = () => { fail(new Error('Interrupted')); child.kill(); };
        // Stop the turn inside Codex first, so the thread is left resumable.
        if (threadId && turnId) call('turn/interrupt', { threadId, turnId }, 5_000).then(stop, stop);
        else stop();
      };
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.on('exit', () => fail(new Error('Codex process exited')));
      child.stderr.on('data', (data) => opts.onRaw(req.turnId, { stderr: String(data) }));

      // Paths each file change will write, from its `item/started`: Codex's
      // approval request names only the item.
      const changePaths = new Map<string, string[]>();
      const toolsSeen = new Set<string>();
      const answer = async (method: string, params: any) => {
        // Commands stay limited to what Codex runs unprompted.
        if (method === 'item/commandExecution/requestApproval') return { result: { decision: 'decline' } };
        if (method === 'item/fileChange/requestApproval') {
          const allowed = req.editsEnabled && await editAllowed(req.cwd, changePaths.get(params.itemId) ?? []).catch(() => false);
          return { result: { decision: allowed ? 'accept' : 'decline' } };
        }
        return { error: { code: -32601, message: 'Atelier does not support this request' } };
      };

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
            void answer(msg.method, msg.params).then(
              (reply) => send({ id: msg.id, ...reply }),
              () => send({ id: msg.id, error: { code: -32603, message: 'Atelier could not answer this request' } }),
            );
          } else {
            const p = msg.params;
            if (msg.method === 'item/agentMessage/delta') events.push({ type: 'text_delta', text: p.delta });
            if (msg.method === 'item/started' || msg.method === 'item/completed') {
              const item = p.item;
              if (item.type === 'fileChange' && msg.method === 'item/started') {
                changePaths.set(item.id, (item.changes ?? []).flatMap((c: any) => [c.path, c.kind?.move_path].filter(Boolean)));
              }
              const tool = toolCall(req.cwd, item);
              if (tool && !toolsSeen.has(item.id)) { toolsSeen.add(item.id); events.push({ type: 'tool_call', id: item.id, ...tool }); }
              if (tool && msg.method === 'item/completed') events.push({ type: 'tool_result', id: item.id, ok: item.status === 'completed' });
            }
            if (msg.method === 'item/completed' && p.item.type === 'agentMessage') final += (final ? '\n\n' : '') + p.item.text;
            if (msg.method === 'thread/tokenUsage/updated') events.push({ type: 'usage', inputTokens: p.tokenUsage.last.inputTokens, outputTokens: p.tokenUsage.last.outputTokens });
            if (msg.method === 'turn/completed') {
              if (p.turn.status === 'completed') events.push({ type: 'final', text: final });
              else events.push({ type: 'error', message: signal.aborted ? 'Interrupted' : p.turn.error?.message ?? p.turn.status, retryable: false });
              events.end();
            }
          }
        } catch (error) { fail(error as Error); }
      });
      try {
        await call('initialize', { clientInfo: { name: 'atelier', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
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
        // Edits on: Codex may write only inside the folder, and asks before
        // every file change and every command outside its own safe set. The
        // runner answers those requests. Edits off: read-only, never asks.
        const approvalPolicy = req.editsEnabled ? 'untrusted' : 'never';
        const sandboxPolicy = req.editsEnabled
          ? { type: 'workspaceWrite', writableRoots: [req.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly' };
        // Reviews and scribe turns start fresh and are never saved.
        const resume = req.independentReview || req.scribe ? undefined : req.resumeSessionId;
        const { thread } = await call(resume ? 'thread/resume' : 'thread/start', {
          ...(resume ? { threadId: resume } : {}),
          ...(req.independentReview ? { config: reviewConfig, ephemeral: true } : roomConfig ? { config: roomConfig } : {}),
          ...(req.scribe ? { ephemeral: true } : {}),
          cwd: req.cwd, model: req.model, approvalPolicy, sandbox: req.editsEnabled ? 'workspace-write' : 'read-only',
        });
        threadId = thread.id;
        yield { type: 'session', sessionId: thread.id };
        const { turn } = await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: req.prompt }], model: req.model, effort: req.reasoning, approvalPolicy, sandboxPolicy });
        turnId = turn.id;
        turnStarted(turnId);
        yield* events;
      } finally {
        closed = true;
        turnStarted(undefined);
        signal.removeEventListener('abort', abort); lines.close();
        for (const p of pending.values()) clearTimeout(p.timer);
        child.kill();
        const kill = setTimeout(() => child.kill('SIGKILL'), 2000); kill.unref();
      }
    },
  };
}

// Harness and repository control files. Writing one could grant the agent
// commands, hooks or extensions on its next turn.
const PROTECTED = new Set(['.git', '.codex', '.agents', '.claude', '.pi', '.mcp.json']);

/** Whether every path lands inside `cwd`, once symlinks resolve, and outside control files. */
async function editAllowed(cwd: string, paths: string[]) {
  if (!paths.length) return false;
  const root = await realpath(cwd);
  for (const path of paths) {
    const target = await realTarget(resolve(cwd, path));
    if (!target) return false;
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.some((part) => PROTECTED.has(part))) return false;
  }
  return true;
}

// Where a write to `path` lands: symlinks resolved through its deepest existing
// part. Null for a dangling symlink or an unreadable path, which can't be checked.
async function realTarget(path: string): Promise<string | null> {
  const rest: string[] = [];
  for (let p = path; ; p = dirname(p)) {
    try {
      return join(await realpath(p), ...rest);
    } catch {
      if (dirname(p) === p || await lstat(p).then(() => true, () => false)) return null;
      rest.unshift(basename(p));
    }
  }
}

function toolCall(cwd: string, item: any): { name: string; summary: string } | undefined {
  const line = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (item.type === 'commandExecution') return { name: 'Shell', summary: line(String(item.command ?? '')) };
  if (item.type === 'fileChange') return { name: 'Edit', summary: line((item.changes ?? []).map((c: any) => relative(cwd, resolve(cwd, c.path))).join(', ')) };
  if (item.type === 'mcpToolCall') return { name: `${item.server}.${item.tool}`, summary: line(JSON.stringify(item.arguments ?? {})) };
  return undefined;
}
