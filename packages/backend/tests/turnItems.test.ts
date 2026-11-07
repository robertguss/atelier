/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
const modules = import.meta.glob('../convex/**/*.ts');

const SECRET = 'test-secret';

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = SECRET;
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: SECRET, name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }] });
  const roomId = await owner.mutation(api.rooms.create, { name: 'Planning', runnerId, cwd: '/tmp/planning' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'user_1' }])));
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: invite.url.split('/invite/')[1]! });
  vi.unstubAllGlobals();
  const claude = (await owner.query(api.rooms.get, { roomId }))!.participants.find(p => p.harness === 'claude')!;
  return { t, owner, dana, roomId, claude };
}

test('tool activity is stored per call, a result updates its call, and both people see it after the turn ends', async () => {
  const { t, owner, dana, roomId, claude } = await setup();
  const turnId = (await owner.mutation(api.messages.send, { roomId, body: 'Read the plan', toParticipantId: claude._id }))!;
  const command = (await t.run(ctx => ctx.db.query('commands').collect())).find(c => c.turnId === turnId && c.type === 'run_turn')!;
  await t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
  await t.mutation(api.runner.start, { secret: SECRET, turnId, harnessVersion: 'test' });

  await t.mutation(api.runner.recordTurnItems, { secret: SECRET, turnId, items: [
    { callId: 'call-1', seq: 0, name: 'Read', summary: 'docs/plan.md' },
    { callId: 'call-2', seq: 1, name: 'Grep', summary: 'x'.repeat(500) },
  ] });
  await t.mutation(api.runner.recordTurnItems, { secret: SECRET, turnId, items: [{ callId: 'call-1', seq: 0, name: 'Read', summary: 'docs/plan.md', ok: true }] });
  await t.mutation(api.runner.finish, { secret: SECRET, turnId, commandId: command._id, finalText: 'Done', transcriptRef: '/tmp/t.ndjson' });

  for (const viewer of [owner, dana]) {
    const pane = await viewer.query(api.agent.pane, { roomId });
    expect(pane.turns.find(x => x.id === turnId)!.items).toEqual([
      { name: 'Read', summary: 'docs/plan.md', ok: true },
      { name: 'Grep', summary: 'x'.repeat(200), ok: null },
    ]);
  }
  expect(await t.run(ctx => ctx.db.query('turnItems').collect())).toHaveLength(2);
});
