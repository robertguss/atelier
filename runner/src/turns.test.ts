import { setImmediate } from "node:timers/promises";

import type {
  Harness,
  HarnessEvent,
  QuestionCard,
  SteerOutcome,
  TurnInput,
  TurnRequest,
} from "@atelier/shared";
import { getFunctionName } from "convex/server";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReference_future,
  FunctionReturnType,
} from "convex/server";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { eventQueue } from "./adapters/events.ts";
import { createTurns } from "./turns.ts";
import type { TurnsClient } from "./turns.ts";

const MINUTE = 60_000;

type MutationArgs = Record<string, unknown>;

// Records every mutation by name and answers the ones the runner reads.
class FakeConvex {
  readonly calls: { name: string; args: MutationArgs }[] = [];
  readonly replies: Record<string, (args: MutationArgs) => unknown>;

  constructor(jobs: Record<string, unknown>) {
    this.replies = {
      "runner:claim": (args) =>
        typeof args.commandId === "string"
          ? (jobs[args.commandId] ?? null)
          : null,
      "runner:progress": () => true,
      "runner:raiseHand": () => "hand-1",
      "runner:start": () => ({ editsEnabled: false }),
    };
  }

  mutation<
    Mutation extends
      | FunctionReference<"mutation">
      | FunctionReference_future<"mutation">,
  >(
    ref: Mutation,
    args: FunctionArgs<Mutation>
  ): Promise<Awaited<FunctionReturnType<Mutation>>>;
  // oxlint-disable-next-line require-await -- timer tests advance fake time right after a call is recorded, so replies must settle within one microtask; an added await breaks them
  async mutation(
    ref: FunctionReference<"mutation"> | FunctionReference_future<"mutation">,
    args: MutationArgs
  ): Promise<unknown> {
    const name = getFunctionName(ref);
    this.calls.push({ args, name });
    return this.replies[name]?.(args);
  }

  named(name: string) {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
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
const fakeHarness = () => {
  const runs: FakeRun[] = [];
  const harness: Harness = {
    capabilities: { canRaiseCards: true },
    id: "claude",
    async *runTurn(req, signal, input) {
      const events = eventQueue();
      const run: FakeRun = {
        edits: [],
        events,
        input,
        req,
        signal,
        steers: [],
      };
      input.steer = async (text) => {
        run.steers.push(text);
        return await Promise.resolve<SteerOutcome>("steered");
      };
      input.setEditsEnabled = (on) => {
        run.edits.push(on);
      };
      signal.addEventListener("abort", () => {
        events.push({
          message: "Interrupted",
          retryable: false,
          type: "error",
        });
        events.end();
      });
      runs.push(run);
      yield* events;
    },
    async version() {
      return await Promise.resolve("fake 1.0");
    },
  };
  return { harness, runs };
};

const runJob = (turnId: string) => ({
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
});

const setup = (extraJobs: Record<string, unknown> = {}) => {
  const convex = new FakeConvex({ "c-run": runJob("t1"), ...extraJobs });
  const client: TurnsClient = convex;
  const { harness, runs } = fakeHarness();
  const turns = createTurns({
    appendTranscript() {},
    client,
    harnesses: { claude: harness },
    secret: "s3cret",
    transcriptPath: (turnId) => `/tmp/${turnId}.ndjson`,
  });
  return {
    calls: convex.calls,
    named: (name: string) => convex.named(name),
    replies: convex.replies,
    runs,
    turns,
  };
};

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling: each check must wait for the runner to make progress
    await setImmediate();
  }
  throw new Error("condition never held");
};

// Lets the runner consume what the test just pushed.
const idle = async () => {
  for (let i = 0; i < 20; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn of the event loop must finish before the next
    await setImmediate();
  }
};

const card: QuestionCard = {
  questions: [
    {
      allowFreeText: true,
      header: "Scope",
      id: "scope",
      multiSelect: false,
      options: [{ label: "Small" }, { label: "Large" }],
      text: "Which scope?",
    },
  ],
  requestId: "req-1",
};

const end = (run: FakeRun, ...events: HarnessEvent[]) => {
  for (const event of events) {
    run.events.push(event);
  }
  run.events.end();
};

