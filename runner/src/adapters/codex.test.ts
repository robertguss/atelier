import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHarness } from './codex.ts';

test('Codex review starts fresh with denied tools, disabled MCP, and never logs effective config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-codex-test-'));
  const executable = join(dir, 'fake.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
appendFileSync('calls.jsonl', JSON.stringify({launch:process.argv.slice(2)})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); appendFileSync('calls.jsonl', line+'\\n');
  if(c.id===undefined)return;
  const result=c.method==='config/read'?{config:{mcp_servers:{fixture:{enabled:true,token:'CONFIG_SECRET'}}}}:c.method==='thread/start'?{thread:{id:'fresh'}}:{};
  console.log(JSON.stringify({id:c.id,result}));
  if(c.method==='turn/start') {
    console.log(JSON.stringify({method:'item/completed',params:{item:{type:'agentMessage',text:'Independent answer'}}}));
    console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));
  }
});`, { mode: 0o700 });
  const raw: unknown[] = [];
  try {
    const results = [];
    for await (const event of codexHarness({ executable, onRaw(_id, e) { raw.push(e); } }).runTurn({ turnId: 'test', cwd: dir, prompt: 'review', resumeSessionId: 'ordinary', independentReview: true, readOnly: true, mcpServers: [] }, new AbortController().signal)) results.push(event);
    const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const start = calls.find(c => c.method === 'thread/start');
    assert.equal(start.params.threadId, undefined);
    assert.equal(start.params.ephemeral, true);
    assert.equal(start.params.config['mcp_servers.fixture.enabled'], false);
    assert.equal(start.params.config['features.shell_tool'], false);
    assert.equal(start.params.config['features.goals'], false);
    assert.equal(start.params.config['features.multi_agent'], false);
    assert.equal(start.params.config['features.hooks'], false);
    assert.equal(start.params.sandbox, 'read-only');
    assert.doesNotMatch(JSON.stringify(raw), /CONFIG_SECRET/);
    assert.ok(results.some(e => e.type === 'final' && e.text === 'Independent answer'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
