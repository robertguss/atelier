// Probe, not product code. Checks whether each harness can call a per-turn
// tool that the runner supplies, with the user's own configuration loaded,
// on a fresh session and on a resumed one. Findings go in LEARNINGS.md.
//
//   node runner/scripts/probe-room-tools.ts claude|codex|pi
//
// Runs in a throwaway git repo under /tmp. The loopback server binds
// 127.0.0.1 on an OS-assigned port and requires a bearer token.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const which = process.argv[2];
const WORD = `violet-${randomBytes(3).toString('hex')}`;
const PROMPT = `Use the atelier echo tool with the message "${WORD}". Then reply with exactly what the tool returned and nothing else.`;
const PROMPT2 = `Use the atelier echo tool again, this time with the message "second". Then reply with exactly what the tool returned and nothing else.`;
const log = (...a: unknown[]) => console.log(`[probe:${which}]`, ...a);
const calls: string[] = [];

const cwd = mkdtempSync(join(tmpdir(), 'atelier-probe-'));
execFileSync('git', ['init', '-q'], { cwd });
writeFileSync(join(cwd, 'README.md'), 'probe\n');

// Minimal streamable-HTTP MCP server with JSON responses and one tool.
const token = randomBytes(24).toString('hex');
async function body(req: IncomingMessage) { let s = ''; for await (const c of req) s += c; return s; }
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { log('rejected request without token', req.method, req.url); res.writeHead(401).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  const msg = JSON.parse(await body(req));
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  let result: unknown;
  if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'atelier', version: '0.0.0' } };
  else if (msg.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a message back.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] };
  else if (msg.method === 'tools/call') { calls.push(msg.params.arguments.message); log('tools/call', JSON.stringify(msg.params)); result = { content: [{ type: 'text', text: `atelier-echo:${msg.params.arguments.message}` }] }; }
  else if (msg.method === 'ping') result = {};
  else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } })); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
if (port >= 3000 && port <= 9999) throw new Error(`port ${port} is in the forwarded range`);
const url = `http://127.0.0.1:${port}/mcp`;
log('server', url, 'cwd', cwd);

async function claude() {
  const atelier = createSdkMcpServer({
    name: 'atelier', alwaysLoad: true,
    tools: [tool('echo', 'Echo a message back.', { message: z.string() }, async ({ message }) => {
      calls.push(message); log('in-process tools/call', message);
      return { content: [{ type: 'text', text: `atelier-echo:${message}` }] };
    })],
  });
  const seen: string[] = [];
  const canUseTool: CanUseTool = async (name, input) => {
    seen.push(name);
    if (name.startsWith('mcp__atelier__')) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: 'denied by probe' };
  };
  let sessionId = '';
  for (const [i, prompt] of [PROMPT, PROMPT2].entries()) {
    const q = query({ prompt, options: {
      cwd, model: 'haiku', settingSources: ['user', 'project', 'local'], skills: 'all', permissionMode: 'default', canUseTool,
      mcpServers: { atelier }, ...(i ? { resume: sessionId } : {}),
    } });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        log(`turn ${i} init servers`, JSON.stringify(m.mcp_servers), 'atelier tools', m.tools.filter((t) => t.includes('atelier')));
      }
      if (m.type === 'result') log(`turn ${i} result`, m.subtype, JSON.stringify((m as { result?: string }).result ?? ''), 'denials', JSON.stringify(m.permission_denials));
    }
  }
  log('canUseTool saw', seen);
}

