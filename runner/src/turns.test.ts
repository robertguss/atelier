import type {
  Harness,
  HarnessEvent,
  QuestionCard,
  TurnInput,
  TurnRequest,
} from "@atelier/shared";
import { getFunctionName } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";

import { eventQueue } from "./adapters/events.ts";
import { createTurns } from "./turns.ts";
import type { TurnsClient } from "./turns.ts";

afterEach(() => {
  vi.useRealTimers();
});

const MINUTE = 60_000;

// Records every mutation by name and answers the ones the runner reads.
function fakeConvex(jobs: Record<string, unknown>) {
  const calls: { name: string; args: any }[] = [];
  const replies: Record<string, (args: any) => unknown> = {
    "runner:claim": (args) => jobs[args.commandId] ?? null,
    "runner:progress": () => true,
    "runner:raiseHand": () => "hand-1",
    "runner:start": () => ({ editsEnabled: false }),
  };
  const client = {
    async mutation(ref: any, args: any) {
      const name = getFunctionName(ref);
      calls.push({ args, name });
      return replies[name]?.(args);
    },
  };
  const named = (name: string) =>
    calls.filter((c) => c.name === name).map((c) => c.args);
  return { calls, client: client as unknown as TurnsClient, named, replies };
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
    capabilities: { canRaiseCards: true },
    id: "claude",
    async *runTurn(req, signal, input) {
      const events = eventQueue();
      const run: FakeRun = {
        req,
        signal,
        input,
        events,
        steers: [],
        edits: [],
      };
      input.steer = async (text) => {
        run.steers.push(text);
        return "steered";
      };
      input.setEditsEnabled = (on) => {
        run.edits.push(on);
      };
      signal.addEventListener("abort", () => {
        events.push({
          type: "error",
          message: "Interrupted",
          retryable: false,
        });
        events.end();
      });
      runs.push(run);
      yield* events;
    },
    async version() {
      return "fake 1.0";
    },
  };
  return { harness, runs };
}

function runJob(turnId: string) {
  return {
    commandId: "c-run",
    participant: { harness: "claude", id: "p-claude", sessionId: undefined },
    room: {
      cwd: "/tmp/room",
      editsEnabled: false,
      handbook: "",
      id: "r1",
      name: "Room",
    },
    turn: { id: turnId, independentReview: false, prompt: "Plan the launch" },
    type: "run_turn",
  };
}

function setup(extraJobs: Record<string, unknown> = {}) {
  const convex = fakeConvex({ "c-run": runJob("t1"), ...extraJobs });
  const { harness, runs } = fakeHarness();
  const turns = createTurns({
    appendTranscript() {},
    client: convex.client,
    harnesses: { claude: harness },
    secret: "s3cret",
    transcriptPath: (turnId) => `/tmp/${turnId}.ndjson`,
  });
  return { ...convex, runs, turns };
}

async function until(condition: () => unknown) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never held");
}

// Lets the runner consume what the test just pushed.
async function idle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const card: QuestionCard = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      text: "Which scope?",
      options: [{ label: "Small" }, { label: "Large" }],
      multiSelect: false,
      allowFreeText: true,
    },
  ],
  requestId: "req-1",
};

function end(run: FakeRun, ...events: HarnessEvent[]) {
  for (const event of events) {
    run.events.push(event);
  }
  run.events.end();
}

test("a question raises a card, and an answer command resolves the harness with the payload", async () => {
  const payload = {
    answeredBy: "Dana",
    answers: [
      { questionId: "scope", question: "Which scope?", labels: ["Small"] },
    ],
    handId: "hand-1",
    requestId: "req-1",
    via: "card",
  };
  const s = setup({
    "c-answer": {
      commandId: "c-answer",
      payload,
      turn: { id: "t1" },
      type: "answer",
    },
  });
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  const answer = run.input.onQuestion(card);
  await until(() => s.named("runner:raiseHand").length);
  expect(s.named("runner:raiseHand")).toStrictEqual([
    {
      questions: card.questions,
      requestId: "req-1",
      secret: "s3cret",
      turnId: "t1",
    },
  ]);

  await s.turns.handle("c-answer");
  await expect(answer).resolves.toStrictEqual(payload);
  expect(s.named("runner:commandHandled")).toStrictEqual([
    { commandId: "c-answer", ok: true, secret: "s3cret" },
  ]);

  end(run, { text: "Small it is", type: "final" });
  await turn;
  expect(s.named("runner:finish")).toHaveLength(1);
});

test("a steer for a turn not running here is rejected without reaching a harness", async () => {
  const s = setup({
    "c-steer": {
      commandId: "c-steer",
      payload: { messageId: "m1", text: "Use Postgres" },
      turn: { id: "t-elsewhere" },
      type: "steer",
    },
  });
  await s.turns.handle("c-steer");
  expect(s.named("runner:steerResult")).toStrictEqual([
    { messageId: "m1", outcome: "rejected", secret: "s3cret" },
  ]);
  expect(s.named("runner:commandHandled")).toHaveLength(1);
  expect(s.named("runner:commandHandled")[0].ok).toBe(false);
  expect(s.runs).toHaveLength(0);
});

test("a steer for a running turn goes to the harness and its outcome is reported", async () => {
  const s = setup({
    "c-steer": {
      commandId: "c-steer",
      payload: { messageId: "m1", text: "Use Postgres" },
      turn: { id: "t1" },
      type: "steer",
    },
  });
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  await s.turns.handle("c-steer");
  expect(s.runs[0]!.steers).toStrictEqual(["Use Postgres"]);
  expect(s.named("runner:steerResult")).toStrictEqual([
    { messageId: "m1", outcome: "steered", secret: "s3cret" },
  ]);
  expect(s.named("runner:commandHandled")).toStrictEqual([
    { commandId: "c-steer", ok: true, secret: "s3cret" },
  ]);
  end(s.runs[0]!, { text: "done", type: "final" });
  await turn;
});

