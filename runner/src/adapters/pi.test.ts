import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, TurnInput, TurnRequest } from '@atelier/shared';
import { piHarness } from './pi.ts';
import { blockedEditReason } from './pi-guard-extension.ts';
import { turnInput } from './events.ts';

test('Pi prompt rejection terminates instead of waiting for agent_end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-pi-'));
  const cliPath = join(dir, 'fake.mjs');
  await writeFile(cliPath, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
const command=JSON.parse(line);
console.log(JSON.stringify({type:'response',id:command.id,command:command.type,success:false,error:'No API key. Please log in.'}));
});`);
  try {
    await assert.rejects(async () => {
      for await (const event of piHarness({ cliPath, onRaw() {} }).runTurn({ turnId: 'test', cwd: dir, prompt: 'hello', editsEnabled: false, mcpServers: [] }, new AbortController().signal, turnInput())) void event;
    }, /Please log in/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A fake Pi RPC process. It records its arguments and every line it reads,
// and acts out a scenario chosen by the prompt text.
const FAKE_PI = `import {createInterface} from 'node:readline';
import {appendFileSync, writeFileSync} from 'node:fs';
writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let last = '';
const finish = (text) => {
  last = text;
  out({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text', text}], usage:{input:3, output:2, cost:{total:0}}}});
  out({type:'agent_settled', aborted:false});
};
createInterface({input:process.stdin}).on('line', (line) => {
  const command = JSON.parse(line);
  appendFileSync(new URL('./stdin.jsonl', import.meta.url), line + '\\n');
  const ok = (data) => out({type:'response', id:command.id, command:command.type, success:true, data});
  if (command.type === 'prompt') {
    ok({disposition:'started'});
    if (command.message === 'steer') out({type:'tool_execution_start', toolCallId:'call-1', toolName:'bash', args:{command:'sleep 5 && echo one'}});
    else if (command.message === 'ui') out({type:'extension_ui_request', id:'ui-1', method:'confirm', title:'Allow?', message:'Run it?'});
    else finish('done');
  } else if (command.type === 'steer') {
    ok({disposition:'queued'});
    out({type:'tool_execution_end', toolCallId:'call-1', toolName:'bash', result:{content:[]}, isError:false});
    finish('steered by ' + command.message);
  } else if (command.type === 'extension_ui_response') {
    finish('ui answered');
  } else if (command.type === 'get_state') ok({sessionFile:'/tmp/fake-session.jsonl'});
  else if (command.type === 'get_last_assistant_text') ok({text:last});
  else ok(undefined);
});`;

async function withFakePi(fn: (fake: { dir: string; run(req: Partial<TurnRequest>, input?: TurnInput, onEvent?: (ev: HarnessEvent, input: TurnInput) => Promise<void>): Promise<HarnessEvent[]>; argv(): Promise<string[]>; stdin(): Promise<any[]> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-pi-'));
  const cliPath = join(dir, 'fake.mjs');
  await writeFile(cliPath, FAKE_PI);
  const harness = piHarness({ cliPath, onRaw() {} });
  try {
    await fn({
      dir,
      async run(req, input = turnInput(), onEvent) {
        const events: HarnessEvent[] = [];
        for await (const ev of harness.runTurn({ turnId: 'test', cwd: dir, prompt: 'plain', editsEnabled: false, mcpServers: [], ...req }, new AbortController().signal, input)) {
          events.push(ev);
          await onEvent?.(ev, input);
        }
        return events;
      },
      async argv() { return JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')); },
      async stdin() { return (await readFile(join(dir, 'stdin.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); },
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Pi steers a running turn, reports its tools, and rejects a steer once the run has settled', async () => {
  await withFakePi(async (fake) => {
    const outcomes: string[] = [];
    const events = await fake.run({ prompt: 'steer' }, turnInput(), async (ev, input) => {
      if (ev.type === 'tool_call') outcomes.push(await input.steer('Use the other file'));
    });
    const input = turnInput();
    await fake.run({ prompt: 'plain' }, input);
    outcomes.push(await input.steer('Too late'));

    assert.deepEqual(outcomes, ['steered', 'rejected']);
    assert.ok((await fake.stdin()).some((c) => c.type === 'steer' && c.message === 'Use the other file'));
    assert.ok(!(await fake.stdin()).some((c) => c.type === 'steer' && c.message === 'Too late'));
    assert.deepEqual(events.filter((ev) => ev.type === 'tool_call' || ev.type === 'tool_result'), [
      { type: 'tool_call', id: 'call-1', name: 'bash', summary: 'sleep 5 && echo one' },
      { type: 'tool_result', id: 'call-1', ok: true },
    ]);
    assert.deepEqual(events.at(-1), { type: 'final', text: 'steered by Use the other file' });
  });
});

test('Pi with edits on adds edit and write plus the guard extension; with edits off its arguments are unchanged', async () => {
  await withFakePi(async (fake) => {
    await fake.run({ editsEnabled: false, resumeSessionId: '/tmp/s.jsonl', model: 'openai/gpt-6-astra' });
    assert.deepEqual(await fake.argv(), ['--mode', 'rpc', '--model', 'openai/gpt-6-astra', '--tools', 'read,grep,find,ls', '--session', '/tmp/s.jsonl']);

    await fake.run({ editsEnabled: true, resumeSessionId: '/tmp/s.jsonl', model: 'openai/gpt-6-astra' });
    const argv = await fake.argv();
    assert.deepEqual(argv.slice(0, 6), ['--mode', 'rpc', '--model', 'openai/gpt-6-astra', '--tools', 'read,grep,find,ls,edit,write']);
    const extension = argv[argv.indexOf('--extension') + 1];
    assert.match(extension ?? '', /\/pi-guard-extension\.ts$/);
    assert.deepEqual(argv.slice(-2), ['--session', '/tmp/s.jsonl']);
  });
});

test('Pi cancels an extension UI request so the turn completes', async () => {
  await withFakePi(async (fake) => {
    const events = await fake.run({ prompt: 'ui' });
    assert.deepEqual(events.at(-1), { type: 'final', text: 'ui answered' });
    assert.deepEqual((await fake.stdin()).find((c) => c.type === 'extension_ui_response'), { type: 'extension_ui_response', id: 'ui-1', cancelled: true });
  });
});

test('Pi edit guard allows in-folder files and blocks outside, control folders and symlinks out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-pi-guard-'));
  const outside = await mkdtemp(join(tmpdir(), 'atelier-pi-outside-'));
  try {
    const cwd = join(dir, 'room');
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await mkdir(join(cwd, '.git'));
    await symlink(outside, join(cwd, 'escape'));
    await symlink(join(cwd, '.git'), join(cwd, 'gitlink'));
    await symlink(join(outside, 'not-yet.txt'), join(cwd, 'dangling.txt'));

    for (const path of ['notes.md', 'docs/plan.md', join(cwd, 'docs/new.md'), '@docs/at.md']) {
      assert.equal(blockedEditReason(cwd, path), undefined, path);
    }
    for (const path of ['/tmp/outside', '../outside.txt', 'escape/x.txt', 'dangling.txt', '~/x.txt', '.pi/settings.json', '.git/HEAD', '.git/hooks/pre-commit', 'gitlink/config', '.claude/settings.json', '.mcp.json', '.codex/config.toml', '.agents/skills/x.md', 'docs/../.git/config', 'sub/.git/x', 'docs/.claude/settings.json', 'packages/app/.mcp.json']) {
      assert.ok(blockedEditReason(cwd, path), path);
    }
    assert.ok(blockedEditReason(cwd, undefined));
    // The room folder itself may be reached through a symlink.
    await symlink(cwd, join(dir, 'roomlink'));
    assert.equal(blockedEditReason(join(dir, 'roomlink'), 'notes.md'), undefined);
    assert.ok(blockedEditReason(join(dir, 'roomlink'), '.git/HEAD'));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
