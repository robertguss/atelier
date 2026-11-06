import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import type { Harness, HarnessEvent, QuestionCard, TurnInput, TurnRequest } from '@atelier/shared';
import { eventQueue } from './adapters/events.ts';
import { createTurns, type TurnsClient } from './turns.ts';

afterEach(() => mock.timers.reset());

const MINUTE = 60_000;

// Records every mutation by name and answers the ones the runner reads.
function fakeConvex(jobs: Record<string, unknown>) {
  const calls: { name: string; args: any }[] = [];
  const replies: Record<string, (args: any) => unknown> = {
    'runner:claim': (args) => jobs[args.commandId] ?? null,
    'runner:start': () => ({ editsEnabled: false }),
    'runner:progress': () => true,
    'runner:raiseHand': () => 'hand-1',
  };
  const client = {
    async mutation(ref: any, args: any) {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      return replies[name]?.(args);
    },
  };
  const named = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args);
  return { client: client as unknown as TurnsClient, calls, replies, named };
}

interface FakeRun {
  req: TurnRequest;
  signal: AbortSignal;
  input: TurnInput;
  events: ReturnType<typeof eventQueue>;
  steers: string[];
  edits: boolean[];
}

// A harness the test drives by pushing events into the running turn.
function fakeHarness() {
  const runs: FakeRun[] = [];
  const harness: Harness = {
    id: 'claude',
    capabilities: { canRaiseCards: true },
    async version() { return 'fake 1.0'; },
    async *runTurn(req, signal, input) {
      const events = eventQueue();
      const run: FakeRun = { req, signal, input, events, steers: [], edits: [] };
      input.steer = async (text) => { run.steers.push(text); return 'steered'; };
      input.setEditsEnabled = (on) => { run.edits.push(on); };
      signal.addEventListener('abort', () => {
        events.push({ type: 'error', message: 'Interrupted', retryable: false });
        events.end();
      });
      runs.push(run);
      yield* events;
    },
  };
  return { harness, runs };
}

function runJob(turnId: string) {
  return {
    commandId: 'c-run',
    type: 'run_turn',
    turn: { id: turnId, prompt: 'Plan the launch', independentReview: false },
    participant: { id: 'p-claude', harness: 'claude', sessionId: undefined },
    room: { id: 'r1', cwd: '/tmp/room', name: 'Room', handbook: '', editsEnabled: false },
  };
}

function setup(extraJobs: Record<string, unknown> = {}) {
  const convex = fakeConvex({ 'c-run': runJob('t1'), ...extraJobs });
  const { harness, runs } = fakeHarness();
  const turns = createTurns({
    client: convex.client,
    secret: 's3cret',
    harnesses: { claude: harness },
    appendTranscript() {},
    transcriptPath: (turnId) => `/tmp/${turnId}.ndjson`,
  });
  return { ...convex, runs, turns };
}

async function until(condition: () => unknown) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never held');
}

// Lets the runner consume what the test just pushed.
async function idle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const card: QuestionCard = {
  requestId: 'req-1',
  questions: [{ id: 'scope', header: 'Scope', text: 'Which scope?', options: [{ label: 'Small' }, { label: 'Large' }], multiSelect: false, allowFreeText: true }],
};

function end(run: FakeRun, ...events: HarnessEvent[]) {
  for (const event of events) run.events.push(event);
  run.events.end();
}

test('a question raises a card, and an answer command resolves the harness with the payload', async () => {
  const payload = {
    handId: 'hand-1', requestId: 'req-1', answeredBy: 'Dana', via: 'card',
    answers: [{ questionId: 'scope', question: 'Which scope?', labels: ['Small'] }],
  };
  const s = setup({ 'c-answer': { commandId: 'c-answer', type: 'answer', turn: { id: 't1' }, payload } });
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  const answer = run.input.onQuestion(card);
  await until(() => s.named('runner:raiseHand').length);
  assert.deepEqual(s.named('runner:raiseHand'), [{ secret: 's3cret', turnId: 't1', requestId: 'req-1', questions: card.questions }]);

  await s.turns.handle('c-answer');
  assert.deepEqual(await answer, payload);
  assert.deepEqual(s.named('runner:commandHandled'), [{ secret: 's3cret', commandId: 'c-answer', ok: true }]);

  end(run, { type: 'final', text: 'Small it is' });
  await turn;
  assert.equal(s.named('runner:finish').length, 1);
});

test('a steer for a turn not running here is rejected without reaching a harness', async () => {
  const s = setup({ 'c-steer': { commandId: 'c-steer', type: 'steer', turn: { id: 't-elsewhere' }, payload: { messageId: 'm1', text: 'Use Postgres' } } });
  await s.turns.handle('c-steer');
  assert.deepEqual(s.named('runner:steerResult'), [{ secret: 's3cret', messageId: 'm1', outcome: 'rejected' }]);
  assert.equal(s.named('runner:commandHandled').length, 1);
  assert.equal(s.named('runner:commandHandled')[0].ok, false);
  assert.equal(s.runs.length, 0);
});

