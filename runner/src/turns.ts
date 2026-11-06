// See docs/v0-spec.md, "Runner ↔ Convex protocol".

import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import type {
  Harness,
  HarnessId,
  QuestionAnswer,
  QuestionCard,
  SteerOutcome,
  TurnInput,
} from "@atelier/shared";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { turnInput } from "./adapters/events.ts";
import { reviewSnapshot } from "./review.ts";

const PROGRESS_MS = 500;
const TURN_DEADLINE_MS = 30 * 60_000;
const CARD_ANSWER_TIMEOUT_MS = 2 * 60 * 60_000;

export type TurnsClient = Pick<ConvexClient, "mutation">;

export interface TurnsOptions {
  client: TurnsClient;
  secret: string;
  harnesses: Partial<Record<HarnessId, Harness>>;
  appendTranscript(turnId: string, record: unknown): void;
  transcriptPath(turnId: string): string;
  /** Used when a participant has no model of its own. */
  defaultModels?: Partial<Record<HarnessId, string>>;
}

interface RunningTurn {
  abort: AbortController;
  input: TurnInput;
  /** Why a person or Convex stopped the turn, if one did. */
  stopReason?: string;
  /** Resolves the harness's pending question. False if none matches. */
  answer(payload: QuestionAnswer): boolean;
}

type Claimed = NonNullable<FunctionReturnType<typeof api.runner.claim>>;
type RunJob = Extract<Claimed, { type: "run_turn" }>;
type ControlJob = Exclude<Claimed, { type: "run_turn" }>;

interface ToolItem {
  callId: string;
  seq: number;
  name: string;
  summary: string;
  ok?: boolean;
}

