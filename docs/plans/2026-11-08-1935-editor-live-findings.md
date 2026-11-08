# Editor live findings (2026-11-08)

Live browser checks against https://atelier-mu-seven.vercel.app, checkout
`da3a335`, Convex dev and the existing exe-vm runner. Only Ana Tester, Ben
Tester and Editor live check (`kh72qzwtxkzj7vpmjzm8c12std8ht8a8`) were used.
The resumed pass covers the verification contract below. Failures and harness
limitations remain for review; no application fixes were made.

## Medium

### F1. An empty paragraph has no pointer target after reload

- Repro: create a paragraph with Enter, leave it empty, then reload the room.
  Locate its text surface and attempt to hover or click it.
- Seen: the static text surface contains `<p data-kind="paragraph"></p>`.
  Chromium measured its bounding box as x=460, y=556, width=720, height=0.
  Playwright hover timed out. The author and block actions still render.
- Expected: an empty paragraph retains a visible, clickable writing surface
  so the person can resume writing with a pointer.
- Likely file: `apps/web/src/components/document/BlockEditor.tsx`
  (`StaticBlock`), with the editor styles as another candidate.
- Severity: medium. Keyboard focus is a possible workaround; it was not
  validated as a complete user flow.
- Evidence: `/tmp/editor-live-probe/empty.png`, inspected DOM and measured
  bounds. Screenshots remain local and are not committed.

### F2. Claude cannot inspect a large read_document result through context-mode

- Repro: ask Claude through the agent pane to call `read_document` and name
  the person editing its own block in the accumulated test document. Repeat
  after moving that block to the top.
- Seen: Claude called the document tool and reported that its installed
  context-mode plugin reduced the result to excerpts. Its `ctx_search` call was refused.
  Claude explicitly reported that it could only name Ben from the turn's
  room snapshot, not confirm him from the fresh read. Moving the block did
  not help. Codex and Pi read the holder successfully.
- Expected: the agent can inspect the document tool result, including its
  editing-holder information, within the room's permitted tools.
- Severity: medium, harness integration. This is not evidence that the
  backend omitted the holder; the update refusal itself named Ben correctly.
- Likely file: `runner/src/adapters/claude.ts` (loaded plugins and tool
  permission boundary), plus the VM's external context-mode configuration.
- Evidence: `claude-read.log`, `model-lock.log` and the room's Claude turns.
  No plugin, permission or runner settings were changed.

## Verification contract status

| Check | Result                        | Evidence                                                                                                                                                                                                                                                                                        |
| ----- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Pass                          | No Edit button; badge present by 721 ms; history count stayed 115 after focus and before typing, then became 116 after save; persisted edit seen by Ben.                                                                                                                                        |
| 2     | Pass                          | Concurrent Ana/Ben typing: Ana won; Ben saw the named-holder refusal and both draft actions.                                                                                                                                                                                                    |
| 3     | Mixed: creation/keys pass; F1 | All eight slash choices and all seven documented markers produced the correct kinds in Convex; Enter continuation, code exit and Backspace conversions exercised. Empty-item exit, Enter at start, code newline, nonempty divider insertion and divider deletion also passed.                   |
| 4     | Pass                          | Comment on beta followed split to the tail at offset 0 and merge back at offset 6; exactly one history entry each. Browser restore returned a to-do to checked=true.                                                                                                                            |
| 5     | Pass                          | Parked caret allowed scribe start; zero editable surfaces among 88 blocks; comment posted during run; Stop preserved all block ids, revisions, text, kinds, ticks, order and deletion state.                                                                                                    |
| 6     | Mixed: writes pass; F2        | All three refused update with being_edited while Ben held their own block and succeeded after blur, retaining his text. Codex/Pi fresh reads named Ben. Each agent added marker-free todo and numberedItem blocks and reported unchecked/#1. Claude also added quote, code and divider. See F2. |
| 7     | Pass                          | Two Ana contexts typed concurrently; losing context showed changed-since-last-seen plus Copy my draft / Discard my draft.                                                                                                                                                                       |
| 8     | Pass                          | Drag landed at indices 101, 0 and 50 of 102. Keyboard moved to top in the single-step run, bottom and middle in the longer run. Ben-held block disabled Ana’s handle with his name.                                                                                                             |
| 9     | Pass                          | Five-paragraph clipboard event added five blocks. From 3,998 characters, ABCDE stopped at AB, exactly 4,000, with the counter. At 598 blocks, five-paragraph paste was refused whole with the expected message; count remained 598.                                                             |
| 10    | Pass                          | Convex CLI before/after snapshots show identical rev/text for all eight kinds after focus and blur without typing.                                                                                                                                                                              |
| 11    | Pass via static fallback      | 600 rendered blocks, zero contenteditable editors, 592 static text surfaces plus eight dividers. First screen inspected. No claim of a measured sub-500-ms paint.                                                                                                                               |
| 12    | Pass                          | At 390 px the handle and Ben Tester is editing badge are visible together. All eight slash choices fit; selecting To-do produced a checkbox.                                                                                                                                                    |

