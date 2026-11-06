# Atelier learnings

## Launching the iPhone app in Expo Go

Use the webpage at **https://<current-expo-tunnel-host>/expo-go.html**. It has an
**Open in Expo Go** button. The source is
[apps/mobile/public/expo-go.html](apps/mobile/public/expo-go.html).

The button constructs `exp://` plus the page's current host directly in the
browser. It does not depend on a server redirect, and automatically uses the
current tunnel hostname.

On 2026-11-06 the working page was:
https://c-robertguss-0g6sue-mw4wsmmem2kjbx3l.on.expo.app/expo-go.html
This is an example, not a permanent URL. Read the current Expo output before
sharing a link; restarting Expo can change the tunnel hostname.

Do not send the bare HTTPS tunnel root: it opens the web app in the browser.
Do not use Expo's built-in `/_expo/loading?platform=ios` page for this setup:
its Expo Go button requests `/_expo/link?choice=expo-go&platform=ios`. We
reproduced a 504 from the public tunnel on that request, while the local
server returned a 307 redirect to `exp://...`. The custom page bypasses this
failing redirect. Merely checking that the built-in page loads is insufficient.

### Start and verify

- Work in `/home/exedev/Projects/atelier`, not an inherited scratch directory.
- Check for existing Atelier processes before starting another instance.
- Start Expo from `apps/mobile` with `pnpm exec expo start --tunnel`.
  Use `--clear` when deliberately clearing Metro's cache.
- The existing detached-process logs are `~/.atelier/logs/expo.log` and
  `~/.atelier/logs/runner.log`. Keep logs private; do not print env files or tokens.
- Read the latest `Waiting on http://...on.expo.app` line from the current run.
  Give the user its HTTPS equivalent with `/expo-go.html` appended.
- Verify the public launch page and `/status`. A local Metro status alone does
  not prove the tunnel works. For deeper checks, request the root with
  `expo-platform: ios` and `accept: application/expo+json`, then fetch the
  manifest's `launchAsset.url` to confirm the iOS bundle is served.
- If restarting everything, stop only Atelier's runner, Expo, and their child
  processes. Do not kill T3/Codex infrastructure or unrelated processes.
- The spec targets a development build eventually, but the user is currently
  testing through Expo Go. Preserve the working launch flow.

## Pi adapter pitfalls

- The user logged into **ChatGPT** in Pi. An OpenAI API provider selection is
  not equivalent to using that subscription login.
- The installed Pi is 1.4.0 (`@earendil-works/pi-coding-agent`). The old
  `@mariozechner/pi-coding-agent` 0.73.1 CLI did not understand this user's
  ChatGPT login. Pi 1.4.0 reports `openai` OAuth ready; do not assume the
  provider name alone means API-key authentication.
- The adapter now uses the 1.4.0 RpcClient and a small Node entry-point bridge
  (`runner/src/adapters/pi-cli.mjs`) to launch the user's actual `pi` binary.
  `ATELIER_PI_PATH` overrides the binary; `ATELIER_PI_CLI_PATH` overrides the
  Node entry point. Never read or copy credential files.
- RpcClient 0.73.1's `prompt()` discarded `success: false` responses. The
  1.4.0 client propagates these errors; `pi.test.ts` covers rejected prompts.
  Completion now uses `agent_settled`, and a `handled` prompt disposition
  must not wait for an event from a run that never started.
- Start cancellation/progress polling only after the backend start mutation
  commits. Polling while the harness version check runs sees a queued turn and
  can incorrectly abort it. This caused immediate Pi interruptions.
- The user selected **GPT-6 Astra** for Pi. A live two-turn adapter test with
  `openai/gpt-6-astra` succeeded and retained the word "violet" across session
  resume. Earlier trials of `gpt-5.5` and `gpt-5.3-codex` were rejected by the
  ChatGPT account; login readiness alone does not prove a model works.
- `runner/.env.local` sets `ATELIER_PI_MODEL=openai/gpt-6-astra`. The runner
  uses this default only for Pi participants without an explicit model. It
  leaves the user's global Pi configuration unchanged.

## Independent review (step 4)

- Review turns must never reuse or replace ordinary participant session ids.
  Owner queries must omit partials, final text, errors and transcript references
  while collecting; hiding only sealed `messages` is insufficient.
- Workflow completion events are sent in the same transaction as terminal turn
  transitions. Cancellation and restart recovery count as failed review turns.
- Pi 1.4.0's `--tools read,grep,find,ls` does **not** exclude MCP tools. Its CLI
  explicitly says MCP tools remain enabled. Reviews use `--no-tools`,
  `--no-extensions`, `--no-mcp`, and `--no-session`, with a shared tracked-file
  snapshot. See [independent review](docs/independent-review.md) for limits.
