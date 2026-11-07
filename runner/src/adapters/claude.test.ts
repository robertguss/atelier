import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, QuestionAnswer, QuestionCard, SteerOutcome, TurnInput } from '@atelier/shared';
import { claudeHarness } from './claude.ts';
import { turnInput } from './events.ts';

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

const roomTools = { url: 'http://127.0.0.1:40123/mcp', token: 'ROOM-TOKEN-SECRET' };

const init = { emit: { type: 'system', subtype: 'init', uuid: 'i1' } };
const result = (text: string) => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, uuid: `r-${text}` } });
const toolUse = (id: string, name: string, input: unknown) => ({ emit: { type: 'assistant', parent_tool_use_id: null, uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } });
const permission = (id: string, tool_name: string, input: unknown) => ({ permission: { id, tool_name, input } });

interface Options {
  editsEnabled?: boolean;
  independentReview?: boolean;
  roomTools?: { url: string; token: string };
  cancelled?: boolean;
  onQuestion?: (card: QuestionCard) => Promise<QuestionAnswer>;
  onEvent?: (ev: HarnessEvent, input: TurnInput, cwd: string) => void;
  setup?: (cwd: string) => Promise<void>;
}

async function runFake(steps: unknown[], opts: Options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'atelier-claude-test-')));
  const cwd = join(dir, 'room');
  await mkdir(cwd);
  const executable = join(dir, 'fake-claude.mjs');
  await writeFile(executable, FAKE_CLI, { mode: 0o700 });
  await writeFile(join(cwd, 'script.json'), JSON.stringify({ steps, cancelled: opts.cancelled }));
  await opts.setup?.(cwd);
  const input = turnInput(opts.onQuestion);
  const events: HarnessEvent[] = [];
  try {
    const harness = claudeHarness({ executable, onRaw() {} });
    const turn = harness.runTurn({
      turnId: 'test', cwd, prompt: 'Plan the launch', editsEnabled: opts.editsEnabled ?? false,
      independentReview: opts.independentReview, mcpServers: [],
      ...(opts.roomTools ? { roomTools: opts.roomTools } : {}),
    }, new AbortController().signal, input);
    for await (const ev of turn) { events.push(ev); opts.onEvent?.(ev, input, cwd); }
    const calls = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const decision = (id: string) => calls.find((c) => c.permissionResult === id)?.response;
    return { events, calls, decision, input, cwd };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('AskUserQuestion becomes a card, and the answer maps back by question text', async () => {
  const cards: QuestionCard[] = [];
  const questions = [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Size', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }, { label: 'L', description: '' }], multiSelect: true },
    { question: 'Anything else?', header: 'Notes', options: [{ label: 'No', description: '' }, { label: 'Yes', description: '' }], multiSelect: false },
  ];
  const { decision } = await runFake([init, permission('ask1', 'AskUserQuestion', { questions }), result('ok')], {
    async onQuestion(card) {
      cards.push(card);
      const [color, sizes, notes] = card.questions.map((q) => q.id);
      return {
        handId: 'h1', requestId: card.requestId, answeredBy: 'Robert', via: 'card',
        answers: [
          { questionId: color!, question: 'Which color?', labels: ['Blue'] },
          { questionId: sizes!, question: 'Which sizes?', labels: ['S', 'L'] },
          { questionId: notes!, question: 'Anything else?', labels: [], freeText: 'Ship it Friday' },
        ],
      };
    },
  });
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.equal(card.requestId, 'ask1');
  assert.equal(new Set(card.questions.map((q) => q.id)).size, 3);
  assert.deepEqual(card.questions[0], {
    id: card.questions[0]!.id, header: 'Color', text: 'Which color?',
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiSelect: false, allowFreeText: true,
  });
  assert.equal(card.questions[1]!.multiSelect, true);
  const response = decision('ask1');
  assert.equal(response.behavior, 'allow');
  assert.deepEqual(response.updatedInput.questions, questions);
  assert.deepEqual(response.updatedInput.answers, { 'Which color?': 'Blue', 'Which sizes?': 'S, L', 'Anything else?': 'Ship it Friday' });
  for (const q of questions) assert.match(response.updatedInput.annotations[q.question].notes, /Robert/);
});

test('a card closed without an answer tells Claude no decision was made', async () => {
  const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }];
  const { decision } = await runFake([init, permission('ask1', 'AskUserQuestion', { questions }), result('ok')], {
    onQuestion: async (card) => ({ handId: 'h1', requestId: card.requestId, noDecision: true, message: 'No one answered in time; no decision was made.' }),
  });
  const response = decision('ask1');
  assert.equal(response.behavior, 'allow');
  assert.match(response.updatedInput.answers['Which color?'], /no decision was made/i);
});

test('with the edit switch off, edits and unapproved commands are denied', async () => {
  const { decision, calls } = await runFake([
    init,
    permission('w1', 'Write', { file_path: 'plan.md', content: 'x' }),
    permission('b1', 'Bash', { command: 'rm -rf build' }),
    result('ok'),
  ]);
  assert.ok(calls[0].argv.includes('--permission-mode=default'));
  assert.equal(decision('w1').behavior, 'deny');
  assert.equal(decision('b1').behavior, 'deny');
});