### Block-kind and key details

The slash menu created heading, paragraph, listItem, todo, numberedItem,
quote, code and divider. Markers `# `, `- `, `[] `, `1. `, `> `, three
backticks and `---` produced their documented kinds. Paragraph has no
markdown marker. Enter at the end of heading/paragraph created paragraph;
listItem/todo/numberedItem/quote continued their kind. Mod+Enter exited code
to paragraph; Enter on a divider created paragraph. Neither a heading nor
a divider is supposed to continue as another heading/divider at its end.
Backspace at the start converted listItem, todo, numberedItem, quote and code
to paragraph; the top heading also became paragraph. Paragraph merge was
verified in the comment test. Empty list/to-do/numbered/quote Enter became
paragraph; Enter at heading start added an empty heading above. Code Enter
stored `first\nsecond`. `/divider` on text preserved the original and added
a divider below; Backspace at the following paragraph removed that divider.

### Scope and evidence quality

Browser actions used separate authenticated Playwright contexts for Ana and
Ben. Backend calls only created fixtures, added the two missing agents, and
read test-room evidence. Split, merge, restore, scribe start/stop, model
prompts, typing, paste and reorder were driven through the deployed UI.
Comment split/merge used a backend-created comment fixture; commenting during
the scribe was driven through the UI. Paste used a browser ClipboardEvent
with text/plain rather than the system clipboard.

Early scratch-driver failures were rerun. In particular, selecting a new
agent before the previous send settled redirected two initial requests to
Claude; Claude declined to impersonate the other agents. Repeated requests
with a settled send reached Codex and Pi, confirmed by participant ids and
successful tool calls. Those initial requests do not count as agent passes.

## Operational notes and artifacts

Password sign-in for both accounts required new-device email verification.
The authorized Clerk sign-in-token fallback succeeded with both
`__clerk_ticket` and `__clerk_status=sign_in` on the app root. A ticket without
that status selects Atelier's sign-up form.

Scripts and screenshots are in `/tmp/editor-live-probe`. Storage states are
`~/.atelier/Ana-editor-state.json` and `~/.atelier/Ben-editor-state.json`, mode 600. Credentials were read inside scripts, never printed or passed as command
arguments. Test fixtures, comments and model turns remain in the throwaway room.
No application code, deployment or runner configuration was changed. The room
is left at 600 blocks for reproducing the capacity/fallback checks. Both agents
added for testing remain in the room. No real rooms or Robert’s account were used.

The only incomplete observation is Claude identifying the editor from a fresh
large `read_document` result, blocked by F2. The two-person lock itself and
all three agents’ refusal/retry paths were exercised. The 500-ms timing
alternative was not needed because the specified static fallback was observed.
