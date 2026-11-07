import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, TurnInput, TurnRequest } from '@atelier/shared';
import { piHarness } from './pi.ts';
import { blockedEditReason } from './pi-guard-extension.ts';
import atelierRoomTools from './pi-room-tools-extension.ts';
import { turnInput } from './events.ts';
import { getFunctionName } from 'convex/server';
import type { RoomToolsClient } from '../roomTools.ts';
import { createRoomToolsServer } from '../roomToolsServer.ts';

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
writeFileSync(new URL('./env.json', import.meta.url), JSON.stringify({url: process.env.ATELIER_ROOM_URL ?? null, token: process.env.ATELIER_ROOM_TOKEN ?? null}));
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
    else if (command.message === 'doc') {
      out({type:'tool_execution_start', toolCallId:'doc-1', toolName:'atelier_add_block', args:{kind:'paragraph', text:'We chose blue.'}});
      out({type:'tool_execution_end', toolCallId:'doc-1', toolName:'atelier_add_block', result:{content:[]}, isError:false});
      finish('noted');
    }
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

async function withFakePi(fn: (fake: { dir: string; run(req: Partial<TurnRequest>, input?: TurnInput, onEvent?: (ev: HarnessEvent, input: TurnInput) => Promise<void>): Promise<HarnessEvent[]>; argv(): Promise<string[]>; env(): Promise<{ url: string | null; token: string | null }>; stdin(): Promise<any[]> }) => Promise<void>) {
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
      async env() { return JSON.parse(await readFile(join(dir, 'env.json'), 'utf8')); },
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

const roomTools = { url: 'http://127.0.0.1:40123/mcp', token: 'ROOM-TOKEN-SECRET' };

test('Pi loads the room document extension and allows its tools with edits off and on, with the token only in its environment', async () => {
  await withFakePi(async (fake) => {
    await fake.run({ editsEnabled: false, roomTools, resumeSessionId: '/tmp/s.jsonl' });
    let argv = await fake.argv();
    const extension = argv[argv.indexOf('--extension') + 1]!;
    assert.match(extension, /\/pi-room-tools-extension\.ts$/);
    assert.deepEqual(argv, ['--mode', 'rpc', '--tools', 'read,grep,find,ls,atelier_*', '--extension', extension, '--session', '/tmp/s.jsonl']);
    assert.deepEqual(await fake.env(), roomTools);
    assert.doesNotMatch(JSON.stringify(argv), /ROOM-TOKEN-SECRET/);

    await fake.run({ editsEnabled: true, roomTools });
    argv = await fake.argv();
    assert.deepEqual(argv.slice(0, 4), ['--mode', 'rpc', '--tools', 'read,grep,find,ls,edit,write,atelier_*']);
    const extensions = argv.flatMap((arg, i) => (argv[i - 1] === '--extension' ? [arg] : []));
    assert.equal(extensions.length, 2);
    assert.ok(extensions.some((e) => /\/pi-guard-extension\.ts$/.test(e)));
    assert.ok(extensions.includes(extension));
    assert.deepEqual(await fake.env(), roomTools);
    assert.doesNotMatch(JSON.stringify(argv), /ROOM-TOKEN-SECRET/);
  });
});

test('a Pi review runs with no tools, extensions or MCP and gets no document route, even if one is passed', async () => {
  await withFakePi(async (fake) => {
    await fake.run({ independentReview: true, roomTools, resumeSessionId: '/tmp/s.jsonl' });
    assert.deepEqual(await fake.argv(), ['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-mcp', '--no-session']);
    assert.deepEqual(await fake.env(), { url: null, token: null });
  });
});

test('a Pi document tool call shows up as a turn item with the tool name and no token', async () => {
  await withFakePi(async (fake) => {
    const events = await fake.run({ prompt: 'doc', roomTools });
    assert.deepEqual(events.filter((ev) => ev.type === 'tool_call' || ev.type === 'tool_result'), [
      { type: 'tool_call', id: 'doc-1', name: 'atelier_add_block', summary: '' },
      { type: 'tool_result', id: 'doc-1', ok: true },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /ROOM-TOKEN-SECRET/);
  });
});

test('the Pi room tools extension registers the endpoint\'s tools and forwards calls as this turn', async () => {
  const calls: { name: string; args: any }[] = [];
  const answer = async (ref: any, args: any) => {
    calls.push({ name: getFunctionName(ref), args });
    return { ok: true, blockId: 'b9', rev: 1 };
  };
  const server = createRoomToolsServer({ client: { query: answer, mutation: answer } as unknown as RoomToolsClient, secret: 's3cret' });
  const saved = { url: process.env.ATELIER_ROOM_URL, token: process.env.ATELIER_ROOM_TOKEN };
  try {
    const route = await server.issue('turn-7');
    process.env.ATELIER_ROOM_URL = route.url;
    process.env.ATELIER_ROOM_TOKEN = route.token;
    const registered: any[] = [];
    await atelierRoomTools({ registerTool: (tool) => registered.push(tool) });
    assert.deepEqual(registered.map((t) => t.name), [
      'atelier_read_document', 'atelier_read_thread', 'atelier_add_block', 'atelier_update_block', 'atelier_delete_block', 'atelier_comment',
    ]);
    const add = registered.find((t) => t.name === 'atelier_add_block');
    assert.equal(add.parameters.type, 'object');
    assert.deepEqual(add.parameters.required, ['kind', 'text']);

    const result = await add.execute('call-1', { kind: 'paragraph', text: 'We chose blue.' });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Added block b9 at rev 1. Pass that rev as baseRev to change it later.' }], isError: false, details: undefined });
    assert.deepEqual(calls, [{ name: 'documentTools:addBlockForTurn', args: { kind: 'paragraph', text: 'We chose blue.', secret: 's3cret', turnId: 'turn-7' } }]);

    const refused = await add.execute('call-2', { kind: 'paragraph' });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, 1, 'bad arguments never reach Convex');

    server.revoke(route.token);
    await assert.rejects(add.execute('call-3', { kind: 'paragraph', text: 'Late' }), /no longer work/);
  } finally {
    for (const [key, value] of [['ATELIER_ROOM_URL', saved.url], ['ATELIER_ROOM_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await server.close();
  }
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
