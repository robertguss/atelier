import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piHarness } from './pi.ts';
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