export function createTurns({
  client,
  secret,
  harnesses,
  appendTranscript,
  transcriptPath,
  defaultModels = {},
}: TurnsOptions) {
  const running = new Map<string, RunningTurn>();

  async function handle(commandId: string) {
    const job = await client.mutation(api.runner.claim, {
      commandId: commandId as Id<"commands">,
      secret,
    });
    if (!job) {
      return;
    }
    if (job.type === "run_turn") {
      await runTurn(job);
    } else {
      await control(job);
    }
  }

  async function control(job: ControlJob) {
    const turn = running.get(job.turn.id);
    const payload = job.payload ?? {};
    const handled = async (ok: boolean, error?: string) =>
      client.mutation(api.runner.commandHandled, {
        commandId: job.commandId,
        ok,
        secret,
        ...(error ? { error } : {}),
      });

    if (!turn) {
      if (job.type === "steer") {
        await client.mutation(api.runner.steerResult, {
          secret,
          messageId: payload.messageId,
          outcome: "rejected",
        });
      }
      await handled(false, "Turn is not running on the runner");
      return;
    }
    switch (job.type) {
      case "interrupt": {
        turn.stopReason = payload.reason;
        turn.abort.abort();
        return await handled(true);
      }
      case "steer": {
        let outcome: SteerOutcome;
        try {
          outcome = await turn.input.steer(String(payload.text));
        } catch (error) {
          console.error(`steer into turn ${job.turn.id} failed:`, error);
          outcome = "rejected";
        }
        await client.mutation(api.runner.steerResult, {
          messageId: payload.messageId,
          outcome,
          secret,
        });
        return await handled(true);
      }
      case "answer": {
        return turn.answer(payload)
          ? await handled(true)
          : await handled(false, "No question is waiting for this answer");
      }
      case "settings": {
        turn.input.setEditsEnabled(payload.editsEnabled === true);
        return await handled(true);
      }
      default: {
        return await handled(false, `Unknown command ${job.type}`);
      }
    }
  }

  async function runTurn(job: RunJob) {
    const turnId = job.turn.id;
    const { commandId } = job;
    const harness = harnesses[job.participant.harness];
    const transcriptRef = transcriptPath(turnId);

    if (!harness) {
      await client.mutation(api.runner.fail, {
        commandId,
        error: `The ${job.participant.harness} adapter isn't built yet`,
        secret,
        turnId,
      });
      return;
    }

    const effectiveModel = job.participant.model ?? defaultModels[harness.id];
    const abort = new AbortController();
    let ended = false;
    // The deadline stops counting while the agent waits on a card.
    const deadline = pausableTimer(TURN_DEADLINE_MS, () => {
      abort.abort();
    });

    const questions = new Map<
      string,
      {
        resolve(answer: QuestionAnswer): void;
        reject(error: Error): void;
        ceiling?: ReturnType<typeof setTimeout>;
      }
    >();
    const settle = (requestId: string) => {
      const question = questions.get(requestId);
      if (!question) {
        return undefined;
      }
      clearTimeout(question.ceiling);
      questions.delete(requestId);
      if (!questions.size && !ended) {
        deadline.resume();
      }
      return question;
    };
    const onQuestion = async (card: QuestionCard) => {
      const answer = new Promise<QuestionAnswer>((resolve, reject) =>
        questions.set(card.requestId, { reject, resolve })
      );
      deadline.pause();
      try {
        const handId = await client.mutation(api.runner.raiseHand, {
          questions: card.questions,
          requestId: card.requestId,
          secret,
          turnId,
        });
        const question = questions.get(card.requestId);
        if (question) {
          question.ceiling = setTimeout(() => {
            client
              .mutation(api.runner.handTimedOut, { handId, secret })
              .catch((error_) => {
                console.error("card timeout failed:", error_);
              });
          }, CARD_ANSWER_TIMEOUT_MS);
        }
      } catch (error_) {
        settle(card.requestId);
        throw error_;
      }
      return await answer;
    };

    const turn: RunningTurn = {
      abort,
      answer(payload) {
        const question = settle(payload.requestId);
        question?.resolve(payload);
        return !!question;
      },
      input: turnInput(onQuestion),
    };
    running.set(turnId, turn);

    let text = "";
    let finalText: string | null = null;
    let error: string | null = null;
    let { sessionId } = job.participant;
    let savedSessionId: string | undefined;
    let usage:
      | { inputTokens: number; outputTokens: number; costUsd?: number }
      | undefined;

    // Tool activity goes to Convex as one-line items. Raw output stays in the
    // transcript on this machine.
    const items = new Map<string, ToolItem>();
    const changed = new Set<string>();
    const flushItems = async () => {
      if (!changed.size) {
        return;
      }
      const ids = [...changed];
      changed.clear();
      try {
        await client.mutation(api.runner.recordTurnItems, {
          items: ids.map((id) => ({ ...items.get(id)! })),
          secret,
          turnId,
        });
      } catch (error_) {
        for (const id of ids) changed.add(id);
        throw error_;
      }
    };
    // Also renews the lease, including while the agent waits on a card.
    const flush = async () => {
      const active = await client.mutation(api.runner.progress, {
        commandId,
        partialText: text,
        secret,
        turnId,
      });
      if (!active) {
        abort.abort();
      }
      await flushItems();
    };
    let timer: ReturnType<typeof setInterval> | undefined;

    try {
      const started = await client.mutation(api.runner.start, {
        harnessVersion: await harness.version(),
        secret,
        turnId,
      });
      // Start polling only after start commits: a queued turn is not cancelled.
      timer = setInterval(
        async () =>
          flush().catch((error_) => {
            console.error("progress failed:", error_);
          }),
        PROGRESS_MS
      );
      console.log(`turn ${turnId}: ${harness.id} in ${job.room.cwd}`);
      appendTranscript(turnId, {
        atelier: "request",
        cwd: job.room.cwd,
        prompt: job.turn.prompt,
        resume: sessionId,
      });

      for await (const ev of harness.runTurn(
        {
          cwd: job.room.cwd,
          editsEnabled:
            !job.turn.independentReview && started?.editsEnabled === true,
          independentReview: job.turn.independentReview,
          mcpServers: [],
          model: effectiveModel,
          prompt:
            job.turn.prompt +
            (job.turn.ritualId
              ? await client.mutation(api.runner.prepareReview, {
                  secret,
                  ritualId: job.turn.ritualId,
                  snapshot: await reviewSnapshot(job.room.cwd),
                })
              : ""),
          reasoning: parseReasoning(job.participant.reasoning),
          resumeSessionId: sessionId,
          turnId,
        },
        abort.signal,
        turn.input
      )) {
        if (ev.type === "session") {
          sessionId = ev.sessionId;
          if (sessionId !== savedSessionId) {
            savedSessionId = sessionId;
            // Saved now, so a turn interrupted mid-question can still be resumed.
            await client
              .mutation(api.runner.sessionStarted, {
                secret,
                sessionId,
                turnId,
              })
              .catch((error_) => {
                console.error("saving session failed:", error_);
              });
          }
        } else if (ev.type === "text_delta") {
          text += ev.text;
        } else if (ev.type === "tool_call") {
          if (!items.has(ev.id)) {
            items.set(ev.id, {
              callId: ev.id,
              seq: items.size,
              name: ev.name,
              summary: ev.summary,
            });
          }
          changed.add(ev.id);
        } else if (ev.type === "tool_result") {
          const item = items.get(ev.id);
          if (item) {
            item.ok = ev.ok;
            changed.add(ev.id);
          }
        } else if (ev.type === "usage") {
          usage = {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            costUsd: ev.costUsd,
          };
        } else if (ev.type === "final") {
          finalText = ev.text;
        } else if (ev.type === "error") {
          error = ev.message;
        }
      }
    } catch (error_) {
      error = abort.signal.aborted
        ? "Interrupted"
        : error_ instanceof Error
          ? error_.message
          : String(error_);
    } finally {
      ended = true;
      clearInterval(timer);
      deadline.clear();
      for (const requestId of [...questions.keys()]) {
        settle(requestId)?.reject(new Error("The turn ended"));
      }
      running.delete(turnId);
    }
    if (abort.signal.aborted && turn.stopReason) {
      error = turn.stopReason;
    }
    await flushItems().catch((error_) => {
      console.error("saving tool activity failed:", error_);
    });

    if (finalText !== null && !error) {
      await client.mutation(api.runner.finish, {
        commandId,
        finalText: finalText || text,
        model: effectiveModel,
        secret,
        sessionId,
        transcriptRef,
        turnId,
        usage,
      });
      console.log(
        `turn ${turnId}: done${usage?.costUsd ? ` ($${usage.costUsd.toFixed(4)})` : ""}`
      );
    } else {
      await client.mutation(api.runner.fail, {
        commandId,
        error: error ?? "Turn ended without a result",
        interrupted: abort.signal.aborted,
        secret,
        transcriptRef,
        turnId,
      });
      console.error(`turn ${turnId}: ${error}`);
    }
  }

  return {
    /** Stops every turn running here, for shutdown. */
    abortAll() {
      for (const turn of running.values()) turn.abort.abort();
    },
    handle,
  };
}

// A timeout that can stop counting and later go on with the time it had left.
function pausableTimer(ms: number, fire: () => void) {
  let left = ms;
  let since = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, ms);
  return {
    clear() {
      clearTimeout(timer);
      timer = undefined;
    },
    pause() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      left -= Date.now() - since;
    },
    resume() {
      if (timer) return;
      since = Date.now();
      timer = setTimeout(fire, Math.max(0, left));
    },
  };
}

function parseReasoning(value: string | undefined) {
  if (
    value === undefined ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(`Unsupported reasoning level: ${value}`);
}
