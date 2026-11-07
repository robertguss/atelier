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
import { documentTools, scribeTools } from "./room-tools.ts";
import type { AskRoom, RoomToolSet } from "./room-tools.ts";
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
  /** Thrown by the adapter once its events run out. */
  crash?: Error;
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
      if (run.crash) {
        throw run.crash;
      }
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

// Issues one token per turn and records what is still live.
const fakeRoomTools = () => {
  const live = new Map<string, string>();
  const issued: {
    turnId: string;
    token: string;
    tools?: RoomToolSet;
    ask?: AskRoom;
  }[] = [];
  let next = 0;
  return {
    async issue(
      turnId: string,
      options: { tools?: RoomToolSet; ask?: AskRoom } = {}
    ) {
      next += 1;
      const token = `room-token-${next}`;
      live.set(token, turnId);
      issued.push({ token, turnId, ...options });
      return await Promise.resolve({
        token,
        url: "http://127.0.0.1:40123/mcp",
      });
    },
    issued,
    live,
    revoke(token: string) {
      live.delete(token);
    },
  };
};

const setup = (extraJobs: Record<string, unknown> = {}) => {
  const convex = new FakeConvex({ "c-run": runJob("t1"), ...extraJobs });
  const client: TurnsClient = convex;
  const { harness, runs } = fakeHarness();
  const roomTools = fakeRoomTools();
  const transcript: unknown[] = [];
  const turns = createTurns({
    appendTranscript(_turnId, record) {
      transcript.push(record);
    },
    client,
    harnesses: { claude: harness },
    roomTools,
    secret: "s3cret",
    transcriptPath: (turnId) => `/tmp/${turnId}.ndjson`,
  });
  return {
    calls: convex.calls,
    named: (name: string) => convex.named(name),
    replies: convex.replies,
    roomTools,
    runs,
    transcript,
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

const startScribe = async () => {
  const scribe = {
    ...runJob("t-scribe"),
    commandId: "c-scribe",
    documentMode: "scribe",
    participant: {
      harness: "claude",
      id: "p-claude",
      sessionId: "ordinary-session",
    },
  };
  const s = setup({ "c-scribe": scribe });
  s.replies["runner:start"] = () => ({ editsEnabled: true });
  const turn = s.turns.handle("c-scribe");
  await until(() => s.runs.length > 0);
  const [run] = s.runs;
  assert(run);
  return { run, s, turn };
};

const finishedWith = async (...events: HarnessEvent[]) => {
  const s = setup();
  const turn = s.turns.handle("c-run");
  await until(() => s.runs.length > 0);
  const [run] = s.runs;
  assert(run);
  end(run, ...events);
  await turn;
  const [finished] = s.named("runner:finish");
  return { finalText: finished?.finalText, narration: finished?.narration };
};

describe(createTurns, () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    run.events.push({ text: "Checking", type: "text_delta" });
    await idle();
    await s.turns.handle("c-steer");
    expect(run.steers).toStrictEqual(["Use Postgres"]);
    expect(s.named("runner:steerResult")).toStrictEqual([
      {
        messageId: "m1",
        outcome: "steered",
        secret: "s3cret",
        streamOffset: "Checking".length,
      },
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

  it("finish carries the narration the harness reported, and clears the stream when the answer is the whole stream", async () => {
    const withNarration = await finishedWith(
      { text: "Looking first", type: "text_delta" },
      { narration: "Looking first", text: "The answer", type: "final" }
    );
    const wholeStream = await finishedWith(
      { text: "Only the stream", type: "text_delta" },
      { narration: "Only the stream", text: "", type: "final" }
    );
    expect({ wholeStream, withNarration }).toStrictEqual({
      wholeStream: { finalText: "Only the stream", narration: "" },
      withNarration: { finalText: "The answer", narration: "Looking first" },
    });
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

  it("an ordinary turn gets a room tools token, and it is revoked before the turn finishes", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [issued] = s.roomTools.issued;
    const [run] = s.runs;
    assert(issued && run);
    expect(issued.turnId).toBe("t1");
    expect(run.req.roomTools).toStrictEqual({
      token: issued.token,
      url: "http://127.0.0.1:40123/mcp",
    });
    let liveAtFinish = -1;
    s.replies["runner:finish"] = () => {
      liveAtFinish = s.roomTools.live.size;
    };
    end(run, { text: "done", type: "final" });
    await turn;
    expect(s.named("runner:finish")).toHaveLength(1);
    // Revoked before Convex hears the turn finished.
    expect(liveAtFinish).toBe(0);
    expect(s.roomTools.live.size).toBe(0);
  });

  it("a finish that Convex rejects fails the turn at once, so a scribe run does not hold the document until its lease lapses", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    s.replies["runner:finish"] = () => {
      throw new Error("Too many writes in one mutation");
    };
    vi.spyOn(console, "error").mockImplementation(() => {
      // The runner reports the failure; the test only checks what Convex hears.
    });
    end(run, { text: "done", type: "final" });
    await turn;
    const failures = s.named("runner:fail");
    expect(failures).toHaveLength(1);
    expect(String(failures[0]?.error)).toMatch(/could not save its result/u);
    expect(failures[0]?.interrupted).toBeUndefined();
  });

  it("a failed turn revokes its room tools token", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    expect(s.roomTools.live.size).toBe(1);
    end(run, { message: "Model overloaded", retryable: true, type: "error" });
    await turn;
    expect(s.named("runner:fail")[0]?.error).toBe("Model overloaded");
    expect(s.roomTools.live.size).toBe(0);
  });

  it("a cancelled turn revokes its room tools token", async () => {
    const s = setup({
      "c-stop": {
        commandId: "c-stop",
        payload: { reason: "Stopped by Robert" },
        turn: { id: "t1" },
        type: "interrupt",
      },
    });
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    expect(s.roomTools.live.size).toBe(1);
    await s.turns.handle("c-stop");
    await turn;
    expect(s.named("runner:fail")[0]?.interrupted).toBeTruthy();
    expect(s.roomTools.live.size).toBe(0);
  });

  it("an adapter that throws still has its room tools token revoked", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    expect(s.roomTools.live.size).toBe(1);
    run.crash = new Error("claude exited with code 1");
    run.events.end();
    await turn;
    expect(s.named("runner:fail")[0]?.error).toBe("claude exited with code 1");
    expect(s.roomTools.live.size).toBe(0);
  });

  it("an independent review gets no room tools token", async () => {
    const review = {
      ...runJob("t-review"),
      commandId: "c-review",
      turn: { id: "t-review", independentReview: true, prompt: "Review" },
    };
    const s = setup({ "c-review": review });
    const turn = s.turns.handle("c-review");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    expect(run.req.roomTools).toBeUndefined();
    expect(s.roomTools.issued).toHaveLength(0);
    end(run, { text: "Looks fine", type: "final" });
    await turn;
  });

  it("the room tools token never reaches Convex, the transcript or the logs", async () => {
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
    const logged: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    assert(run);
    const toolEvents: HarnessEvent[] = [
      {
        id: "call-1",
        name: "mcp__atelier__add_block",
        summary: "add_block paragraph",
        type: "tool_call",
      },
      { id: "call-1", ok: true, type: "tool_result" },
    ];
    for (const event of toolEvents) {
      run.events.push(event);
    }
    await idle();
    vi.advanceTimersByTime(500);
    await until(() => s.named("runner:recordTurnItems").length > 0);
    end(run, { text: "done", type: "final" });
    await turn;
    const [issued] = s.roomTools.issued;
    assert(issued);
    expect(logged.length).toBeGreaterThan(0);
    for (const where of [s.calls, s.transcript, logged]) {
      expect(JSON.stringify(where)).not.toContain(issued.token);
    }
  });

  describe("a scribe turn", () => {
    it("starts fresh with edits off and the scribe tools, and no write tool beside the draft", async () => {
      const { run, s, turn } = await startScribe();
      expect({
        ask: s.roomTools.issued[0]?.ask,
        editsEnabled: run.req.editsEnabled,
        resumeSessionId: run.req.resumeSessionId,
        scribe: run.req.scribe,
        tools: s.roomTools.issued[0]?.tools === scribeTools,
      }).toStrictEqual({
        ask: undefined,
        editsEnabled: false,
        resumeSessionId: undefined,
        scribe: true,
        tools: true,
      });
      expect(scribeTools.map((t) => t.name)).toStrictEqual([
        "read_document",
        "draft_keep",
        "draft_replace",
        "draft_add",
        "draft_remove",
        "draft_move",
      ]);
      expect(
        scribeTools.some(
          (t) => documentTools.includes(t) && t.name !== "read_document"
        )
      ).toBeFalsy();
      end(run, { text: "Tidied", type: "final" });
      await turn;
    });

    it("raises no question cards and never saves a session", async () => {
      const { run, s, turn } = await startScribe();
      await expect(run.input.onQuestion(card)).rejects.toThrow(
        /without asking questions/u
      );
      end(
        run,
        { sessionId: "scribe-session", type: "session" },
        { text: "Tidied", type: "final" }
      );
      await turn;
      const [finished] = s.named("runner:finish");
      expect({
        finishedSession: finished?.sessionId,
        hands: s.named("runner:raiseHand"),
        savedSessions: s.named("runner:sessionStarted"),
        transcriptHoldsOrdinarySession: JSON.stringify(s.transcript).includes(
          "ordinary-session"
        ),
      }).toStrictEqual({
        finishedSession: undefined,
        hands: [],
        savedSessions: [],
        transcriptHoldsOrdinarySession: false,
      });
    });
  });

  it("an ordinary turn and a follow-up get the ordinary tools and a way to ask the room", async () => {
    const followUp = {
      ...runJob("t-follow"),
      commandId: "c-follow",
      turn: {
        followUp: true,
        id: "t-follow",
        independentReview: false,
        prompt: "About the review",
      },
    };
    const s = setup({ "c-follow": followUp });
    for (const [n, commandId] of ["c-run", "c-follow"].entries()) {
      const turn = s.turns.handle(commandId);
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time, as the runner runs one agent's turns
      await until(() => s.runs.length > n);
      const run = s.runs.at(-1);
      assert(run);
      expect(run.req.scribe).toBeUndefined();
      end(run, { text: "done", type: "final" });
      // oxlint-disable-next-line no-await-in-loop -- see above
      await turn;
    }
    expect(
      s.roomTools.issued.map((i) => ({
        ask: typeof i.ask,
        tools: i.tools,
        turnId: i.turnId,
      }))
    ).toStrictEqual([
      { ask: "function", tools: undefined, turnId: "t1" },
      { ask: "function", tools: undefined, turnId: "t-follow" },
    ]);
  });

  it("raise_hand through the issued channel raises the card, pauses the deadline, and returns the answer", async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const payload = {
      answeredBy: "Robert",
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
    const ask = s.roomTools.issued[0]?.ask;
    assert(run && ask);
    const answer = ask(card, new AbortController().signal);
    await until(() => s.named("runner:raiseHand").length > 0);
    vi.advanceTimersByTime(45 * MINUTE);
    expect(run.signal.aborted).toBeFalsy();
    await s.turns.handle("c-answer");
    await expect(answer).resolves.toStrictEqual(payload);
    end(run, { text: "done", type: "final" });
    await turn;
  });

  it("a raise_hand whose caller hung up before its card was raised withdraws the card at once", async () => {
    const s = setup();
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    const ask = s.roomTools.issued[0]?.ask;
    assert(run && ask);
    const answer = ask(card, AbortSignal.abort());
    await expect(answer).rejects.toThrow(/stopped waiting/u);
    await until(() => s.named("runner:handWithdrawn").length > 0);
    expect(s.named("runner:handWithdrawn")).toStrictEqual([
      { handId: "hand-1", secret: "s3cret" },
    ]);
    end(run, { text: "done", type: "final" });
    await turn;
  });

  it("a raise_hand whose caller stops waiting withdraws its card, and a later answer finds nothing waiting", async () => {
    const s = setup({
      "c-answer": {
        commandId: "c-answer",
        payload: {
          answeredBy: "Robert",
          answers: [],
          handId: "hand-1",
          requestId: "req-1",
          via: "card",
        },
        turn: { id: "t1" },
        type: "answer",
      },
    });
    const turn = s.turns.handle("c-run");
    await until(() => s.runs.length > 0);
    const [run] = s.runs;
    const ask = s.roomTools.issued[0]?.ask;
    assert(run && ask);
    const stop = new AbortController();
    const answer = ask(card, stop.signal);
    await until(() => s.named("runner:raiseHand").length > 0);
    stop.abort();
    await expect(answer).rejects.toThrow(/stopped waiting/u);
    await until(() => s.named("runner:handWithdrawn").length > 0);
    expect(s.named("runner:handWithdrawn")).toStrictEqual([
      { handId: "hand-1", secret: "s3cret" },
    ]);
    await s.turns.handle("c-answer");
    expect(s.named("runner:commandHandled")).toStrictEqual([
      {
        commandId: "c-answer",
        error: "No question is waiting for this answer",
        ok: false,
        secret: "s3cret",
      },
    ]);
    end(run, { text: "done", type: "final" });
    await turn;
  });
});
