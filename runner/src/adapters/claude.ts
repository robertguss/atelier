import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { query, type CanUseTool, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Harness, HarnessEvent, QuestionAnswer, QuestionCard, SteerOutcome } from '@atelier/shared';
import { eventQueue } from './events.ts';
import { claudeRoomToolsServer } from '../roomTools.ts';
import { loopbackCaller } from '../roomToolsServer.ts';

const run = promisify(execFile);

// The in-process document tools server is named `atelier`.
const ROOM_TOOL_PREFIX = 'mcp__atelier__';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
// Harness and repository control files. Writing one could add an allow rule,
// hook or extension that runs commands on a later turn.
const PROTECTED = new Set(['.claude', '.mcp.json', '.codex', '.pi', '.agents', '.git']);

// Drives the user's own `claude` CLI through the Agent SDK, so their login,
// skills, plugins, MCP servers and CLAUDE.md all load as usual.
export function claudeHarness(opts: { executable: string; onRaw: (turnId: string, msg: SDKMessage) => void }): Harness {
  return {
    id: 'claude',
    capabilities: { canRaiseCards: true },

    async version() {
      const { stdout } = await run(opts.executable, ['--version'], { timeout: 10_000 });
      return stdout.trim();
    },

    async *runTurn(req, signal, input): AsyncIterable<HarnessEvent> {
      // Installed before the first await, so no steer or switch change is lost.
      let editsEnabled = req.editsEnabled;
      const prompt = messageStream();
      const steers = new Map<string, (outcome: SteerOutcome) => void>();
      const settle = (uuid: string, outcome: SteerOutcome) => {
        steers.get(uuid)?.(outcome);
        steers.delete(uuid);
      };
      let accepting = !req.independentReview;
      if (!req.independentReview) {
        input.setEditsEnabled = (on) => { editsEnabled = on; };
        // Sent as typed, with priority 'next': it joins the running turn at the
        // next tool result. 'now' would end the turn instead.
        input.steer = (text) => {
          if (!accepting) return Promise.resolve('rejected');
          const uuid = randomUUID();
          return new Promise<SteerOutcome>((resolveSteer) => {
            steers.set(uuid, resolveSteer);
            prompt.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: 'next', uuid });
          });
        };
      }

      const abortController = new AbortController();
      signal.addEventListener('abort', () => abortController.abort(), { once: true });

      // Reviews never get the document tools. Elsewhere they run in-process,
      // so the route and token never reach the CLI's arguments.
      const room = req.independentReview ? undefined : req.roomTools;

      const canUseTool: CanUseTool = async (toolName, toolInput, { toolUseID }) => {
        if (toolName === 'AskUserQuestion') return await askRoom(toolInput, toolUseID, input.onQuestion);
        if (room && toolName.startsWith(ROOM_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: toolInput };
        if (EDIT_TOOLS.has(toolName)) {
          if (!editsEnabled) return deny('File edits are off in this room. Ask the room owner to turn on "agents may edit files in this folder".');
          const target = toolInput.file_path ?? toolInput.notebook_path;
          if (typeof target !== 'string' || !(await editableInFolder(req.cwd, target))) {
            return deny('Edits are allowed only inside this room\'s folder, and never to .claude, .mcp.json, .codex, .pi, .agents or .git.');
          }
          return { behavior: 'allow', updatedInput: toolInput };
        }
        return deny(`${toolName} needs approval, and this room only allows what is already approved.`);
      };

      const options: Options = req.independentReview ? {
        cwd: req.cwd,
        pathToClaudeCodeExecutable: opts.executable,
        abortController,
        includePartialMessages: true,
        // Every filesystem source, as the CLI does: user, project, local.
        settingSources: ['user', 'project', 'local'],
        skills: 'all',
        permissionMode: 'dontAsk',
        ...(req.model ? { model: req.model } : {}),
        tools: [], strictMcpConfig: true, mcpServers: {}, persistSession: false,
        settings: { disableAllHooks: true },
        hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Independent reviews cannot execute tools' } })] }] },
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'Independent reviews cannot execute tools' }),
      } : {
        cwd: req.cwd,
        pathToClaudeCodeExecutable: opts.executable,
        abortController,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        skills: 'all',
        // Pre-approved tools run; everything else asks canUseTool. Not
        // acceptEdits, which would also approve rm, mv and sed in the folder.
        permissionMode: 'default',
        canUseTool,
        ...(room ? { mcpServers: { atelier: claudeRoomToolsServer(loopbackCaller(room)) } } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
      };

      let q: Query;
      if (req.independentReview) q = query({ prompt: req.prompt, options });
      else {
        prompt.push({ type: 'user', message: { role: 'user', content: req.prompt }, parent_tool_use_id: null });
        q = query({ prompt, options });
      }
      abortController.signal.addEventListener('abort', () => prompt.close(), { once: true });

      let sawText = false;
      const finals: string[] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };
      try {
        for await (const msg of q) {
          opts.onRaw(req.turnId, msg);

          // A steer was folded into the turn, or started as the next turn.
          const m = msg as { type: string; state?: string; command_uuid?: string; user_message_uuids?: string[] };
          for (const uuid of m.user_message_uuids ?? []) settle(uuid, 'steered');
          if (m.type === 'command_lifecycle' && m.state === 'started' && m.command_uuid) settle(m.command_uuid, 'steered');

          switch (msg.type) {
            case 'system':
              if (msg.subtype === 'init') yield { type: 'session', sessionId: msg.session_id };
              break;

            case 'stream_event': {
              if (msg.parent_tool_use_id) break; // subagent output stays in the transcript
              const ev = msg.event;
              if (ev.type === 'message_start' && sawText) yield { type: 'text_delta', text: '\n\n' };
              if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
                sawText = true;
                yield { type: 'text_delta', text: ev.delta.text };
              }
              break;
            }

            case 'assistant':
              if (msg.parent_tool_use_id) break;
              for (const block of msg.message.content) {
                if (block.type === 'tool_use') {
                  yield { type: 'tool_call', id: block.id, name: block.name, summary: summarize(block.input) };
                }
              }
              break;

            case 'user': {
              const content = msg.message.content;
              if (msg.parent_tool_use_id || typeof content === 'string') break;
              for (const block of content) {
                if (block.type === 'tool_result') yield { type: 'tool_result', id: block.tool_use_id, ok: !block.is_error };
              }
              break;
            }

            case 'result':
              usage.inputTokens += msg.usage.input_tokens ?? 0;
              usage.outputTokens += msg.usage.output_tokens ?? 0;
              yield { type: 'usage', ...usage, costUsd: msg.total_cost_usd };
              if (msg.subtype === 'success' && !msg.is_error) {
                finals.push(msg.result);
                yield { type: 'final', text: finals.filter(Boolean).join('\n\n') };
              } else {
                const detail = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : msg.subtype;
                yield { type: 'error', message: `Claude turn ended with ${detail}`, retryable: false };
              }
              if (accepting) {
                // Take no more steers. One that hasn't folded is withdrawn so
                // the room can queue it again. If the CLI already started it
                // as its next turn, it counts as steered once that shows.
                accepting = false;
                for (const uuid of [...steers.keys()]) {
                  if (await withdraw(q, uuid)) settle(uuid, 'rejected');
                }
                // The query ends only once its input does.
                prompt.close();
              }
              break;
          }
        }
      } finally {
        accepting = false;
        prompt.close();
        for (const uuid of [...steers.keys()]) settle(uuid, 'rejected');
      }
    },
  };
}

