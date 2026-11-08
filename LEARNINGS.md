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

## Room document tool probes (2026-11-07)

Run live with Robert's logins in throwaway git repos under `/tmp`, using
a throwaway probe script (not kept): Claude Code through Agent SDK 0.3.318
(Haiku), Codex CLI 0.166.0 `app-server` (`gpt-6.1-sol`, low effort) and Pi
1.4.0 (`openai/gpt-6-astra`, low thinking). Each harness got one stub `echo`
tool from the runner, on a fresh session and then on a resumed one.

- **Claude:** an in-process `createSdkMcpServer({ name: 'atelier', alwaysLoad: true })`
  in `mcpServers` loads next to Robert's own claude.ai servers
  (`source: "sdk"`), is listed in `init.tools` as `mcp__atelier__echo`, and
  works after `resume`. Its calls reach `canUseTool`, so the deny-by-default
  handler must allow `mcp__atelier__*`. Do not use an HTTP entry with a token
  in `headers`: the SDK passes non-SDK servers to the CLI as a `--mcp-config`
  argument, where any process can read it. The SDK needs `zod` as a peer
  dependency for `tool()` schemas.
- **Codex:** `config` keys `mcp_servers.atelier.url` and
  `mcp_servers.atelier.bearer_token_env_var` (token in the app-server's
  environment, not argv) work on `thread/start` and again on `thread/resume`.
  Without more, every call needs approval: under `approvalPolicy: 'never'` the
  call fails with "MCP tool call requires approval, but approval policy is
  never", and under `untrusted` Codex sends `mcpServer/elicitation/request`
  (`_meta.codex_approval_kind: "mcp_tool_call"`). Adding
  `mcp_servers.atelier.default_tools_approval_mode = "approve"` pre-approves
  only this server's tools: calls then run with no request under both
  `never`/read-only and `untrusted`/workspace-write, on start and resume.
  Answering the elicitation with `{ action: 'accept', content: null }` also
  works, including with a granular policy, but is not needed.
- **Pi:** a `--extension` file that calls `pi.registerTool()` (TypeBox schema
  from `typebox`, which Pi resolves for extensions) and forwards to the
  loopback endpoint with a token from `RpcClient`'s `env` works with
  `--tools read,grep,find,ls,atelier_echo`, and again with `--session`.
  Naming no `mcp__` entry in `--tools` leaves Robert's own MCP tools as they
  were. `registerMcpServer` was not needed.
- The stub server bound `127.0.0.1` on port 0 and got ports in the 37000–45000
  range, outside the 3000–9999 range exe.dev forwards.

## Room document live checks (2026-11-07)

Run against the Convex dev deployment with this branch pushed, using a second
runner named `room-document-live-check` (Robert's own runner kept running) and
a throwaway room under `/tmp`, driven with `npx convex run --identity` as a
test owner identity.

- Claude, Codex and Pi each added, updated and deleted their own block and
  commented on Robert's heading, with edits off on a fresh session and with
  edits on on a resumed session. Tool calls appeared as turn items named
  `mcp__atelier__*`, `atelier.*` and `atelier_*`. Pi's `atelier_*` pattern in
  `--tools` and registering the tools when Pi loads the extension both work.
- After Robert edited Claude's block, Claude's next update kept his fix. Each
  model's attempt to overwrite another model's block was refused and it
  commented instead.
- An @Codex comment produced a reply in the thread, not in the agent pane.
- A review and a review follow-up left the document unchanged. The follow-up
  in a solo room ran with `separateSession: true` and said the document was
  read-only for it.
- Scribe runs committed with each harness (Codex's run on an `ephemeral`
  thread). Codex merged three notes into one scribe block crediting all three
  authors and re-attached all four threads to it. During a run a person's edit
  was refused; Stop left the document byte-identical with the lock cleared.
- Unprompted use: given five ordinary requests that never mention the
  document, Claude wrote to it in 3 turns, Codex in 2 and Pi in 2, and none
  commented. Tune the tool descriptions if that proves too quiet or too noisy.

## raise_hand long-call probes (2026-11-07)

Run live with Robert's logins through the real runner adapters, in a
throwaway repo under `/tmp`, against a stub `atelier` endpoint whose `wait`
tool replied after a set time: Codex CLI 0.166.0 `app-server` (`gpt-6.1-sol`,
low effort) and Pi 1.4.0 (`openai/gpt-6-astra`, low thinking). The probe
script was not kept.

- **Both harnesses hold a tool call for 40 minutes.** Codex with
  `mcp_servers.atelier.tool_timeout_sec` set (the default is 60 s; an 82 s call
  also passed) and Pi through the extension's `node:http` client (Node's
  `fetch` gives up after 300 s without response headers) each returned the
  2400 s result to the model, which then answered with it. Pi needed the
  adapter's own 30-minute run timer gone; the runner's pausable turn deadline
  replaces it.