- Codex app-server `thread/start.config` dotted keys must not contain TOML-style
  quotes around an MCP name. `mcp_servers."tinyfish".enabled` produced an invalid
  transport error; `mcp_servers.tinyfish.enabled` worked. Config responses can
  contain secrets and are excluded from raw transcripts, including late replies.
- Live probes showed Codex can still expose `apply_patch` despite shell tools
  being disabled. The read-only sandbox rejected its attempted write. Do not
  claim that Codex exposes zero tools. Claude and Pi review probes exposed none.
- The step 4 live verification room completed Claude, Codex and Pi turns, kept
  early answers hidden, revealed all three, then persisted a crux and decision.
  Push was skipped because the verification identity has no registered device.

## Harness capability probes (2026-11-06)

Run live on this VM with Robert's logins, in throwaway git repos under `/tmp`:
Claude Code 2.1.318 through Agent SDK 0.3.318 (Haiku and Sonnet), Codex CLI
0.166.0 `app-server` (`gpt-6.1-sol`, low effort) and Pi 1.4.0
(`openai/gpt-6-astra`, low thinking). The probe scripts were not kept.

### Claude

- **Steering folds with `priority: 'next'`, not `'now'`.** With a streaming
  `query()`, a message pushed with `'next'` while a Bash call runs joins the
  running turn at the next tool result. Its `command_lifecycle` goes `queued`,
  then `started` straight after the tool result, with no `result` in between.
  The next `system`/`status` frame's `user_message_uuids` gains its uuid. The
  transcript records a `queued_command` attachment, rendered to the model as
  "The user sent a new message while you were working", plus a `remove` queue
  operation with reason `absorbed_mid_turn`. One `result` covers both messages.
- `'now'` does **not** fold. It lets the running tool finish, then ends the
  turn: a `success` `result` with empty text, the first message's lifecycle
  `cancelled`. The pushed message then runs as a new turn in the same session.
- A message pushed after the final model call (after `message_stop`, before
  `result`) is not folded, at either priority. The first turn's `result`
  arrives, then the message runs as a second turn with its own `result`.
- Send the person's text as typed. Haiku ignored a fold worded "Change of plan
  from the user: ..." and said it came from the tool result, not the user. The
  same request worded plainly was obeyed by Haiku and Sonnet.
- Under `permissionMode: 'default'`, `AskUserQuestion` reaches `canUseTool`
  with `{ questions: [{ question, header, options, multiSelect }] }`. Returning
  `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: label } } }`
  continues the turn with that answer.
- An unapproved in-folder Write also reaches `canUseTool`. Allow writes the
  file. Deny returns its message as an error tool result and lists the call in
  `result.permission_denials`.
- Read-only Bash (`sleep 6 && echo one`) ran without reaching `canUseTool`,
  although Robert's user settings have no allow rules. Claude Code approves
  commands it classifies as read-only by itself.
- Consequence: Claude can take a steered message without stopping its turn,
  so the stop-and-ask condition does not apply. "Steer now" must send
  `priority: 'next'`: `'now'` is a stop-then-redirect.

### Codex

- `initialize` with `capabilities: { experimentalApi: true, requestAttestation: false }`
  works.
- **No question cards in Default mode.** Asked to use its ask-user tool, the
  model asked in plain text and never sent `item/tool/requestUserInput`. It
  then called a `sleep` tool (item type `sleep`, `durationMs: 60000`) three
  times while waiting for an answer, so the turn took three extra minutes.
- In Plan mode the request arrives with `isBlocking: true`. In Default mode it
  arrives only with the under-development `features.default_mode_request_user_input: true`
  set in `thread/start` `config`. Codex then sends an "Under-development
  features enabled" warning, and the request has `isBlocking: false`. That
  request still waited 30 seconds for an answer without resolving itself. The
  answer shape is `{ answers: { [questionId]: { answers: [label] } } }`.
- Consequence: Codex stays in Default mode, asks in plain text, and the room
  marks it as unable to raise cards. The flag is the only route to Default-mode
  cards, and it is an under-development feature.
- `turn/steer { threadId, input, expectedTurnId }` mid-command returns
  `{ turnId }`. The steer shows up at once as a `userMessage` item, and the
  model acted on it after the running command, in the same turn. A stale id
  fails with `-32600` "expected active turn id `<sent>` but found `<active>`".
  After the turn ends it fails with `-32600` "no active turn to steer".
