# Atelier v0 spec

Status: draft, 2026-11-06. Written from the brainstorm that led to Atelier.

Product update: reviews now finish when answers are revealed. The owner rejected
mandatory crux/decision entry. Follow-up with any participant is available directly;
saving a takeaway is optional. Older crux/decision records remain readable. This
supersedes the required crux/decision steps below.

Shared rooms update: Robert can invite a teammate into a room, and both work
with the same agents from a web app. The agents queue and take steers, ask
question cards, and may edit the room folder when Robert turns that on. The
data model, commands, ledger types and protocol below include these changes.
How to set up and use shared rooms is in [shared-rooms.md](shared-rooms.md).

## What Atelier is

Atelier is a team room where a human and AI models work together on a project.
Most agent tools are built on **command and execute**: a person gives one agent
a task. Atelier is built on **collaborate and compound**. Several models from
different providers work in the same room with shared context. The human is the
hub. Every collaboration is recorded in a ledger, so the platform, the models
and the human all improve over time.

v0 is the smallest version that can be used every day and that records the
right data from its first commit.

## v0 goal

One room on one real project, with three participants (Robert, Claude Code and
Codex; Pi is the third harness in the adapter set), one ritual (independent
review), a ledger, and an iPhone app.

**Milestone: building Atelier inside Atelier.** v0 is done when a room for
Atelier's own repo exists and Atelier's development happens there. From then on,
any friction is logged as a backlog item in that room.

### Success criteria

- From the iPhone, Robert can post a request to a room and get independent
  answers from Claude and Codex. Neither model sees the other's answer before
  writing its own.
- Robert can record a crux and a decision from the phone, and both become
  ledger entries.
- A push notification arrives when every answer in a ritual is in, or when an
  agent raises its hand.
- Turns keep running when the phone app is closed, and when the runner restarts
  between turns.
- Each harness loads the user's own skills, plugins, MCP servers and
  instructions, because Atelier drives the official harness rather than a copy.

## Non-goals for v0

- Orbs or fresh VMs per thread. Runners run on existing machines.
- Peer mode. Models do not talk to each other without Robert.
- Automatic crux extraction. Robert writes cruxes by hand; those become the
  test set for automating it later.
- Scoring, model profiles, routing, quota scheduling, the mirror and retros.
  They need weeks of ledger data first.
- A diff viewer and a Mac client. (Multiple users and a web client were
  non-goals for v0. Shared rooms added both.)
- Writing in parallel. v0 reviews are read-only, so participants can share the
  room's directory.
- Elara or any harness not listed below.

## Architecture

```
 Web app (Vite, Vercel) ─┐
 iPhone / iPad (Expo) ───┴ Clerk auth ── live queries + mutations ──▶ CONVEX
                                                                  • rooms, participants, handbook
                                                                  • rituals as durable workflows
                                                                  • ledger (semantic events)
                                                                  • commands queue ◀──┐
                                                                  • push → Expo push   │ subscribe
                                                                                       │ (outbound only)
 exe.dev VM ── RUNNER (TypeScript, Node 24, systemd) ─────────────────────────────────┘
                • claims commands, runs turns, streams results back
                • adapters: Claude Agent SDK · codex app-server · Pi RpcClient
                • raw transcripts on local disk
                • Atelier MCP server for the harnesses
```

### The brain is in Convex and the runner is thin

The runner does one job: **run turn T for participant P and stream back what
happens.** Ritual logic, visibility rules and the ledger all live in Convex, so:

- a runner restart never loses track of a ritual, because ritual state lives in
  durable workflows;
- **blind until reveal** is enforced in the query, so it doesn't depend on
  agents behaving;
- adding a second runner (the MacBook, another VM) needs no new logic;
- the runner only connects outbound, so the VM exposes no ports.

### The ledger and the transcript are different things

| Data                                                                                    | Lives in                        | Why                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rooms, participants, handbook, rituals, cruxes, decisions, outcomes, provenance         | Convex                          | Small, live, queried from the phone. This is what Atelier learns from                             |
| Turn summaries, final messages, in-progress text (throttled to about 2 writes a second) | Convex                          | So the phone can follow along                                                                     |
| Raw event streams, tool output, images, token deltas                                    | Runner disk, linked from Convex | Large and rarely needed. Threadbear measured about 10 GB a month of transcripts, 52% of it images |

## Stack