test('with the edit switch on, only edits inside the folder and outside control paths are allowed', async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'atelier-claude-outside-')));
  try {
    const { decision } = await runFake([
      init,
      permission('in', 'Write', { file_path: 'docs/plan.md', content: 'x' }),
      permission('abs', 'Edit', { file_path: '$CWD/notes.md', old_string: 'a', new_string: 'b' }),
      permission('nb', 'NotebookEdit', { notebook_path: 'analysis.ipynb', new_source: 'x' }),
      permission('up', 'Write', { file_path: '../escape.md', content: 'x' }),
      permission('away', 'Write', { file_path: join(outside, 'x.md'), content: 'x' }),
      permission('link', 'Write', { file_path: 'linked/x.md', content: 'x' }),
      permission('dangling', 'Write', { file_path: 'dangling.md', content: 'x' }),
      permission('claude', 'Write', { file_path: '.claude/settings.local.json', content: '{}' }),
      permission('hook', 'Write', { file_path: '.git/hooks/pre-commit', content: 'x' }),
      permission('mcp', 'Write', { file_path: '.mcp.json', content: '{}' }),
      permission('codex', 'Write', { file_path: '.codex/config.toml', content: 'x' }),
      permission('pi', 'Write', { file_path: 'sub/.pi/x.json', content: 'x' }),
      permission('agents', 'Write', { file_path: '.agents/skills/x.md', content: 'x' }),
      permission('bash', 'Bash', { command: 'rm -rf build' }),
      result('ok'),
    ], {
      editsEnabled: true,
      async setup(cwd) {
        await mkdir(join(cwd, '.git', 'hooks'), { recursive: true });
        await symlink(outside, join(cwd, 'linked'));
        await symlink(join(outside, 'gone.md'), join(cwd, 'dangling.md'));
      },
    });
    for (const id of ['in', 'abs', 'nb']) assert.equal(decision(id).behavior, 'allow', id);
    assert.deepEqual(decision('in').updatedInput, { file_path: 'docs/plan.md', content: 'x' });
    for (const id of ['up', 'away', 'link', 'dangling', 'claude', 'hook', 'mcp', 'codex', 'pi', 'agents', 'bash']) {
      assert.equal(decision(id).behavior, 'deny', id);
    }
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test('turning the switch off mid-turn denies the next edit', async () => {
  const { decision } = await runFake([
    init,
    permission('w1', 'Write', { file_path: 'a.md', content: 'x' }),
    toolUse('marker', 'Read', { file_path: 'a.md' }),
    { waitFile: 'go' },
    permission('w2', 'Write', { file_path: 'b.md', content: 'x' }),
    result('ok'),
  ], {
    editsEnabled: true,
    onEvent(ev, input, cwd) {
      if (ev.type === 'tool_call' && ev.id === 'marker') {
        input.setEditsEnabled(false);
        void writeFile(join(cwd, 'go'), '');
      }
    },
  });
  assert.equal(decision('w1').behavior, 'allow');
  assert.equal(decision('w2').behavior, 'deny');
});

test('a steer goes in mid-turn with priority next and resolves steered when folded', async () => {
  let steer: Promise<SteerOutcome> | undefined;
  const { events, calls } = await runFake([
    init,
    toolUse('t1', 'Bash', { command: 'sleep 6' }),
    { waitUser: true },
    { emit: { type: 'command_lifecycle', command_uuid: '$STEER', state: 'queued' } },
    { emit: { type: 'user', parent_tool_use_id: null, uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } } },
    { emit: { type: 'command_lifecycle', command_uuid: '$STEER', state: 'started' } },
    { emit: { type: 'system', subtype: 'status', status: null, uuid: 's1', user_message_uuids: ['first', '$STEER'] } },
    toolUse('t2', 'Bash', { command: 'false' }),
    { emit: { type: 'user', parent_tool_use_id: null, uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'exit 1', is_error: true }] } } },
    result('Done, in blue'),
  ], {
    onEvent(ev, input) { if (ev.type === 'tool_call' && ev.id === 't1') steer = input.steer('Use blue instead'); },
  });
  assert.equal(await steer, 'steered');
  const pushed = calls.filter((c) => c.type === 'user').slice(1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].priority, 'next');
  assert.equal(pushed[0].parent_tool_use_id, null);
  assert.match(pushed[0].uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(pushed[0].message, { role: 'user', content: 'Use blue instead' });
  assert.ok(calls.some((c) => c.eof), 'input closes after the result');
  assert.deepEqual(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result'), [
    { type: 'tool_call', id: 't1', name: 'Bash', summary: 'sleep 6' },
    { type: 'tool_result', id: 't1', ok: true },
    { type: 'tool_call', id: 't2', name: 'Bash', summary: 'false' },
    { type: 'tool_result', id: 't2', ok: false },
  ]);
  assert.deepEqual(events.at(-1), { type: 'final', text: 'Done, in blue' });
});

