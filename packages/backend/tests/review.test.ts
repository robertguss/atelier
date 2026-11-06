/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';
const modules = import.meta.glob('../convex/**/*.ts');
beforeEach(() => { vi.useFakeTimers(); process.env.ATELIER_OWNER_EMAILS = 'owner@example.com'; process.env.ATELIER_RUNNER_SECRET = 'test-secret'; });
afterEach(() => { vi.useRealTimers(); });
// Draining the workflow advances the fake clock; a live runner keeps beating.
async function drain(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  await t.mutation(api.runners.heartbeat, { secret: 'test-secret', name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }, { id: 'pi', version: 'test' }] });
}
async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: 'test-secret', name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }, { id: 'pi', version: 'test' }] });
  const roomId = await owner.mutation(api.rooms.create, { name: 'test', runnerId, cwd: '/tmp/test' });
  await owner.mutation(api.rooms.addParticipant, { roomId, harness: 'pi' });
  const room = await owner.query(api.rooms.get, { roomId });
  const participants = room!.participants.filter(p => p.kind === 'harness');
  const ritualId = await owner.mutation(api.rituals.begin, { roomId, request: 'Review independently', participantIds: participants.map(p => p._id) });
  const commands = await t.query(api.runner.pendingCommands, { secret: 'test-secret', runnerId });
  return { t, owner, roomId, runnerId, participants, ritualId, commands };
}
test('sealed progress and answers never reach owner; reveal survives failure and duplicate completion', async () => {
  const { t, owner, roomId, ritualId, commands, participants } = await setup();
  const first = commands[0]!; const second = commands[1]!;
  await t.run(async ctx => { for (const p of participants) await ctx.db.patch(p._id, { harnessSessionId: 'ordinary-session' }); });
  const job = await t.mutation(api.runner.claim, { secret: 'test-secret', commandId: first._id });
  expect(job!.participant.sessionId).toBeUndefined();
  await t.mutation(api.runner.start, { secret: 'test-secret', turnId: first.turnId, harnessVersion: 'test' });
  await t.mutation(api.runner.progress, { secret: 'test-secret', turnId: first.turnId, commandId: first._id, partialText: 'SECRET-PARTIAL' });
  expect(JSON.stringify(await owner.query(api.rituals.get, { ritualId }))).not.toContain('SECRET');
  expect(JSON.stringify(await owner.query(api.messages.timeline, { roomId }))).not.toContain('SECRET');
  const finish = { secret: 'test-secret', turnId: first.turnId, commandId: first._id, finalText: 'SECRET-FINAL', transcriptRef: '/SECRET-TRANSCRIPT', sessionId: 'review-session' };
  await t.mutation(api.runner.finish, finish); await t.mutation(api.runner.finish, finish);
  await t.mutation(api.runner.fail, { secret: 'test-secret', turnId: first.turnId, commandId: first._id, error: 'Late failure' });
  expect(JSON.stringify(await owner.query(api.messages.timeline, { roomId }))).not.toContain('SECRET');
  expect(JSON.stringify(await owner.query(api.rituals.get, { ritualId }))).not.toContain('SECRET');
  expect(await t.mutation(internal.rituals.reveal, { ritualId })).toBe(false);
  await expect(owner.mutation(api.rituals.decide, { ritualId, choice: 'too early', rationale: '' })).rejects.toThrow();
  await t.mutation(api.runner.fail, { secret: 'test-secret', turnId: second.turnId, commandId: second._id, error: 'SECRET-ERROR' });
  expect(JSON.stringify(await owner.query(api.rituals.get, { ritualId }))).not.toContain('SECRET');
  await drain(t);
  const revealed = await owner.query(api.rituals.get, { ritualId });
  expect(revealed!.status).toBe('revealed');
  expect(revealed!.turns.map(t => t.answer)).toContain('SECRET-FINAL');
  expect(revealed!.pushStatus).toBe('skipped');
  expect((await owner.query(api.rooms.get, { roomId }))!.participants.filter(p => p.kind === 'harness').map(p => p.harnessSessionId)).toEqual(['ordinary-session', 'ordinary-session']);
  await owner.mutation(api.rituals.recordCrux, { ritualId, statement: 'Tradeoff', options: ['A', 'B'] });
  await owner.mutation(api.rituals.decide, { ritualId, choice: 'A', rationale: 'Because' });
  const decision = (await owner.query(api.rituals.get, { ritualId }))!.decisions[0]!;
  await owner.mutation(api.messages.send, { roomId, body: 'Implement', toParticipantId: participants[0]!._id, decisionId: decision._id });
  await t.run(async ctx => {
    const ledger = await ctx.db.query('ledger').collect();
    expect(ledger.filter(e => e.type === 'ritual.revealed')).toHaveLength(1);
    expect(ledger.find(e => e.type === 'message.posted')!.parentLedgerId).toBe(ledger.find(e => e.type === 'decision.recorded')!._id);
    expect((await ctx.db.query('messages').collect()).filter(m => m.turnId === first.turnId)).toHaveLength(1);
  });
});
test('owner cancellation and runner restart release the reveal barrier; unauthorized reads fail', async () => {
  const { t, owner, roomId, runnerId, ritualId, commands } = await setup();
  await expect(t.query(api.rituals.get, { ritualId })).rejects.toThrow();
  await expect(t.query(api.messages.timeline, { roomId })).rejects.toThrow();
  await owner.mutation(api.messages.cancel, { turnId: commands[0]!.turnId });
  await t.mutation(api.runner.claim, { secret: 'test-secret', commandId: commands[1]!._id });
  await t.mutation(api.runner.recover, { secret: 'test-secret', runnerId });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const review = await owner.query(api.rituals.get, { ritualId });
  expect(review!.status).toBe('revealed');
  expect(review!.turns.every(t => t.status === 'failed')).toBe(true);
});
test('snapshot is fixed once and cannot leak through owner queries; participant validation is atomic', async () => {
  const { t, owner, roomId, ritualId, participants } = await setup();
  expect(await t.mutation(api.runner.prepareReview, { secret: 'test-secret', ritualId, snapshot: 'FIRST-SNAPSHOT' })).toBe('FIRST-SNAPSHOT');
  expect(await t.mutation(api.runner.prepareReview, { secret: 'test-secret', ritualId, snapshot: 'SECOND-SNAPSHOT' })).toBe('FIRST-SNAPSHOT');
  expect(JSON.stringify(await owner.query(api.rituals.get, { ritualId }))).not.toContain('SNAPSHOT');
  await expect(owner.mutation(api.rituals.begin, { roomId, request: 'duplicate', participantIds: [participants[0]!._id, participants[0]!._id] })).rejects.toThrow();
  expect(await owner.query(api.rituals.list, { roomId })).toHaveLength(1);
});
test('push uses generic reveal text, removes invalid devices, and records retryable failure', async () => {
  const { t, owner, ritualId, commands } = await setup();
  await owner.mutation(api.push.register, { token: 'ExpoPushToken[device_1]', platform: 'ios' });
  await owner.mutation(api.push.register, { token: 'ExpoPushToken[device_1]', platform: 'ios' });
  expect(await t.query(internal.push.recipients, { ritualId })).toEqual([]);
  for (const c of commands) await t.mutation(api.runner.fail, { secret: 'test-secret', turnId: c.turnId, commandId: c._id, error: 'PRIVATE_FAILURE' });
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).not.toContain('PRIVATE_FAILURE');
    expect(await owner.query(api.push.readiness, {})).toEqual({ registered: false });
    await owner.mutation(api.push.register, { token: 'ExpoPushToken[device_2]', platform: 'ios' });
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(t.action(internal.push.send, { ritualId })).rejects.toThrow('503');
    expect((await owner.query(api.rituals.get, { ritualId }))!.pushStatus).toBe('failed');
  } finally { vi.unstubAllGlobals(); }
});
test('ordinary turns still stream, resume sessions, and show completed answers', async () => {
  const { t, owner, roomId, runnerId, ritualId, commands, participants } = await setup();
  for (const c of commands) await owner.mutation(api.messages.cancel, { turnId: c.turnId });
  await drain(t);
  expect((await owner.query(api.rituals.get, { ritualId }))!.status).toBe('revealed');
  const turnId = await owner.mutation(api.messages.send, { roomId, body: 'ordinary request', toParticipantId: participants[0]!._id });
  const c = (await t.query(api.runner.pendingCommands, { secret: 'test-secret', runnerId })).find(c => c.turnId === turnId)!;
  const job = await t.mutation(api.runner.claim, { secret: 'test-secret', commandId: c._id });
  expect(job!.turn.independentReview).toBe(false);
  await t.mutation(api.runner.start, { secret: 'test-secret', turnId, harnessVersion: 'test' });
  await t.mutation(api.runner.progress, { secret: 'test-secret', turnId, commandId: c._id, partialText: 'ordinary stream' });
  expect(JSON.stringify(await owner.query(api.messages.timeline, { roomId }))).toContain('ordinary stream');
  await t.mutation(api.runner.finish, { secret: 'test-secret', turnId, commandId: c._id, finalText: 'ordinary answer', sessionId: 'next-session', transcriptRef: '/ordinary' });
  expect(JSON.stringify(await owner.query(api.messages.timeline, { roomId }))).toContain('ordinary answer');
  expect((await owner.query(api.rooms.get, { roomId }))!.participants.find(p => p._id === participants[0]!._id)!.harnessSessionId).toBe('next-session');
});
test('review follow-up needs no crux or decision, but cannot expose sealed answers', async () => {
  const { t, owner, roomId, ritualId, commands, participants } = await setup();
  const first = commands[0]!;
  const participant = await t.run(ctx => ctx.db.get(first.turnId));
  const followup = { roomId, body: 'Tell me more', toParticipantId: participant!.participantId, reviewTurnId: first.turnId };
  await expect(owner.mutation(api.messages.send, followup)).rejects.toThrow('Review is not available');
  await expect(owner.mutation(api.rituals.saveTakeaway, { ritualId, body: 'Too early' })).rejects.toThrow();
  await t.mutation(api.runner.claim, { secret: 'test-secret', commandId: first._id });
  await t.mutation(api.runner.finish, { secret: 'test-secret', commandId: first._id, turnId: first.turnId, finalText: 'Review evidence', transcriptRef: '/test' });
  await owner.mutation(api.messages.cancel, { turnId: commands[1]!.turnId });
  await drain(t);
  const turnId = await owner.mutation(api.messages.send, followup);
  await t.run(async ctx => {
    expect((await ctx.db.get(turnId))!.prompt).toContain('Review evidence');
    const ledger = await ctx.db.query('ledger').collect();
    expect(ledger.find(e => e.type === 'message.posted')!.parentLedgerId).toBe(ledger.find(e => e.type === 'ritual.revealed')!._id);
  });
  const wrongParticipant = participants.find(p => p._id !== participant!.participantId)!;
  await expect(owner.mutation(api.messages.send, { ...followup, toParticipantId: wrongParticipant._id })).rejects.toThrow('Choose the participant');
  await owner.mutation(api.rituals.saveTakeaway, { ritualId, body: 'Remember this' });
  const review = await owner.query(api.rituals.get, { ritualId });
  expect(review!.status).toBe('revealed');
  expect(review!.takeaways.map(n => n.body)).toEqual(['Remember this']);
  expect(review!.cruxes).toHaveLength(0);
  expect(review!.decisions).toHaveLength(0);
});