describe(createTurns, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a question raises a card, and an answer command resolves the harness with the payload", async () => {
    const payload = {
      answeredBy: "Dana",
      answers: [
        { labels: ["Small"], question: "Which scope?", questionId: "scope" },
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
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);

    const answer = run.input.onQuestion(card);
    await until(() => s.named("runner:raiseHand").length > 0);
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

  it("a steer for a turn not running here is rejected without reaching a harness", async () => {
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
    // Exactly one handled command, and it failed.
    expect(s.named("runner:commandHandled")).toMatchObject([{ ok: false }]);
    expect(s.runs).toHaveLength(0);
  });

  it("a steer for a running turn goes to the harness and its outcome is reported", async () => {
    const s = setup({
      "c-steer": {
        commandId: "c-steer",
        payload: { messageId: "m1", text: "Use Postgres" },
        turn: { id: "t1" },
        type: "steer",
      },
    });
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    await s.turns.handle("c-steer");
    expect(run.steers).toStrictEqual(["Use Postgres"]);
    expect(s.named("runner:steerResult")).toStrictEqual([
      { messageId: "m1", outcome: "steered", secret: "s3cret" },
    ]);
    expect(s.named("runner:commandHandled")).toStrictEqual([
      { commandId: "c-steer", ok: true, secret: "s3cret" },
    ]);
    end(run, { text: "done", type: "final" });
    await turn;
  });

  it("start applies the current edit switch, and a settings command changes it live", async () => {
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
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    expect(run.req.editsEnabled).toBeTruthy();
    await s.turns.handle("c-settings");
    expect(run.edits).toStrictEqual([false]);
    expect(s.named("runner:commandHandled")).toStrictEqual([
      { commandId: "c-settings", ok: true, secret: "s3cret" },
    ]);
    end(run, { text: "done", type: "final" });
    await turn;
  });

  it("an interrupt command aborts the running turn, which ends interrupted", async () => {
    const s = setup({
      "c-stop": {
        commandId: "c-stop",
        payload: { reason: "File edits were turned off" },
        turn: { id: "t1" },
        type: "interrupt",
      },
    });
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    await s.turns.handle("c-stop");
    expect(run.signal.aborted).toBeTruthy();
    await turn;
    expect(s.named("runner:fail")[0]).toMatchObject({
      error: "File edits were turned off",
      interrupted: true,
    });
    expect(s.named("runner:finish")).toHaveLength(0);
    expect(s.named("runner:commandHandled")).toStrictEqual([
      { commandId: "c-stop", ok: true, secret: "s3cret" },
    ]);
  });

  it("an open question pauses the 30-minute deadline, and the card expires at 2 hours", async () => {
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
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);

    vi.advanceTimersByTime(10 * MINUTE);
    const answer = run.input.onQuestion(card);
    await until(() => s.named("runner:raiseHand").length > 0);

    vi.advanceTimersByTime(31 * MINUTE);
    // The deadline is paused while the card is open.
    const abortedWhileOpen = run.signal.aborted;
    // The lease is still renewed while the turn waits.
    const renewals = s.named("runner:progress").length;
    vi.advanceTimersByTime(MINUTE);
    expect({
      abortedWhileOpen,
      renewed: s.named("runner:progress").length > renewals,
      timedOut: s.named("runner:handTimedOut"),
    }).toStrictEqual({ abortedWhileOpen: false, renewed: true, timedOut: [] });

    vi.advanceTimersByTime(2 * 60 * MINUTE - 32 * MINUTE);
    await until(() => s.named("runner:handTimedOut").length > 0);
    expect(s.named("runner:handTimedOut")).toStrictEqual([
      { handId: "hand-1", secret: "s3cret" },
    ]);

    // Convex closes the card and tells the agent no decision was made.
    await s.turns.handle("c-expired");
    await expect(answer).resolves.toStrictEqual(noDecision);

    // The deadline resumes with the 20 minutes the turn had left.
    vi.advanceTimersByTime(19 * MINUTE);
    const abortedAfter19 = run.signal.aborted;
    vi.advanceTimersByTime(MINUTE);
    const abortedAfter20 = run.signal.aborted;
    await turn;
    expect({
      abortedAfter19,
      abortedAfter20,
      fail: s.named("runner:fail")[0],
    }).toMatchObject({
      abortedAfter19: false,
      abortedAfter20: true,
      fail: { interrupted: true },
    });
  });

  it("tool activity reaches Convex as items with one-line summaries, not raw output", async () => {
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
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);

    run.events.push({
      id: "call-1",
      name: "Read",
      summary: "src/plan.md",
      type: "tool_call",
    });
    await idle();
    expect(s.named("runner:recordTurnItems")).toHaveLength(0);
    vi.advanceTimersByTime(500);
    await until(() => s.named("runner:recordTurnItems").length > 0);
    expect(s.named("runner:recordTurnItems")[0]).toStrictEqual({
      items: [
        { callId: "call-1", name: "Read", seq: 0, summary: "src/plan.md" },
      ],
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
    expect(s.named("runner:recordTurnItems")[1]?.items).toStrictEqual([
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

  it("the session id is saved as soon as it arrives, before the turn finishes", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    end(
      run,
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
});