| Concern     | Choice                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Language    | TypeScript everywhere                                                                                                      |
| Monorepo    | pnpm workspaces and Turborepo                                                                                              |
| Backend     | Convex cloud to start. Self-hosting Convex later is a migration, not a rewrite                                             |
| Workflows   | `@convex-dev/workflow` for rituals                                                                                         |
| Auth        | Clerk (`@clerk/expo`, Core 3; `@clerk/clerk-expo` is deprecated) with Convex's Clerk integration                           |
| Mobile      | Expo with a development build (not Expo Go), EAS to reach TestFlight, Expo Router, FlashList for transcripts               |
| Web         | Vite and React static app with TanStack Router and `@clerk/react`, built on t3code's UI components (MIT), hosted on Vercel |
| Runner      | Node 24, run as a systemd service                                                                                          |
| Claude Code | `@anthropic-ai/claude-agent-sdk`                                                                                           |
| Codex       | `codex app-server` (JSON-RPC over stdio)                                                                                   |
| Pi          | `@mariozechner/pi-coding-agent` `RpcClient` (subprocess, JSONL)                                                            |

Versions checked on npm on 2026-11-06: convex 1.49.0, @convex-dev/workflow
0.4.10, @clerk/expo 4.15.1, @anthropic-ai/claude-agent-sdk 0.3.318,
@openai/codex 0.166.0, @mariozechner/pi-coding-agent 0.73.1.

## Repo layout

```
atelier/
  packages/backend/  Convex: convex/ holds schema, functions, rituals (workflows), ledger, commands, push, auth.config.ts
  packages/shared/   harness event types, normalization, constants
  runner/            service entry, command loop, adapters/{claude,codex,pi}, mcp/, transcripts/
  apps/mobile/       Expo app: iPhone and iPad
  apps/web/          Vite and React web app for shared rooms, hosted on Vercel
  docs/              this spec, the handbook, independent review, shared rooms
```

Convex lives in `packages/backend` so the apps and the runner import its
generated API like any other workspace package.

## Data model (Convex)

Domain tables hold current state. Every mutation that changes something that
matters to collaboration also adds a row to `ledger` in the same transaction.
The ledger is append-only and never edited.