test('a steer for a running turn goes to the harness and its outcome is reported', async () => {
  const s = setup({ 'c-steer': { commandId: 'c-steer', type: 'steer', turn: { id: 't1' }, payload: { messageId: 'm1', text: 'Use Postgres' } } });
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  await s.turns.handle('c-steer');
  assert.deepEqual(s.runs[0]!.steers, ['Use Postgres']);
  assert.deepEqual(s.named('runner:steerResult'), [{ secret: 's3cret', messageId: 'm1', outcome: 'steered' }]);
  assert.deepEqual(s.named('runner:commandHandled'), [{ secret: 's3cret', commandId: 'c-steer', ok: true }]);
  end(s.runs[0]!, { type: 'final', text: 'done' });
  await turn;
});

test('start applies the current edit switch, and a settings command changes it live', async () => {
  const s = setup({ 'c-settings': { commandId: 'c-settings', type: 'settings', turn: { id: 't1' }, payload: { editsEnabled: false } } });
  s.replies['runner:start'] = () => ({ editsEnabled: true });
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  assert.equal(s.runs[0]!.req.editsEnabled, true);
  await s.turns.handle('c-settings');
  assert.deepEqual(s.runs[0]!.edits, [false]);
  assert.deepEqual(s.named('runner:commandHandled'), [{ secret: 's3cret', commandId: 'c-settings', ok: true }]);
  end(s.runs[0]!, { type: 'final', text: 'done' });
  await turn;
});

test('an interrupt command aborts the running turn, which ends interrupted', async () => {
  const s = setup({ 'c-stop': { commandId: 'c-stop', type: 'interrupt', turn: { id: 't1' }, payload: { reason: 'File edits were turned off' } } });
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  await s.turns.handle('c-stop');
  assert.equal(s.runs[0]!.signal.aborted, true);
  await turn;
  const [failed] = s.named('runner:fail');
  assert.equal(failed.interrupted, true);
  assert.equal(failed.error, 'File edits were turned off');
  assert.equal(s.named('runner:finish').length, 0);
  assert.deepEqual(s.named('runner:commandHandled'), [{ secret: 's3cret', commandId: 'c-stop', ok: true }]);
});

test('an open question pauses the 30-minute deadline, and the card expires at 2 hours', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const noDecision = { handId: 'hand-1', requestId: 'req-1', noDecision: true, message: 'No one answered' };
  const s = setup({ 'c-expired': { commandId: 'c-expired', type: 'answer', turn: { id: 't1' }, payload: noDecision } });
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  mock.timers.tick(10 * MINUTE);
  const answer = run.input.onQuestion(card);
  await until(() => s.named('runner:raiseHand').length);

  mock.timers.tick(31 * MINUTE);
  assert.equal(run.signal.aborted, false, 'the deadline is paused while the card is open');
  // The lease is still renewed while the turn waits.
  const renewals = s.named('runner:progress').length;
  mock.timers.tick(MINUTE);
  assert.ok(s.named('runner:progress').length > renewals);
  assert.equal(s.named('runner:handTimedOut').length, 0);

  mock.timers.tick(2 * 60 * MINUTE - 32 * MINUTE);
  await until(() => s.named('runner:handTimedOut').length);
  assert.deepEqual(s.named('runner:handTimedOut'), [{ secret: 's3cret', handId: 'hand-1' }]);

  // Convex closes the card and tells the agent no decision was made.
  await s.turns.handle('c-expired');
  assert.deepEqual(await answer, noDecision);

  // The deadline resumes with the 20 minutes the turn had left.
  mock.timers.tick(19 * MINUTE);
  assert.equal(run.signal.aborted, false);
  mock.timers.tick(MINUTE);
  assert.equal(run.signal.aborted, true);
  await turn;
  assert.equal(s.named('runner:fail')[0].interrupted, true);
});

test('tool activity reaches Convex as items with one-line summaries, not raw output', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const s = setup();
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  run.events.push({ type: 'tool_call', id: 'call-1', name: 'Read', summary: 'src/plan.md' });
  await idle();
  assert.equal(s.named('runner:recordTurnItems').length, 0, 'items wait for the next flush');
  mock.timers.tick(500);
  await until(() => s.named('runner:recordTurnItems').length);
  assert.deepEqual(s.named('runner:recordTurnItems')[0], {
    secret: 's3cret', turnId: 't1', items: [{ callId: 'call-1', seq: 0, name: 'Read', summary: 'src/plan.md' }],
  });

  // Whatever else an adapter attaches to a result stays on the runner.
  run.events.push({ type: 'tool_result', id: 'call-1', ok: true, output: 'RAW FILE CONTENTS' } as HarnessEvent);
  await idle();
  mock.timers.tick(500);
  await until(() => s.named('runner:recordTurnItems').length === 2);
  assert.deepEqual(s.named('runner:recordTurnItems')[1].items, [{ callId: 'call-1', seq: 0, name: 'Read', summary: 'src/plan.md', ok: true }]);

  end(run, { type: 'final', text: 'done' });
  await turn;
  assert.ok(!JSON.stringify(s.calls).includes('RAW FILE CONTENTS'));
});

test('the session id is saved as soon as it arrives, before the turn finishes', async () => {
  const s = setup();
  const turn = s.turns.handle('c-run');
  await until(() => s.runs[0]);
  end(s.runs[0]!, { type: 'session', sessionId: 'sess-1' }, { type: 'final', text: 'done' });
  await turn;
  const names = s.calls.map((c) => c.name);
  assert.deepEqual(s.named('runner:sessionStarted'), [{ secret: 's3cret', turnId: 't1', sessionId: 'sess-1' }]);
  assert.ok(names.indexOf('runner:sessionStarted') < names.indexOf('runner:finish'));
});
