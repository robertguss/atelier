// See docs/v0-spec.md, "Runner ↔ Convex protocol".

import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import type {
  Harness,
  HarnessEvent,
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
import type { RoomToolsRoute, RoomToolsServer } from "./room-tools-server.ts";
import { scribeTools } from "./room-tools.ts";

const PROGRESS_MS = 500;
const TURN_DEADLINE_MS = 30 * 60_000;
const CARD_ANSWER_TIMEOUT_MS = 2 * 60 * 60_000;

export type TurnsClient = Pick<ConvexClient, "mutation">;

export interface TurnsOptions {
  client: TurnsClient;
  secret: string;
  harnesses: Partial<Record<HarnessId, Harness>>;
  /** Issues each turn but a review a token for its room document tools. */
  roomTools: Pick<RoomToolsServer, "issue" | "revoke">;
  appendTranscript: (turnId: string, record: unknown) => void;
  transcriptPath: (turnId: string) => string;
  /** Used when a participant has no model of its own. */
  defaultModels?: Partial<Record<HarnessId, string>>;
}

interface RunningTurn {
  abort: AbortController;
  input: TurnInput;
  /** Why a person or Convex stopped the turn, if one did. */
  stopReason?: string;
  /** Resolves the harness's pending question. False if none matches. */
  answer: (payload: QuestionAnswer) => boolean;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// A client can only check an id's shape; Convex checks its table.
const isCommandId = (value: unknown): value is Id<"commands"> =>
  typeof value === "string";
const isMessageId = (value: unknown): value is Id<"messages"> =>
  typeof value === "string";

const isCardAnswer = (value: unknown) =>
  isRecord(value) &&
  typeof value.questionId === "string" &&
  typeof value.question === "string" &&
  isStringArray(value.labels) &&
  (value.freeText === undefined || typeof value.freeText === "string");

// The answer payload Convex builds for a card.
const isQuestionAnswer = (value: unknown): value is QuestionAnswer => {
  if (
    !isRecord(value) ||
    typeof value.handId !== "string" ||
    typeof value.requestId !== "string"
  ) {
    return false;
  }
  if (value.noDecision === true) {
    return typeof value.message === "string";
  }
  return (
    typeof value.answeredBy === "string" &&
    (value.via === "card" || value.via === "chat") &&
    Array.isArray(value.answers) &&
    value.answers.every(isCardAnswer)
  );
};

// A timeout that can stop counting and later go on with the time it had left.
const pausableTimer = (ms: number, fire: () => void) => {
  let left = ms;
  let since = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, ms);
  return {
    clear() {
      clearTimeout(timer);
      timer = undefined;
    },
    pause() {
      if (timer === undefined) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      left -= Date.now() - since;
    },
    resume() {
      if (timer !== undefined) {
        return;
      }
      since = Date.now();
      timer = setTimeout(fire, Math.max(0, left));
    },
  };
};

const parseReasoning = (value: string | undefined) => {
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
};

// What a harness is told about the room document for this turn.
const roomTurnOptions = (
  scribe: boolean,
  route: RoomToolsRoute | undefined
) => ({
  ...(scribe ? { scribe: true } : {}),
  ...(route ? { roomTools: route } : {}),
});

export const createTurns = ({
  client,
  secret,
  harnesses,
  roomTools,
  appendTranscript,
  transcriptPath,
  defaultModels = {},
}: TurnsOptions) => {
  const running = new Map<string, RunningTurn>();

  const control = async (job: ControlJob) => {
    const turn = running.get(job.turn.id);
    const payload: Record<string, unknown> = isRecord(job.payload)
      ? job.payload
      : {};
    const messageId = () => {
      if (!isMessageId(payload.messageId)) {
        throw new Error("A steer command needs a messageId");
      }
      return payload.messageId;
    };
    const handled = async (ok: boolean, error?: string) => {
      await client.mutation(api.runner.commandHandled, {
        commandId: job.commandId,
        ok,
        secret,
        ...(error === undefined ? {} : { error }),
      });
    };

    if (!turn) {
      if (job.type === "steer") {
        await client.mutation(api.runner.steerResult, {
          messageId: messageId(),
          outcome: "rejected",
          secret,
        });
      }
      await handled(false, "Turn is not running on the runner");
      return;
    }
    switch (job.type) {
      case "interrupt": {
        turn.stopReason =
          typeof payload.reason === "string" ? payload.reason : undefined;
        turn.abort.abort();
        await handled(true);
        break;
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
          messageId: messageId(),
          outcome,
          secret,
        });
        await handled(true);
        break;
      }
      case "answer": {
        await (isQuestionAnswer(payload) && turn.answer(payload)
          ? handled(true)
          : handled(false, "No question is waiting for this answer"));
        break;
      }
      case "settings": {
        turn.input.setEditsEnabled(payload.editsEnabled === true);
        await handled(true);
        break;
      }
      default: {
        await handled(false, `Unknown command ${String(job.type)}`);
      }
    }
  };

  const runTurn = async (job: RunJob) => {
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
    // A scribe turn, like a review, starts a fresh session and never saves
    // it, so the scribe's instructions never reach the participant's
    // ordinary session. It edits no files and asks no questions.
    const scribe = job.documentMode === "scribe";
    const abort = new AbortController();
    let ended = false;
    // The deadline stops counting while the agent waits on a card.
    const deadline = pausableTimer(TURN_DEADLINE_MS, () => {
      abort.abort();
    });

    const questions = new Map<
      string,
      {
        resolve: (answer: QuestionAnswer) => void;
        reject: (error: Error) => void;
        ceiling?: ReturnType<typeof setTimeout>;
      }
    >();
    const settle = (requestId: string) => {
      const question = questions.get(requestId);
      if (question !== undefined) {
        clearTimeout(question.ceiling);
        questions.delete(requestId);
        if (!questions.size && !ended) {
          deadline.resume();
        }
      }
      return question;
    };
    const onQuestion = async (card: QuestionCard) => {
      if (scribe) {
        throw new Error(
          "The scribe works without asking questions: decide, and note open questions in the document."
        );
      }
      // oxlint-disable-next-line promise/avoid-new -- the answer arrives later through a separate Convex command, which settles this promise from outside
      const answer = new Promise<QuestionAnswer>((resolve, reject) => {
        questions.set(card.requestId, { reject, resolve });
      });
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
              .catch((timeoutError: unknown) => {
                console.error("card timeout failed:", timeoutError);
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
    let sessionId = scribe ? undefined : job.participant.sessionId;
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
          items: ids.flatMap((id) => {
            const item = items.get(id);
            return item === undefined ? [] : [{ ...item }];
          }),
          secret,
          turnId,
        });
      } catch (error_) {
        for (const id of ids) {
          changed.add(id);
        }
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
    // Reviews never see the room document. The token is a secret: it goes to
    // the adapter only, never into logs, transcripts or turn items.
    let route: RoomToolsRoute | undefined;

    // An independent review's prompt carries the repository snapshot.
    const reviewEvidence = async () => {
      const { ritualId } = job.turn;
      if (ritualId === undefined) {
        return "";
      }
      return await client.mutation(api.runner.prepareReview, {
        ritualId,
        secret,
        snapshot: await reviewSnapshot(job.room.cwd),
      });
    };
    const record = async (ev: HarnessEvent) => {
      switch (ev.type) {
        case "session": {
          if (scribe) {
            break;
          }
          ({ sessionId } = ev);
          if (sessionId !== savedSessionId) {
            savedSessionId = sessionId;
            // Saved now, so a turn interrupted mid-question can still be resumed.
            await client
              .mutation(api.runner.sessionStarted, {
                secret,
                sessionId,
                turnId,
              })
              .catch((sessionError: unknown) => {
                console.error("saving session failed:", sessionError);
              });
          }
          break;
        }
        case "text_delta": {
          text += ev.text;
          break;
        }
        case "tool_call": {
          if (!items.has(ev.id)) {
            items.set(ev.id, {
              callId: ev.id,
              name: ev.name,
              seq: items.size,
              summary: ev.summary,
            });
          }
          changed.add(ev.id);
          break;
        }
        case "tool_result": {
          const item = items.get(ev.id);
          if (item) {
            item.ok = ev.ok;
            changed.add(ev.id);
          }
          break;
        }
        case "usage": {
          usage = {
            costUsd: ev.costUsd,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
          };
          break;
        }
        case "final": {
          finalText = ev.text;
          break;
        }
        case "error": {
          error = ev.message;
          break;
        }
        default: {
          break;
        }
      }
    };

    // Tells Convex how the turn ended.
    const report = async () => {
      if (finalText !== null && (error === null || error === "")) {
        try {
          await client.mutation(api.runner.finish, {
            commandId,
            finalText: finalText === "" ? text : finalText,
            model: effectiveModel,
            secret,
            sessionId,
            transcriptRef,
            turnId,
            usage,
          });
        } catch (finishError) {
          // Convex saved nothing (a mutation is all-or-nothing), so the turn is still open and a scribe
          // run still holds the document lock. Fail the turn now rather than wait for its lease to lapse;
          // if the finish did commit and only the reply was lost, `fail` finds the turn ended and does nothing.
          console.error(
            `turn ${turnId}: saving the result failed:`,
            finishError
          );
          await client.mutation(api.runner.fail, {
            commandId,
            error: "The turn finished, but Atelier could not save its result",
            secret,
            transcriptRef,
            turnId,
          });
          return;
        }
        const cost = usage?.costUsd;
        console.log(
          `turn ${turnId}: done${cost === undefined || cost === 0 ? "" : ` ($${cost.toFixed(4)})`}`
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
    };

    try {
      const started = await client.mutation(api.runner.start, {
        harnessVersion: await harness.version(),
        secret,
        turnId,
      });
      if (!job.turn.independentReview) {
        route = await roomTools.issue(turnId, scribe ? scribeTools : undefined);
      }
      // Start polling only after start commits: a queued turn is not cancelled.
      timer = setInterval(() => {
        flush().catch((progressError: unknown) => {
          console.error("progress failed:", progressError);
        });
      }, PROGRESS_MS);
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
            !job.turn.independentReview &&
            !scribe &&
            started?.editsEnabled === true,
          independentReview: job.turn.independentReview,
          mcpServers: [],
          model: effectiveModel,
          prompt: job.turn.prompt + (await reviewEvidence()),
          reasoning: parseReasoning(job.participant.reasoning),
          resumeSessionId: sessionId,
          ...roomTurnOptions(scribe, route),
          turnId,
        },
        abort.signal,
        turn.input
      )) {
        await record(ev);
      }
    } catch (error_) {
      if (abort.signal.aborted) {
        error = "Interrupted";
      } else {
        error = error_ instanceof Error ? error_.message : String(error_);
      }
    } finally {
      ended = true;
      if (route) {
        roomTools.revoke(route.token);
      }
      clearInterval(timer);
      deadline.clear();
      for (const requestId of questions.keys()) {
        settle(requestId)?.reject(new Error("The turn ended"));
      }
      running.delete(turnId);
    }
    if (
      abort.signal.aborted &&
      turn.stopReason !== undefined &&
      turn.stopReason !== ""
    ) {
      error = turn.stopReason;
    }
    await flushItems().catch((activityError: unknown) => {
      console.error("saving tool activity failed:", activityError);
    });

    await report();
  };

  const handle = async (commandId: string) => {
    if (!isCommandId(commandId)) {
      throw new Error("Command ids are strings");
    }
    const job = await client.mutation(api.runner.claim, {
      commandId,
      secret,
    });
    if (!job) {
      return;
    }
    await (job.type === "run_turn" ? runTurn(job) : control(job));
  };

  return {
    /** Stops every turn running here, for shutdown. */
    abortAll() {
      for (const turn of running.values()) {
        turn.abort.abort();
      }
    },
    handle,
  };
};