| Table             | Key fields                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runners`         | `name`, `machine`, `lastHeartbeatAt`, `harnesses` (installed harnesses and versions), `harnessCapabilities` (per harness: `canRaiseCards`)                                                                                                                                                                                                                                                                                                            |
| `users`           | `tokenIdentifier` (Clerk's), `email`, `name`. One row per signed-in person                                                                                                                                                                                                                                                                                                                                                                            |
| `rooms`           | `name`, `runnerId`, `cwd`, `handbook` (markdown), `archivedAt`, `editsEnabled` (missing means off)                                                                                                                                                                                                                                                                                                                                                    |
| `roomMembers`     | `roomId`, `userId`, `role` (`owner` \| `member`), `participantId`, `noticeVersion`, `noticeAcceptedAt`, `removedAt`                                                                                                                                                                                                                                                                                                                                   |
| `roomInvites`     | `roomId`, `email`, `tokenHash` (the token itself is only in the link), `expiresAt` (7 days), `status` (`pending` \| `accepted` \| `revoked` \| `expired`), `clerkInvitationId`, `acceptedByUserId`, `acceptedAt`, `revokedAt`                                                                                                                                                                                                                         |
| `participants`    | `roomId`, `kind` (`human` \| `harness`), `harness` (`claude` \| `codex` \| `pi`), `model`, `reasoning`, `displayName`, `harnessSessionId`, `userId` (for a human)                                                                                                                                                                                                                                                                                     |
| `messages`        | `roomId`, `authorParticipantId`, `body`, `ritualId?`, `turnId?` (set on an agent's reply), `visibility` (`room` \| `sealed`), `toParticipantId`, `delivery` (`queued` \| `steering` \| `steered` \| `delivered` \| `answeredCard` \| `cancelled`), `deliveredTurnId`, `steering` (`turnId`, `commandId` while a steer is in flight), `cancelReason`, `followUpRitualId`, `followUpDecisionId`, `followUpReviewTurnId`                                 |
| `teamMessages`    | `roomId`, `authorUserId`, `authorParticipantId`, `body`. Humans only, in its own table so nothing that builds prompts can read it. Never edited or deleted                                                                                                                                                                                                                                                                                            |
| `turns`           | `roomId`, `participantId`, `ritualId?`, `status` (`queued` \| `running` \| `done` \| `failed` \| `interrupted`), `prompt`, `partialText` (older turns only; see `turnStreams`), `finalText`, `usage`, `transcriptRef`, `harnessVersion`, `error`, `startedAt`, `endedAt`, `followUp` (`ritualId`, `decisionId`, `separateSession`), `requestedByParticipantIds`, `editsEnabled` (the switch at dispatch), `waitingOnHandId`, `stoppedByParticipantId` |
| `turnStreams`     | `turnId`, `text`. A turn's streamed text, apart from the turn so streaming writes only rerun `agent.live`, the small query for active turns                                                                                                                                                                                                                                                                                                           |
| `turnItems`       | `turnId`, `callId`, `seq`, `name`, `summary` (one line), `ok`. One row per tool call; raw output stays on the runner                                                                                                                                                                                                                                                                                                                                  |
| `rituals`         | `roomId`, `type` (`independent_review`), `status` (`collecting` \| `revealed` \| `decided`), `request`, `participantIds`, `revealedAt`, `workflowId`, `snapshot`, `pushStatus`, `followUpSessions` (per participant, used in rooms with a teammate)                                                                                                                                                                                                   |
| `reviewSnapshots` | `ritualId`, `text`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `takeaways`       | `ritualId`, `body`, `authorParticipantId`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cruxes`          | `ritualId`, `roomId`, `statement`, `options`, `authorParticipantId`                                                                                                                                                                                                                                                                                                                                                                                   |
| `decisions`       | `cruxId?`, `ritualId?`, `roomId`, `choice`, `rationale`, and for an answered question card `handId`, `questionId`, `answeredByParticipantId`                                                                                                                                                                                                                                                                                                          |
| `hands`           | Question cards. `roomId`, `turnId`, `participantId`, `requestId` (the harness's id for the pending request), `questions` (one to four, each with `id`, `header`, `text`, `options`, `multiSelect`, `allowFreeText`), `status` (`raised` \| `answered` \| `cancelled` \| `expired`), `answers`, `answeredByParticipantId`, `answeredAt`, `via` (`card` \| `chat`), `raisedAt`, `closedAt`, `closeReason`                                               |
| `commands`        | `runnerId`, `type` (`run_turn` \| `steer` \| `answer` \| `settings` \| `interrupt`), `turnId`, `payload`, `status` (`pending` \| `claimed` \| `done` \| `failed`), `leaseExpiresAt`, `error`                                                                                                                                                                                                                                                          |
| `ledger`          | `roomId`, `type`, `actorParticipantId`, `subjectId`, `parentLedgerId`, `provider`, `model`, `harnessVersion`, `payload`, `at`                                                                                                                                                                                                                                                                                                                         |
| `pushTokens`      | `userSubject`, `token`, `platform`                                                                                                                                                                                                                                                                                                                                                                                                                    |

`parentLedgerId` (what caused this) and `harnessVersion` look optional now and
are painful to add later. Include them from the first migration.

`run_turn` starts a turn. The other command types are control commands for a
turn that is already running: `steer` puts a person's message into it,
`answer` carries a question card's answer, `settings` carries a change to the
edit switch, and `interrupt` stops it.

Ledger types: `runner.registered`, `room.created`, `room.edits_changed`,
`participant.joined`, `invite.created`, `invite.revoked`, `member.joined`,
`member.removed`, `message.posted`, `message.cancelled`,
`message.steer_requested`, `message.steered`, `message.steer_rejected`,
`team_message.posted`, `turn.queued`, `turn.started`, `turn.finished`,
`turn.failed`, `turn.interrupted`, `ritual.started`, `ritual.revealed`,
`takeaway.recorded`, `crux.recorded`, `decision.recorded`, `hand.raised`,
`hand.answered`, `hand.cancelled` and `hand.expired`. `outcome.recorded`
(merged, reverted, abandoned; entered by hand) is planned, but nothing writes
it yet. A `team_message.posted` entry
carries the message id, never its text. A `decision.recorded` entry for a card
answer links the team messages posted while the card was open, by id only.

## Harness interface

```ts
// packages/shared/src/harness.ts (abridged)
export type HarnessId = "claude" | "codex" | "pi";

export interface TurnRequest {
  turnId: string;
  cwd: string;
  prompt: string; // includes the room context block, see below
  model?: string;
  reasoning?: "low" | "medium" | "high" | "xhigh";
  resumeSessionId?: string; // the participant's harnessSessionId
  editsEnabled: boolean; // the room's edit switch when the turn started
  independentReview?: boolean; // fresh session, snapshot, no execution tools
  mcpServers: McpServerSpec[];
}

// The live channel into a running turn. The runner creates one per turn.
export interface TurnInput {
  onQuestion(card: QuestionCard): Promise<QuestionAnswer>; // raises a question card
  steer: (text: string) => Promise<"steered" | "rejected">;
  setEditsEnabled: (on: boolean) => void;
}

export type HarnessEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; summary: string }
  | { type: "tool_result"; id: string; ok: boolean }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  | { type: "final"; text: string }
  | { type: "error"; message: string; retryable: boolean };

export interface Harness {
  id: HarnessId;
  capabilities: { canRaiseCards: boolean };
  version(): Promise<string>;
  runTurn(
    req: TurnRequest,
    signal: AbortSignal,
    input: TurnInput
  ): AsyncIterable<HarnessEvent>;
}
```

Each adapter writes the harness's raw events to the transcript file and yields
normalized `HarnessEvent`s.

### Adapter notes

- **Claude Agent SDK.** `settingSources` loads every source when left out (the
  same as the CLI's defaults), and `'project'` is needed for CLAUDE.md. Leave it
  unset or pass `['user', 'project', 'local']` explicitly. Pass `skills: 'all'`
  so the user's skills are enabled. Read-only: use plan mode or a read-only tool
  allowlist.
- **Codex.** `codex app-server` reads `~/.codex` itself, so config and MCP come
  along. Read-only: use the read-only sandbox.
- **Pi.** Use `RpcClient` (subprocess) rather than the in-process SDK so all
  three harnesses are isolated child processes. Skills are native; MCP needs an
  extension such as `pi-mcp-adapter`. Logins come from Pi's `/login`.
  Read-only: restrict the tool set.
- Ordinary Claude turns run in `default` permission mode with a permission
  callback. Tools pre-approved in the user's settings run, and so do commands
  Claude Code itself classes as read-only. The callback turns the agent's own
  question tool into a question card, allows file edits inside the room folder
  while the edit switch is on, and denies everything else.
- Codex and Pi raise question cards through the room's `raise_hand` tool
  (see "Atelier MCP server"). How each harness handles the edit switch is in
  [shared-rooms.md](shared-rooms.md).
- Every harness runs on the user's own login. The runner never reads or copies
  login tokens.

### Room context block

Each turn's prompt starts with a short, generated block: the room's name, who
is in the room (owner or teammate), whether file edits are on, the handbook,
the last 10 decisions, and a sentence saying the people in the room also have a
private team channel the agent cannot see. Then come the people's messages, each
wrapped in a `<message>` tag naming its author, role, send time and whether it
was queued or steered. Nothing that builds a prompt reads team chat. Agents pull
anything else through MCP when they need it, rather than having it pushed into
every prompt.

## Runner ↔ Convex protocol

1. **Heartbeat.** Every 15 s the runner updates `runners.lastHeartbeatAt` and
   reports installed harness versions and what each can do. A runner with no
   heartbeat for 45 s counts as offline: sends to its agents are refused, and
   messages still waiting for a turn are cancelled as `runner offline` instead
   of starting one.
2. **Claim.** The runner subscribes to its `pending` commands and claims one.
   Claiming a `run_turn` sets `claimed` and a 5-minute `leaseExpiresAt`.
   A cron runs every minute and fails, as `interrupted`, any turn whose
   `run_turn` lease has expired, closes its open question cards and moves the
   agent's queue on. Control commands (`steer`, `answer`, `settings`,
   `interrupt`) take no lease and are only claimable while their turn is
   running.
3. **Run.** For `run_turn`, the runner marks the turn `running`, sends
   its streamed text (to `turnStreams`) throttled to about 2 writes a second,
   which also renews the lease, and finishes with `finalText`, `usage`, `transcriptRef` and
   `harnessVersion`. That mutation writes `turn.finished` to the ledger and
   starts the agent's next turn if messages are waiting.
4. **Control.** The runner hands a `steer` to the harness and reports
   `steered` or `rejected`; a rejected steer goes back to the queue. `answer`
   resolves the agent's open question and `settings` changes the edit switch
   for the running turn. `interrupt` aborts the turn's `AbortSignal`, and the
   turn ends `interrupted`. A person stopping a turn marks it `interrupted` in
   Convex; the runner sees that on its next progress write and aborts.
5. **Restart.** On startup the runner marks its own turns that were still
   `running` as `interrupted` with a reason and fails its claimed control
   commands. The workflow decides whether to retry a review turn.
6. **Auth.** Runner functions take a runner secret (`ATELIER_RUNNER_SECRET`, a
   Convex env var on one side and a runner env var on the other) and check it
   in constant time. The runner never gets a Clerk session.

## Ritual: independent review

1. Robert posts a request in a room and picks the participants (the default is
   every harness participant).
2. A workflow creates a `ritual` (`collecting`) and one `turn` plus one
   `run_turn` command per participant, all `readOnly`, each with a fresh
   prompt. No participant's prompt contains another's answer.
3. Answers are stored as `sealed` messages. **Every query that returns messages
   hides sealed messages from everyone, human included, until the ritual is
   revealed.** The phone only shows a progress bar.
4. When every turn is `done` or `failed`, the workflow sets the ritual to
   `revealed`, writes `ritual.revealed`, and sends a push notification.
5. Robert reads the answers side by side, records one or more cruxes and a
   decision. The ritual becomes `decided`.
6. Follow-up work happens as ordinary room messages to a chosen participant,
   linked to the decision through `parentLedgerId`.

Hiding the answers from the human too is deliberate. It keeps Robert from
anchoring on the first answer that arrives.

## Atelier MCP server (v0)

The runner serves a local MCP server, scoped to the turn's room, and adds it to
every harness's MCP config for that turn.

| Tool                             | What it does                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `raise_hand(question, options?)` | Puts a one-question card in front of the room and waits for the first answer, on the card or in chat, for up to 2 hours. Codex and Pi only: Claude asks through its own question tool, which allows several questions per card |
| `read_handbook()`                | Returns the room's handbook as it is now                                                                                                                                                                                       |
| `recent_decisions(limit?)`       | Returns the room's latest decisions (10 by default, up to 50) in the view the room context block uses. Never a rationale or a review decision                                                                                  |

The tools join the room document tools on the same per-turn server: Claude
gets it in-process, Codex as `mcp_servers.atelier`, Pi through a runner
extension. Independent reviews get no room tools. Review follow-ups get all
three, and their cards are the owner's alone. Scribe runs keep their draft
tools and ask nothing. Every raised card, Claude's included, pushes to the
owner's phone, naming the agent but not the question. If the agent stops
waiting (its call is cancelled while the turn goes on), the card closes as
cancelled.

`post_finding` and `ask_peer` come later. `ask_peer` would be peer mode, which
is out of scope.

## Mobile app (v0 screens)

1. **Rooms.** The list of rooms, with badges for open hands and revealed
   rituals waiting on Robert.
2. **Room.** The timeline, a composer that can send to one participant or
   start an independent review, and the handbook behind a tab.
3. **Ritual.** While collecting: per-participant progress only. After reveal:
   swipeable answers side by side, plus a crux and decision editor.
4. **Hand.** The question with option buttons and a free-text answer.

Streaming markdown and code blocks, rendered with FlashList, are where the app
will feel native or sluggish. Choose the renderer in the first week.

## Build order

1. **Scaffold.** The monorepo, Convex project and schema, Clerk on both sides,
   an empty Expo app signed in on the iPhone.
2. **One turn end to end.** The Claude adapter runs one turn on the VM, and
   `partialText` streams to the phone.
3. **Codex and Pi adapters.**
4. **Independent review** with blind until reveal, cruxes, decisions and push.
5. **The Atelier MCP server** with `raise_hand`.
6. **Building Atelier inside Atelier.**

## Open questions and things to verify

- How Pi and Codex handle read-only mode in practice. Check the current flags
  before relying on them.
- Whether the Agent SDK respects a per-turn MCP server added beside the user's
  configured ones without replacing them.
- Expo with pnpm. If Metro has trouble with symlinks, `node-linker=hoisted` in
  `.npmrc` is the usual fix.
- How each provider's terms treat automated use of a subscription. This matters
  for later features (the scheduler), not v0.
- The runner's long-term home: one runner per VM, each room pinned to one.