- **How each harness abandons a call.** Aborting a Codex turn mid-call closes
  the HTTP connection _and_ sends `notifications/cancelled` with the call's
  JSON-RPC id (`reason: "MCP request cancelled by caller"`). Aborting a Pi run
  closes the connection. The endpoint treats either as "the agent stopped
  waiting" and withdraws the card.
- **Codex keeps calling the model while an MCP call is pending.** During the
  40-minute wait it emitted a `thread/tokenUsage/updated` about every 13 s
  (183 in total), each a reasoning step with ~30 output tokens over the cached
  context, which grew by ~59 tokens each time. The call itself was unaffected.
  A raise_hand card left open for two hours therefore costs Codex roughly 550
  small model calls against Robert's ChatGPT plan limits. Watch
  `account/rateLimits/updated` if this proves expensive.
- Asked to call the tool, both models called it at once and waited; neither
  asked in plain text or called a `sleep` tool.

## raise_hand live check (2026-11-07)

Run against the Convex dev deployment with this branch pushed, a second runner
named `mcp-tools-live-check` (Robert's own runner kept running) and a
throwaway room under `/tmp`, driven with `npx convex run --identity` as a test
owner identity. Codex CLI 0.167.0, Pi 1.4.0, Claude Code 2.1.319.

- **Codex asked in plain text until the prompt named the tool.** Asked to let
  Robert pick a database, Codex replied with a plain-text question and ended
  its turn, although the `atelier` server was ready and `raise_hand` was
  listed. Told to use `raise_hand`, it did. The room context block for Codex
  and Pi now says to call `raise_hand` when a person's answer is needed;
  after that, both raised a card unprompted on the first try. Claude's block
  does not mention it, since Claude asks through its own question tool.
- Codex's card was answered on the card on a resumed session and Pi's in chat
  (the chat message started no new turn); each turn continued with the
  answer, and the decisions showed in `recent_decisions` for all three
  harnesses. Stopping a Pi turn with an open card marked the card cancelled
  and Pi idle. The pane showed all three agents able to raise cards.
- `read_handbook` worked on all three harnesses but only on an empty
  handbook: nothing can edit a handbook yet (rooms are created with `""`).
- A `push:sendHand` action ran successfully for each raised card, but no
  device is registered on the dev deployment, so no notification was sent.

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

## Web end-to-end testing (2026-11-07)

Findings from the browser pass are in
[docs/plans/2026-11-07-1100-web-e2e-findings.md](docs/plans/2026-11-07-1100-web-e2e-findings.md).

- The runner reports harness capabilities only when it registers. After
  merging runner changes, restart it, or the web keeps showing the old
  capabilities ("Codex can't raise question cards") and agents get the old
  room tools. Ask an agent to list its `atelier` tools to see what is live.
- `ssh aurora-but-gold.exe.xyz '<cmd>'` works for checks from the Mac, but its
  non-login shell has no `node`, `npx` or harness CLIs on PATH. Borrow the
  runner's PATH from `/proc/<runner pid>/environ` (print only `PATH=`), or run
  Convex commands from an interactive VM shell.
- The runner runs detached from `~/Projects/atelier/runner` as
  `node --env-file-if-exists=.env.local src/index.ts`, logging to
  `~/.atelier/logs/runner.log`. To restart it, kill only that pid and start it
  again with `setsid nohup` and the same PATH; the log then shows a fresh
  `runner "exe-vm" registered` line.
- Claude in Chrome's `resize_window` does nothing on a maximized window. To
  check the narrow layout, inject a 390 px same-origin iframe of the page; the
  Clerk session carries over.
- Claude Code moves `sleep` and other long commands to the background, then
  ends its turn with a `result` and starts another when the command
  finishes, so one room turn can hold several results. A probe with Sonnet
  (Agent SDK 0.3.318) showed:
  - a `priority: 'next'` message pushed after the first result, while the
    background task runs, starts at once as its own result, and the task
    keeps running;
  - `background_tasks_changed` carries the live set (REPLACE semantics) with
    an `ambient` flag; `q.stopTask(taskId)` stops one task;
  - closing the input does not end the query while a background task lives:
    a backgrounded `sleep 600` held the query open past the close, so a
    command that never exits holds the room turn until the turn deadline.
    That was true before the steering change too.
- A steer that lands in the instant between Claude's single final `result`
  and the adapter closing its input can hang the turn: the adapter waits on
  `cancelAsyncMessage` inside its message loop and the reply never arrives.
  Seen only in the fake-CLI test, not live.
- The Agent tool's `isolation: "worktree"` cut worktrees from `main`, not
  from the current branch, and removed them once a worker stopped without
  changes. For parallel workers on an unmerged branch, create the worktrees
  yourself (`git worktree add --detach <dir> <sha>`) and point each worker at
  its own.
- `npx convex env get <NAME>` exits 0 and prints "✖ Environment variable
  ... not found" when the variable is unset, so test the output, not the exit
  code. Check a secret by length and prefix only.
- The Clerk CLI (`npx -y clerk@4.1.0`, already logged in on the Mac) manages
  the instance. Atelier is `app_3LiFMTVI7EVwIxVjfMf63v25NrP`, dev instance
  `wealthy-mackerel-1108` (Convex's `CLERK_JWT_ISSUER_DOMAIN`). To rotate the
  secret key without showing it, pipe `clerk env pull --app <id> --instance
  dev --print | grep '^CLERK_SECRET_KEY='` over ssh into `npx convex env set`.
  `clerk config pull` / `clerk config patch --json ... --dry-run` read and
  change settings; sign-up mode is `auth_access_control.sign_up_mode`, set to
  `restricted` on 2026-11-07.
- Invites never email: `invites.create` makes the Clerk invitation with
  `notify: false` and returns its ticket link for a new account, which the
  owner sends. Restricted sign-up admits only holders of that link. Check an
  invite with `clerk api "/invitations?status=pending|accepted|revoked"`; the
  bare `/invitations` list hides revoked ones.
- Clerk asks for first and last name at sign-up (`user_model.first_name` and
  `last_name`, enabled and required, 2026-11-07). Atelier takes a member's
  display name from the token's `name` when they join, falling back to email.
- On the VM, `ls` is aliased to eza, which reads file names from stdin when
  stdin is not a terminal: a bare `ls` prints nothing in Claude's Bash, and
  over ssh it waits forever on the session's stdin. Use `command ls`, give
  eza a path, or send ssh `< /dev/null`.
- `claude -p` on the VM warns that its sign-in can end on a fixed date. When
  it ends, every Claude turn fails until `claude auth login` (or
  `claude setup-token`) is run in an interactive VM shell.

## Block editor (2026-11-08)

- Mounting one Tiptap editor per block took 1.1 to 1.2 s for 600 blocks
  in a production build (headless Chromium on the VM). Blocks therefore
  render static DOM from the schema (30 to 50 ms for 600) and an editable
  block mounts its editor when the pointer enters it or focus reaches it.
  Keep that in mind before adding per-block work at mount.
- Browser-checking the editor without signing in: a throwaway Vite config
  that aliases `convex/react` to an in-memory fake, rendering
  `DocumentPane`, driven by `playwright-core` installed in a `/tmp` scratch
  folder (not the repo) with `executablePath` set to the cached
  `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`. Two traps:
  - The fake's `useMutation` must return the same function per mutation on
    every render, as Convex does. `DocumentPane` memoizes its editing
    session on those functions; a fresh function per render recreates the
    session, which saves and releases after every keystroke.
  - Keys sent back to back reach ProseMirror before Chrome delivers the
    `selectionchange` for the previous caret move, so Enter acts on the old
    caret. Leave about 60 ms between keys, as a person would.
- `npx convex data blocks --limit 10000 --format jsonLines` reads a table
  for a read-only data check without deploying a query.
- `pkill -f <pattern>` run from Claude's Bash also kills that shell when
  the pattern appears in its own command line. Kill by the port's pid
  (`ss -ltnp`) instead.
- `tests/anchor.test.ts`'s sub-second timing check fails under `pnpm
  coverage` instrumentation (1.1 to 1.6 s), on `main` as well. Read
  backend coverage with `--coverage.reportOnFailure`.

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
- The runner sets `ATELIER_ROOM_TURN=1` for every harness it starts, and the
  post-edit hooks in `.claude/settings.json` and `.codex/hooks.json` skip
  themselves when it is set. Without that, a room agent with edits on could
  write `node_modules/.bin/ultracite` or `oxlint.config.mts` and have the hook
  run it outside the runner's permission checks. Keep the guard inside the
  hook command (those folders are protected from room edits), not in a script
  a room agent could rewrite.
