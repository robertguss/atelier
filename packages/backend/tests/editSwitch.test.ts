/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
const modules = import.meta.glob('../convex/**/*.ts');

const SECRET = 'test-secret';
const HARNESSES = [{ id: 'claude' as const, version: 'test' }, { id: 'codex' as const, version: 'test' }, { id: 'pi' as const, version: 'test' }];

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = SECRET;
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: SECRET, name: 'test', machine: 'test', harnesses: HARNESSES });
  const roomId = await owner.mutation(api.rooms.create, { name: 'Planning', runnerId, cwd: '/tmp/planning' });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: 'codex' });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: 'pi' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'user_1' }])));
  const invite = await owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await dana.mutation(api.invites.accept, { token: invite.url.split('/invite/')[1]! });
  vi.unstubAllGlobals();
  const participants = (await owner.query(api.rooms.get, { roomId }))!.participants;
  const claude = participants.find(p => p.harness === 'claude')!;
  const codex = participants.find(p => p.harness === 'codex')!;
  const pi = participants.find(p => p.harness === 'pi')!;
  return { t, owner, dana, roomId, claude, codex, pi };
}

async function allCommands(t: T) {
  return await t.run(async ctx => await ctx.db.query('commands').collect());
}

async function runningTurn(s: Awaited<ReturnType<typeof setup>>, participantId: Id<'participants'>) {
  const turnId = (await s.owner.mutation(api.messages.send, { roomId: s.roomId, body: 'Write the plan file', toParticipantId: participantId }))!;
  const command = (await allCommands(s.t)).find(c => c.turnId === turnId && c.type === 'run_turn')!;
  await s.t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
  await s.t.mutation(api.runner.start, { secret: SECRET, turnId, harnessVersion: 'test' });
  return turnId;
}

async function controlCommands(t: T, turnId: Id<'turns'>) {
  return (await allCommands(t)).filter(c => c.turnId === turnId && c.type !== 'run_turn');
}

test('only the owner can set the edit switch, and both people see it', async () => {
  const s = await setup();
  await expect(s.dana.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true })).rejects.toThrow(/owner/i);
  expect((await s.dana.query(api.agent.pane, { roomId: s.roomId })).editsEnabled).toBe(false);

  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  expect((await s.dana.query(api.agent.pane, { roomId: s.roomId })).editsEnabled).toBe(true);
  const changes = (await s.t.run(ctx => ctx.db.query('ledger').collect())).filter(e => e.type === 'room.edits_changed');
  expect(changes).toHaveLength(1);
  expect(changes[0]!.payload).toEqual({ editsEnabled: true });
});

test('turning edits on mid-turn sends settings to a running Claude turn without interrupting it', async () => {
  const s = await setup();
  const turnId = await runningTurn(s, s.claude._id);
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  const commands = await controlCommands(s.t, turnId);
  expect(commands.map(c => [c.type, c.payload])).toEqual([['settings', { editsEnabled: true }]]);
  const job = await s.t.mutation(api.runner.claim, { secret: SECRET, commandId: commands[0]!._id });
  expect(job).toMatchObject({ type: 'settings', turn: { id: turnId }, payload: { editsEnabled: true } });
});

test('turning edits off mid-turn interrupts running Codex and Pi turns and sends settings to Claude', async () => {
  const s = await setup();
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  const claudeTurn = await runningTurn(s, s.claude._id);
  const codexTurn = await runningTurn(s, s.codex._id);
  const piTurn = await runningTurn(s, s.pi._id);

  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: false });
  expect((await controlCommands(s.t, claudeTurn)).map(c => c.type)).toEqual(['settings']);
  for (const turnId of [codexTurn, piTurn]) {
    const types = (await controlCommands(s.t, turnId)).map(c => c.type);
    expect(types).toContain('interrupt');
    expect(types).toContain('settings');
  }
});

test("a new turn's edit snapshot matches the room when it is dispatched and claimed", async () => {
  const s = await setup();
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  const turnId = (await s.owner.mutation(api.messages.send, { roomId: s.roomId, body: 'Go', toParticipantId: s.claude._id }))!;
  expect((await s.t.run(ctx => ctx.db.get(turnId)))!.editsEnabled).toBe(true);
  const command = (await allCommands(s.t)).find(c => c.turnId === turnId && c.type === 'run_turn')!;
  const job = await s.t.mutation(api.runner.claim, { secret: SECRET, commandId: command._id });
  expect(job!.room.editsEnabled).toBe(true);

  // Switched off between dispatch and claim: the claim carries the room's value now.
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: false });
  const second = (await s.owner.mutation(api.messages.send, { roomId: s.roomId, body: 'Next', toParticipantId: s.pi._id }))!;
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: true });
  const secondCommand = (await allCommands(s.t)).find(c => c.turnId === second && c.type === 'run_turn')!;
  const secondJob = await s.t.mutation(api.runner.claim, { secret: SECRET, commandId: secondCommand._id });
  expect(secondJob!.room.editsEnabled).toBe(true);
  expect((await s.t.run(ctx => ctx.db.get(second)))!.editsEnabled).toBe(true);
  // A queued turn gets no control commands; the claim carries the value.
  expect(await controlCommands(s.t, second)).toHaveLength(0);

  // Switched off between claim and start: start returns the room's value now.
  await s.owner.mutation(api.rooms.setEditsEnabled, { roomId: s.roomId, on: false });
  expect(await s.t.mutation(api.runner.start, { secret: SECRET, turnId: second, harnessVersion: 'test' })).toEqual({ editsEnabled: false });
  expect((await s.t.run(ctx => ctx.db.get(second)))!.editsEnabled).toBe(false);
});
