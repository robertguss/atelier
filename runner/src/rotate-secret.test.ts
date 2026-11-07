import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnvValue } from './rotate-secret.ts';

test('replaces the key in place and keeps every other line', () => {
  const text = 'CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=old\nATELIER_RUNNER_NAME=box\n';
  assert.equal(withEnvValue(text, 'ATELIER_RUNNER_SECRET', 'new'), 'CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\nATELIER_RUNNER_NAME=box\n');
});

test('replaces an exported key and leaves keys that only share a prefix', () => {
  const text = 'ATELIER_RUNNER_SECRET_OLD=keep\nexport ATELIER_RUNNER_SECRET=old\n';
  assert.equal(withEnvValue(text, 'ATELIER_RUNNER_SECRET', 'new'), 'ATELIER_RUNNER_SECRET_OLD=keep\nATELIER_RUNNER_SECRET=new\n');
});

test('adds the key when the file lacks it or is empty', () => {
  assert.equal(withEnvValue('CONVEX_URL=https://x\n', 'ATELIER_RUNNER_SECRET', 'new'), 'CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\n');
  assert.equal(withEnvValue('CONVEX_URL=https://x', 'ATELIER_RUNNER_SECRET', 'new'), 'CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\n');
  assert.equal(withEnvValue('', 'ATELIER_RUNNER_SECRET', 'new'), 'ATELIER_RUNNER_SECRET=new\n');
});
