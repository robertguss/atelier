# Editor live findings (2026-11-08)

Partial browser pass against https://atelier-mu-seven.vercel.app, checkout
`da3a335`, Convex dev and the existing exe-vm runner. Only Ana Tester, Ben
Tester and Editor live check (`kh72qzwtxkzj7vpmjzm8c12std8ht8a8`) were used.
This report does **not** complete the verification contract or approve the editor.

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

## Passed subchecks

- Both test accounts authenticated, accepted their invitations and entered the
  room after the disclosure. Separate browser contexts and private storage
  states were used.
- Clicking a nonempty block and typing worked without an Edit button. Ben
  saw “Ana Tester is editing” during Ana's typing. The edited text persisted
  after blur and appeared in Ben's context. Exact badge latency was not timed.
- Enter at the end of a heading created a paragraph.
- Typing `/` in a fresh paragraph displayed all eight kinds in the menu.
- At 390 px the document fit and a focused block's drag handle was visible.
- Static block rendering was observed, but not with 600 blocks.

## Verification contract status

| Check | Status  | Remaining evidence                                                         |
| ----- | ------- | -------------------------------------------------------------------------- |
| 1     | Partial | Exact badge timing and history grouping/counts                             |
| 2     | Not run | Simultaneous two-person acquisition and draft recovery                     |
| 3     | Partial | Complete eight-kind shortcut/menu/continuation and Backspace matrix        |
| 4     | Not run | Comments on split/merge, history and ticked restore                        |
| 5     | Not run | Parked caret, scribe read-only/comment/stop behavior                       |
| 6     | Not run | Claude, Codex and Pi writes and digests                                    |
| 7     | Not run | Same-person stale-tab save                                                 |
| 8     | Not run | Drag/keyboard reorder and held-block refusal                               |
| 9     | Not run | Paste, character limit and 598-block refusal                               |
| 10    | Not run | All-kind rev/text comparison through Convex CLI                            |
| 11    | Partial | Static rendering observed only on the small fixture; no load budget result |
| 12    | Partial | Narrow handle visible; badge and menu usability unverified                 |

The pass remained incomplete while the scratch browser driver was being
stabilized around empty-block activation and slash-menu selection. Those
script timeouts are not evidence that the untested editor features fail.
No external prerequisite was established that makes the remaining checks
impossible; they still need a follow-up run. The room initially exposed only
Claude in the agent pane; Codex and Pi were not configured during this pass.

## Operational notes and artifacts

Password sign-in for both accounts required new-device email verification.
The authorized Clerk sign-in-token fallback succeeded with both
`__clerk_ticket` and `__clerk_status=sign_in` on the app root. A ticket without
that status selects Atelier's sign-up form.

Scripts and screenshots are in `/tmp/editor-live-probe`. Storage states are
`~/.atelier/Ana-editor-state.json` and `~/.atelier/Ben-editor-state.json`, mode 600. Credentials were read inside scripts, never printed or passed as command
arguments. Test edits and empty paragraphs remain in the throwaway room.
No application code, deployment or runner configuration was changed.
