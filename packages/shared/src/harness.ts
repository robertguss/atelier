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
  /** True for independent review: no edits, no side effects. */
  readOnly: boolean;
  /** Sealed independent review: fresh session, supplied snapshot, no execution tools. */
  independentReview?: boolean;
  /** Always includes the Atelier MCP server. */
  mcpServers: McpServerSpec[];
}

export type HarnessEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string; retryable: boolean };

export interface Harness {
  id: HarnessId;
  version(): Promise<string>;
  runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<HarnessEvent>;
}