- With `workspaceWrite` (`writableRoots: [cwd]`, network off) and
  `approvalPolicy: 'untrusted'`, `touch made-by-shell.txt` and
  `echo x > .git/evil-shell.txt` each raised `item/commandExecution/requestApproval`.
  `{ decision: 'decline' }` ended the item as `declined` and the model went on.
- **`.git/`, `.codex/` and `.agents/` inside the workspace are not read-only.**
  Each `apply_patch` into them, and into ordinary files, raised
  `item/fileChange/requestApproval`. Accepting wrote the file; declining left
  it unwritten with status `declined`. The approval request carries no paths:
  take them from the `item/started` `fileChange` item with the same `itemId`
  (`changes[].path`).
- Consequence: protected paths are enforceable for Codex only by declining
  file-change approvals whose paths match, not by the sandbox. With that
  check, Codex edits can be enabled.

### Pi

- `client.steer(text)` during a bash call resolves `"queued"` and emits
  `queue_update`. Pi finishes the running tool, then delivers the steer as a
  user message before the next model call, in the same run (one
  `agent_settled`). The model acted on it.
- A `--extension <file>` `tool_call` handler returning `{ block: true, reason }`
  blocked `write` and `edit` to `../outside.txt`, `../claude/notes.ts`, an
  absolute path outside `cwd`, `.pi/evil.json`, `.git/evil.txt` and
  `.git/HEAD`. The reason comes back as an error tool result. In-folder edits
  and writes went through. The handler receives `event.toolName`,
  `event.input.path` (relative or absolute) and `ctx.cwd`.
- Robert's own extensions still load next to `--extension`. His Atuin
  extension recorded the probe's bash command with author `pi`, and the
  built-in `llama` and `mcp` extension commands were listed. His herdr
  extension reports only in TUI mode, so it is silent under RPC either way.
- Consequence: the Pi edit guard is feasible as a runner-shipped extension.

## Shared rooms build pitfalls

How to set up and run shared rooms is in [docs/shared-rooms.md](docs/shared-rooms.md).

- `convex codegen` contacts the dev deployment, but it only regenerates
  `packages/backend/convex/_generated`. It does not push functions, so the live
  deployment keeps running the old code. Push with `npx convex dev --once` (or
  a running `convex dev`) from `packages/backend` before testing against it.
- pnpm here enforces a minimum release age. It refused packages published the
  same day, so a fresh version failed to install. Pin the previous release, or
  wait, rather than loosening the setting.
- Legend List lagged behind streaming text in the web agent pane. The pane uses
  a plain scroller that sticks to the bottom while you are at the bottom.
- In live Claude steering checks, Haiku sometimes ignored a folded steer that
  Sonnet followed. Test steering with Sonnet before concluding it is broken,
  and keep sending the person's text as typed (see the Claude probe notes
  above).

## Quality tooling (2026-11-06)

- TypeScript stays on 6.0.3, the version Expo SDK 58 pins. TS 7 ships no
  compiler API and Expo flags it. Type-aware lint still works:
  `oxlint-tsgolint` ships its own type checker and ignores the installed
  `typescript`.
- `ultracite init` and `ultracite upgrade` pin oxfmt below the installed
  version (`^0.75` meant <0.76). Re-check `oxfmt` in `package.json` after
  either command.
- The Convex tsconfig has `noUncheckedIndexedAccess` on, matching the runner,
  which also compiles backend files. Without it, type-aware lint (reading the
  Convex config) removes `!` assertions the runner build still needs.
- vitest fakes `clearTimeout` and `clearInterval` only when they are listed in
  `toFake`. Node's `mock.timers` covered them implicitly; leaving them out
  made a paused deadline fire anyway.
- `noUnnecessaryTypeAssertion` fixes can remove a cast that contextual typing
  needed. Type the variable instead of restoring the cast.
- Git worktrees share `.git/hooks`, so `lefthook install` in one worktree
  installs the hooks for all of them. Worktrees without `lefthook.yml` just
  print "No config files" and pass.
- A path-limited commit (`git commit -- <paths>`) commits lefthook's fixed
  files but leaves the pre-fix copy in the index. Plain `git commit` does not.
- Codex runs project hooks (`.codex/hooks.json`) only after the repo's
  `.codex/` folder is trusted in Codex. Do this once per machine. Start agent
  sessions at the repo root so the post-edit hook covers every file.
- Atelier room turns that run Claude Code or Codex in this repo can also
  trigger the post-edit fix hook. This has not been checked in a live room
  yet. Claude review turns have no edit tools. Codex review turns may still
  attempt `apply_patch`, which the read-only sandbox rejects, so check that
  a rejected patch never produces a hook fix or error in a sealed answer.