test("start applies the current edit switch, and a settings command changes it live", async () => {
  const s = setup({
    "c-settings": {
      commandId: "c-settings",
      payload: { editsEnabled: false },
      turn: { id: "t1" },
      type: "settings",
    },
  });
  s.replies["runner:start"] = () => ({ editsEnabled: true });
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  expect(s.runs[0]!.req.editsEnabled).toBe(true);
  await s.turns.handle("c-settings");
  expect(s.runs[0]!.edits).toStrictEqual([false]);
  expect(s.named("runner:commandHandled")).toStrictEqual([
    { commandId: "c-settings", ok: true, secret: "s3cret" },
  ]);
  end(s.runs[0]!, { text: "done", type: "final" });
  await turn;
});

test("an interrupt command aborts the running turn, which ends interrupted", async () => {
  const s = setup({
    "c-stop": {
      commandId: "c-stop",
      payload: { reason: "File edits were turned off" },
      turn: { id: "t1" },
      type: "interrupt",
    },
  });
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  await s.turns.handle("c-stop");
  expect(s.runs[0]!.signal.aborted).toBe(true);
  await turn;
  const [failed] = s.named("runner:fail");
  expect(failed.interrupted).toBe(true);
  expect(failed.error).toBe("File edits were turned off");
  expect(s.named("runner:finish")).toHaveLength(0);
  expect(s.named("runner:commandHandled")).toStrictEqual([
    { commandId: "c-stop", ok: true, secret: "s3cret" },
  ]);
});

test("an open question pauses the 30-minute deadline, and the card expires at 2 hours", async () => {
  vi.useFakeTimers({
    now: 0,
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  const noDecision = {
    handId: "hand-1",
    message: "No one answered",
    noDecision: true,
    requestId: "req-1",
  };
  const s = setup({
    "c-expired": {
      commandId: "c-expired",
      payload: noDecision,
      turn: { id: "t1" },
      type: "answer",
    },
  });
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  vi.advanceTimersByTime(10 * MINUTE);
  const answer = run.input.onQuestion(card);
  await until(() => s.named("runner:raiseHand").length);

  vi.advanceTimersByTime(31 * MINUTE);
  expect(
    run.signal.aborted,
    "the deadline is paused while the card is open"
  ).toBe(false);
  // The lease is still renewed while the turn waits.
  const renewals = s.named("runner:progress").length;
  vi.advanceTimersByTime(MINUTE);
  expect(s.named("runner:progress").length > renewals).toBeTruthy();
  expect(s.named("runner:handTimedOut")).toHaveLength(0);

  vi.advanceTimersByTime(2 * 60 * MINUTE - 32 * MINUTE);
  await until(() => s.named("runner:handTimedOut").length);
  expect(s.named("runner:handTimedOut")).toStrictEqual([
    { handId: "hand-1", secret: "s3cret" },
  ]);

  // Convex closes the card and tells the agent no decision was made.
  await s.turns.handle("c-expired");
  await expect(answer).resolves.toStrictEqual(noDecision);

  // The deadline resumes with the 20 minutes the turn had left.
  vi.advanceTimersByTime(19 * MINUTE);
  expect(run.signal.aborted).toBe(false);
  vi.advanceTimersByTime(MINUTE);
  expect(run.signal.aborted).toBe(true);
  await turn;
  expect(s.named("runner:fail")[0].interrupted).toBe(true);
});

test("tool activity reaches Convex as items with one-line summaries, not raw output", async () => {
  vi.useFakeTimers({
    now: 0,
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  const s = setup();
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  const run = s.runs[0]!;

  run.events.push({
    id: "call-1",
    name: "Read",
    summary: "src/plan.md",
    type: "tool_call",
  });
  await idle();
  expect(s.named("runner:recordTurnItems")).toHaveLength(0);
  vi.advanceTimersByTime(500);
  await until(() => s.named("runner:recordTurnItems").length);
  expect(s.named("runner:recordTurnItems")[0]).toStrictEqual({
    items: [{ callId: "call-1", seq: 0, name: "Read", summary: "src/plan.md" }],
    secret: "s3cret",
    turnId: "t1",
  });

  // Whatever else an adapter attaches to a result stays on the runner.
  run.events.push({
    id: "call-1",
    ok: true,
    output: "RAW FILE CONTENTS",
    type: "tool_result",
  });
  await idle();
  vi.advanceTimersByTime(500);
  await until(() => s.named("runner:recordTurnItems").length === 2);
  expect(s.named("runner:recordTurnItems")[1].items).toStrictEqual([
    {
      callId: "call-1",
      name: "Read",
      ok: true,
      seq: 0,
      summary: "src/plan.md",
    },
  ]);

  end(run, { text: "done", type: "final" });
  await turn;
  expect(!JSON.stringify(s.calls).includes("RAW FILE CONTENTS")).toBeTruthy();
});

test("the session id is saved as soon as it arrives, before the turn finishes", async () => {
  const s = setup();
  const turn = s.turns.handle("c-run");
  await until(() => s.runs[0]);
  end(
    s.runs[0]!,
    { sessionId: "sess-1", type: "session" },
    { text: "done", type: "final" }
  );
  await turn;
  const names = s.calls.map((c) => c.name);
  expect(s.named("runner:sessionStarted")).toStrictEqual([
    { secret: "s3cret", sessionId: "sess-1", turnId: "t1" },
  ]);
  expect(
    names.indexOf("runner:sessionStarted") < names.indexOf("runner:finish")
  ).toBeTruthy();
});
