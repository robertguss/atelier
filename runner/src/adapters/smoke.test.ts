import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piHarness } from './pi.ts';
import { codexHarness } from './codex.ts';
import { eventQueue, turnInput } from './events.ts';

test('event queue drains events before completion', async () => {
  const q = eventQueue(); q.push({ type: 'final', text: 'ok' }); q.end();
  const results = []; for await (const event of q) results.push(event);
  assert.deepEqual(results, [{ type: 'final', text: 'ok' }]);
});
test('installed harness versions and pre-aborted turns', async () => {
  for (const h of [piHarness({ onRaw() {} }), codexHarness({ executable: 'codex', onRaw() {} })]) {
    assert.ok((await h.version()).length > 0, `${h.id} version`);
    await assert.rejects(async () => {
      for await (const ev of h.runTurn({ turnId: 'test', cwd: process.cwd(), prompt: 'unused', editsEnabled: false, mcpServers: [] }, AbortSignal.abort(), turnInput())) void ev;
    });
  }
});