test('a steer not folded before the result is withdrawn and rejected', async () => {
  let steer: Promise<SteerOutcome> | undefined;
  const { calls, events, input } = await runFake([
    init,
    toolUse('t1', 'Bash', { command: 'sleep 6' }),
    { waitUser: true },
    result('first'),
  ], {
    cancelled: true,
    onEvent(ev, input) { if (ev.type === 'tool_call') steer = input.steer('Too late'); },
  });
  assert.equal(await steer, 'rejected');
  const uuid = calls.filter((c) => c.type === 'user')[1].uuid;
  assert.ok(calls.some((c) => c.type === 'control_request' && c.request.subtype === 'cancel_async_message' && c.request.message_uuid === uuid));
  assert.ok(calls.some((c) => c.eof));
  assert.deepEqual(events.at(-1), { type: 'final', text: 'first' });
  assert.equal(await input.steer('After the turn'), 'rejected');
});

test('a late steer the CLI could not withdraw runs on in the same turn and counts as steered', async () => {
  let steer: Promise<SteerOutcome> | undefined;
  const { events } = await runFake([
    init,
    toolUse('t1', 'Bash', { command: 'sleep 6' }),
    { waitUser: true },
    result('first'),
    { emit: { type: 'command_lifecycle', command_uuid: '$STEER', state: 'started' } },
    result('second'),
  ], {
    cancelled: false,
    onEvent(ev, input) { if (ev.type === 'tool_call') steer = input.steer('One more thing'); },
  });
  assert.equal(await steer, 'steered');
  assert.deepEqual(events.filter((e) => e.type === 'final').at(-1), { type: 'final', text: 'first\n\nsecond' });
});

test('independent review options are unchanged, with no Atelier server even if a route is passed', async () => {
  let steered: SteerOutcome | undefined;
  const { calls } = await runFake([init, result('review')], {
    independentReview: true,
    roomTools,
    onEvent(ev, input) { if (ev.type === 'session') void input.steer('x').then((o) => { steered = o; }); },
  });
  assert.deepEqual(calls[0].argv, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool=stdio', '--allowedTools=Skill', '--tools=',
    '--setting-sources=user,project,local', '--strict-mcp-config', '--permission-mode=dontAsk',
    '--include-partial-messages', '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
  ]);
  const { request_id: _id, ...initialize } = calls[1];
  assert.deepEqual(initialize, { type: 'control_request', request: { subtype: 'initialize', hooks: { PreToolUse: [{ hookCallbackIds: ['hook_0'] }] }, systemPrompt: [''] } });
  assert.deepEqual(calls[2], { type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: 'Plan the launch' }] }, parent_tool_use_id: null });
  assert.equal(steered, 'rejected');
});

test('an ordinary Claude turn gets the in-process Atelier server, with no route or token in its arguments', async () => {
  const { calls } = await runFake([init, result('ok')], { roomTools });
  // In-process servers are declared in initialize, not passed as --mcp-config,
  // and without --strict-mcp-config the user's own MCP servers still load.
  assert.deepEqual(calls[0].argv, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool=stdio', '--allowedTools=Skill',
    '--setting-sources=user,project,local', '--permission-mode=default', '--include-partial-messages',
  ]);
  const initialize = calls.find((c) => c.type === 'control_request' && c.request.subtype === 'initialize');
  assert.deepEqual(initialize.request.sdkMcpServers, ['atelier']);
  assert.deepEqual(initialize.request.sdkMcpServerManifests.atelier.toolsListResult.tools.map((t: { name: string }) => t.name), [
    'read_document', 'read_thread', 'add_block', 'update_block', 'delete_block', 'comment',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /ROOM-TOKEN-SECRET|40123/);
});

test('canUseTool allows the Atelier document tools and still denies other unapproved tools', async () => {
  const { decision } = await runFake([
    init,
    permission('doc', 'mcp__atelier__add_block', { kind: 'paragraph', text: 'We chose blue.' }),
    permission('other', 'mcp__elsewhere__post', { a: 1 }),
    permission('lookalike', 'mcp__atelier_evil__post', { a: 1 }),
    permission('bash', 'Bash', { command: 'rm -rf build' }),
    result('ok'),
  ], { roomTools });
  assert.equal(decision('doc').behavior, 'allow');
  assert.deepEqual(decision('doc').updatedInput, { kind: 'paragraph', text: 'We chose blue.' });
  for (const id of ['other', 'lookalike', 'bash']) assert.equal(decision(id).behavior, 'deny', id);
});

test('a Claude document tool call shows up as a turn item with the tool name and no token', async () => {
  const { events } = await runFake([
    init,
    toolUse('doc-1', 'mcp__atelier__add_block', { kind: 'paragraph', text: 'We chose blue.' }),
    { emit: { type: 'user', parent_tool_use_id: null, uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'doc-1', content: 'Added block b1 at rev 1.' }] } } },
    result('ok'),
  ], { roomTools });
  assert.deepEqual(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result'), [
    { type: 'tool_call', id: 'doc-1', name: 'mcp__atelier__add_block', summary: '' },
    { type: 'tool_result', id: 'doc-1', ok: true },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /ROOM-TOKEN-SECRET/);
});
