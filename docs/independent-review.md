# Independent review (step 4)

From a room, tap **Review** (or **Independent review** at the top), enter a
request and select participants. All harness participants are selected initially.
The review screen shows status only until every participant finishes or fails.
You can close Expo Go while the review runs. Cancellation and runner restart
mark affected review turns failed and count toward reveal; there is no automatic
retry that could silently produce a second answer.

After reveal, the review is complete. Swipe between answers and tap **Follow up
with…** to continue with that participant in the room. The follow-up includes the
original request and that participant's answer, and links to the reveal ledger
event. No form needs to be completed first.

**Save a takeaway (optional)** opens a single notes field. Saved takeaways persist
without changing completion status. Older crux and decision records remain
readable, but their forms are no longer part of the review flow.

## Independence and tools

The start mutation atomically creates the ritual, queued turns, commands and
ledger events, and starts a Convex Workflow. Terminal mutations send durable,
per-turn workflow events. The workflow waits for every event, checks terminal
state again, and atomically reveals messages. Notification sending is a subsequent
retryable workflow action; push failure cannot prevent reveal.

Owner queries return explicitly selected progress fields while collecting. They
never return review partials, final text, errors, transcript locations, prompts,
or snapshots. Ordinary room timelines exclude review turns, and sealed messages
become room-visible only in the reveal transaction. Runner APIs are trusted and
require the existing runner secret; VM administrators and the Convex dashboard
remain outside this application visibility boundary.

Each review uses fresh harness sessions without updating the participant's
ordinary session. The first runner preparation stores a shared repository
snapshot in Convex, which every participant receives. It includes tracked,
regular text files from the working directory, capped at 300 KB total and 60 KB
per file. Untracked files, symlinks, common credential filenames, binary files,
and larger files are omitted. The prompt lists omissions. This is deliberately
bounded evidence: reviewers must identify conclusions they cannot support.
A non-Git project fails explicitly instead of receiving an invented snapshot.

Review restrictions are per process/turn; user configuration and logins are not
rewritten. Claude uses an empty tool set, strict empty MCP configuration, disabled
hooks and no session persistence. Pi uses `--no-tools --no-extensions --no-mcp
--no-session`. Codex uses a fresh ephemeral thread, read-only sandbox, no shell,
MCP, apps, plugins, hooks, goals, browser/computer or delegation features. Codex
can still advertise built-in tools such as `apply_patch`; its sandbox rejects
writes. Live probes verified rejected edits and an unchanged sentinel file.
Ordinary turns retain their prior adapter settings.

These restrictions mean review-time executable plugins/extensions and MCP tools
are unavailable. Text instructions and native harness configuration still load.
This step does not add Atelier MCP (step 5).

## Shared rooms

Reviews stay owner-only when a room has a teammate. Only the owner can start,
cancel or follow up a review, record a takeaway, crux or decision for one, or
answer a question card raised during a follow-up. A teammate's timeline and
agent pane never show review turns, revealed answers, follow-up messages or
follow-up turns. Review and follow-up turns also stay out of the agent queue:
a follow-up always runs as its own turn and never takes a steer.

A follow-up normally continues the participant's ordinary session. In a room
with an active teammate it runs on a separate session kept with the review
instead, one per participant, so the agent cannot repeat the review to the
teammate in a later ordinary turn. The choice is fixed when the runner claims
the follow-up turn. See [shared rooms](shared-rooms.md).

## Push readiness

The backend accepts owner-authenticated Expo tokens and sends generic reveal
notifications with a ritual id, never answers. Sending retries up to three times;
invalid-device tickets remove stale tokens. `pushStatus` distinguishes queued,
sent (accepted by Expo, not proof of device delivery), skipped (no token), and
failed. Receipt polling is not implemented. A timeout after Expo accepts a batch
can lead to a duplicate notification on retry.

The mobile registration control is gated on a physical device, an EAS project id,
and a native build. Expo Go remains usable and explains why push registration is
unavailable. A development build still needs its EAS project id and APNs/FCM
credentials before delivery can be tested. `EXPO_ACCESS_TOKEN` in Convex is
optional, for Expo push access-token security. Notification taps open the ritual.

## Verification

- `pnpm --filter @atelier/backend test`: real Convex function tests using
  convex-test and the registered Workflow component, including sealing, failure,
  cancellation, recovery, idempotency, authorization, shared snapshots, decisions,
  follow-up causality and mocked push delivery.
- `pnpm --filter @atelier/runner test`: adapter protocol regression tests and
  snapshot exclusion tests.
- `pnpm typecheck` and `pnpm lint`.
- Phone acceptance: create a review, close/reopen Expo Go while collecting,
  cancel one participant, verify no answer appears early, swipe revealed answers,
  send a direct follow-up without saving anything, then optionally save a takeaway.
  Check normal timeline scrolling and composer/ritual keyboard spacing.
