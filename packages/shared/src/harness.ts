// The contract between the runner and each harness adapter.
// Adapters keep raw harness events in the turn's transcript file and yield
// these normalized events.

export const HARNESS_IDS = ['claude', 'codex', 'pi'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh';

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface TurnRequest {
  turnId: string;
  cwd: string;
  /** Includes the generated room context block. */
  prompt: string;
  model?: string;
  reasoning?: Reasoning;
  /** The participant's harness session id, to continue its conversation. */
  resumeSessionId?: string;
  /**
   * The room's "agents may edit files in this folder" switch when the turn
   * started. Changes during the turn arrive through `TurnInput.setEditsEnabled`.
   */
  editsEnabled: boolean;
  /** Sealed independent review: fresh session, supplied snapshot, no execution tools. */
  independentReview?: boolean;
  /** Always includes the Atelier MCP server. */
  mcpServers: McpServerSpec[];
}

/** One question the agent asked through its harness's own question prompt. */
export interface CardQuestion {
  /** The harness's question id, or any id unique on the card. */
  id: string;
  header: string;
  text: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowFreeText: boolean;
}

/** One to four questions, answered together. */
export interface QuestionCard {
  /** The harness's id for the pending request. */
  requestId: string;
  questions: CardQuestion[];
}

/**
 * The first answer to a card, or word that no decision was made because no
 * one answered in time.
 */
export type QuestionAnswer =
  | {
      handId: string;
      requestId: string;
      answeredBy: string;
      via: 'card' | 'chat';
      answers: { questionId: string; question: string; labels: string[]; freeText?: string }[];
    }
  | { handId: string; requestId: string; noDecision: true; message: string };

export type SteerOutcome = 'steered' | 'rejected';

/**
 * The live channel into a running turn. The runner creates one per turn.
 *
 * The runner implements `onQuestion`: the adapter calls it when the agent asks
 * a question, and it resolves with the answer.
 *
 * The adapter replaces `steer` and `setEditsEnabled` with its own as soon as
 * its turn can take them, before its first `await`, so no change made after
 * `TurnRequest.editsEnabled` was read is lost. Until then, a steer is
 * rejected and a settings change waits for the next turn.
 */
export interface TurnInput {
  onQuestion(card: QuestionCard): Promise<QuestionAnswer>;
  /** Puts a person's message into the running turn without stopping it. */
  steer: (text: string) => Promise<SteerOutcome>;
  setEditsEnabled: (on: boolean) => void;
}

export type HarnessEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; text: string }
  /** `id` pairs a call with its result. `summary` is one line, never raw output. */
  | { type: 'tool_call'; id: string; name: string; summary: string }
  | { type: 'tool_result'; id: string; ok: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string; retryable: boolean };

export interface HarnessCapabilities {
  /** Whether the agent's own question prompt reaches the room as a card. */
  canRaiseCards: boolean;
}

export interface Harness {
  id: HarnessId;
  capabilities: HarnessCapabilities;
  version(): Promise<string>;
  runTurn(req: TurnRequest, signal: AbortSignal, input: TurnInput): AsyncIterable<HarnessEvent>;
}
