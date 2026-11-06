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