// A prompt the SDK reads as a stream, so steers can follow the first message.
function messageStream() {
  const stream = eventQueue<SDKUserMessage>();
  return Object.assign(stream, { close: stream.end });
}

// Takes a pushed message back out of the CLI's queue. The SDK has this
// control request but doesn't type the method yet.
async function withdraw(q: Query, uuid: string) {
  try {
    return (await (q as Query & { cancelAsyncMessage?(uuid: string): Promise<boolean> }).cancelAsyncMessage?.(uuid)) === true;
  } catch {
    return false;
  }
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

interface AskedQuestion { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }

// Puts Claude's question prompt to the room as a card and hands back the
// first answer in the shape AskUserQuestion expects: answers keyed by
// question text, with who answered in the notes.
async function askRoom(toolInput: Record<string, unknown>, toolUseID: string, onQuestion: (card: QuestionCard) => Promise<QuestionAnswer>): Promise<PermissionResult> {
  const asked = (Array.isArray(toolInput.questions) ? toolInput.questions : []) as AskedQuestion[];
  const card: QuestionCard = {
    requestId: toolUseID,
    questions: asked.map((q, i) => ({
      id: `q${i + 1}`,
      header: q.header ?? '',
      text: q.question,
      options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: q.multiSelect === true,
      allowFreeText: true,
    })),
  };
  const answer = await onQuestion(card);
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  if ('noDecision' in answer) {
    for (const q of asked) answers[q.question] = answer.message;
  } else {
    for (const a of answer.answers) {
      const question = asked[card.questions.findIndex((q) => q.id === a.questionId)]?.question ?? a.question;
      answers[question] = [...a.labels, ...(a.freeText ? [a.freeText] : [])].join(', ');
      annotations[question] = { notes: `Answered by ${answer.answeredBy}` };
    }
  }
  return { behavior: 'allow', updatedInput: { ...toolInput, answers, ...(Object.keys(annotations).length ? { annotations } : {}) } };
}

// True if the path, with symlinks resolved, is inside cwd and not under a
// harness or repository control path.
async function editableInFolder(cwd: string, target: string) {
  try {
    const root = await realpath(cwd);
    const rel = relative(root, await resolveReal(resolve(cwd, target)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    return !rel.split(sep).some((part) => PROTECTED.has(part));
  } catch {
    return false;
  }
}

// realpath for a file that may not exist yet: resolves through its nearest
// existing parent, and follows a symlink whose target is missing.
async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let link: string | undefined;
  try { link = await readlink(path); } catch { /* not a symlink, or missing */ }
  if (link !== undefined) return resolveReal(resolve(dirname(path), link));
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(await resolveReal(parent), basename(path));
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.url ?? o.query;
  return typeof pick === 'string' ? pick.slice(0, 200) : '';
}