async function codex(variant: 'never-approve' | 'untrusted-accept' | 'granular-accept') {
  const policy: any = variant === 'never-approve' ? 'never' : variant === 'untrusted-accept' ? 'untrusted' : { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false } };
  const env = { ...process.env, ATELIER_ROOM_TOKEN: token };
  const config: Record<string, unknown> = { 'mcp_servers.atelier.url': url, 'mcp_servers.atelier.bearer_token_env_var': 'ATELIER_ROOM_TOKEN' };
  if (variant === 'never-approve') config['mcp_servers.atelier.default_tools_approval_mode'] = 'approve';
  let threadId = '';
  for (const [i, prompt] of [PROMPT, PROMPT2].entries()) {
    const child = spawn('codex', ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const send = (v: unknown) => child.stdin.write(JSON.stringify(v) + '\n');
    const call = (method: string, params: unknown) => new Promise<any>((resolve) => { const id = ++seq; pending.set(id, resolve); send({ id, method, params }); });
    let done!: () => void; const finished = new Promise<void>((r) => { done = r; });
    let final = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && !msg.method) { pending.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result); return; }
      if (msg.id !== undefined) {
        log(`turn ${i} SERVER REQUEST`, msg.method, JSON.stringify(msg.params).slice(0, 200));
        if (msg.method === 'mcpServer/elicitation/request' && msg.params.serverName === 'atelier' && variant !== 'never-approve') send({ id: msg.id, result: { action: 'accept', content: null } });
        else send({ id: msg.id, error: { code: -32601, message: 'probe does not answer' } });
        return;
      }
      if (msg.method === 'item/completed' && msg.params.item.type === 'mcpToolCall') log(`turn ${i} mcpToolCall`, JSON.stringify(msg.params.item).slice(0, 400));
      if (msg.method === 'item/completed' && msg.params.item.type === 'agentMessage') final = msg.params.item.text;
      if (msg.method === 'turn/completed') { log(`turn ${i} completed`, msg.params.turn.status, JSON.stringify(final)); done(); }
    });
    await call('initialize', { clientInfo: { name: 'atelier-probe', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    send({ method: 'initialized', params: {} });
    const sandbox = variant === 'untrusted-accept' ? 'workspace-write' : 'read-only';
    const sandboxPolicy = variant === 'untrusted-accept' ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly' };
    const started = await call(i ? 'thread/resume' : 'thread/start', { ...(i ? { threadId } : {}), cwd, model: 'gpt-6.1-sol', approvalPolicy: policy, sandbox, config });
    if (started.error) { log(`turn ${i} thread error`, JSON.stringify(started.error)); child.kill(); return; }
    threadId = started.thread.id;
    await call('turn/start', { threadId, input: [{ type: 'text', text: prompt }], effort: 'low', approvalPolicy: policy, sandboxPolicy });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))]);
    child.kill();
  }
}

async function pi() {
  const ext = fileURLToPath(new URL('./probe-pi-extension.ts', import.meta.url));
  const cli = fileURLToPath(new URL('../src/adapters/pi-cli.mjs', import.meta.url));
  let sessionFile = '';
  for (const [i, prompt] of [PROMPT, PROMPT2].entries()) {
    const args = ['--tools', 'read,grep,find,ls,atelier_echo', '--extension', ext, ...(i ? ['--session', sessionFile] : [])];
    const client = new RpcClient({ cliPath: cli, cwd, model: 'openai/gpt-6-astra', args, env: { ...process.env, ATELIER_ROOM_URL: url, ATELIER_ROOM_TOKEN: token } as Record<string, string> });
    let done!: () => void; const settled = new Promise<void>((r) => { done = r; });
    client.onEvent((ev) => {
      if (ev.type === 'tool_execution_start') log(`turn ${i} tool start`, ev.toolName, JSON.stringify(ev.args));
      if (ev.type === 'tool_execution_end') log(`turn ${i} tool end`, ev.toolName, 'error', ev.isError);
      if ((ev as { type: string }).type === 'extension_error') log(`turn ${i} extension error`, JSON.stringify(ev));
      if (ev.type === 'agent_settled') done();
    });
    await client.start();
    await client.setThinkingLevel('low');
    const tools = await (client as unknown as { getTools?: () => Promise<unknown> }).getTools?.().catch(() => undefined);
    if (tools) log(`turn ${i} tools`, JSON.stringify(tools).slice(0, 400));
    await client.prompt(prompt);
    await Promise.race([settled, new Promise((r) => setTimeout(r, 180_000))]);
    log(`turn ${i} final`, JSON.stringify(await client.getLastAssistantText()));
    sessionFile = (await client.getState()).sessionFile ?? '';
    await client.stop();
  }
}

try {
  if (which === 'claude') await claude();
  else if (which === 'codex') { for (const v of ['never-approve', 'untrusted-accept', 'granular-accept'] as const) { log(`--- ${v} ---`); await codex(v); } }
  else if (which === 'pi') await pi();
  else throw new Error('usage: probe-room-tools.ts claude|codex|pi');
} finally {
  log('tool calls received', JSON.stringify(calls), 'expected first word', WORD);
  server.close();
}
