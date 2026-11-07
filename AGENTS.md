# Atelier agent instructions

Read [LEARNINGS.md](LEARNINGS.md) at the start of every session, before running
commands or changing code. It records operational fixes and testing details
that are easy to lose between sessions.

Read [docs/v0-spec.md](docs/v0-spec.md) for the architecture and build order.
Follow any additional AGENTS.md instructions in the directories you change.

This project runs on an exe.dev VM. Use only documented exe.dev features:
https://exe.dev/docs.md and https://exe.dev/docs/proxy.md. Undocumented local
endpoints are internal infrastructure and must not be used.

## Quality tooling

Run these from the repo root:

- `pnpm check`: Ultracite (oxlint with type-aware rules, and oxfmt) plus
  Knip for unused files, exports and dependencies.
- `pnpm fix`: applies the safe lint fixes and formats.
- `pnpm typecheck` and `pnpm test`: every workspace, through turbo. Tests
  use vitest everywhere.
- `pnpm coverage`: per-workspace coverage reports under each `coverage/`.
- `pnpm --filter @atelier/runner test:integration`: the smoke tests that
  drive the real pi and codex CLIs. They are kept out of `pnpm test`.

Hooks run these for you:

- Claude Code and Codex run `ultracite fix --hook` on every file they edit.
  Problems it cannot fix come back to the agent; fix them before moving on.
- The lefthook pre-commit hook formats and safe-fixes staged files.
- The pre-push hook runs `pnpm check`, then typecheck and unit tests, and
  blocks the push if any of them fail.

Never bypass the hooks (`--no-verify`, `LEFTHOOK=0`) and never weaken a lint
rule to make a check pass. A rule may be disabled on one line only with a
reason after `--`, when the fix would change behavior.

Mobile tests cover pure modules in `apps/mobile/src/lib/`. They must not
import `react-native` or Expo modules, which vitest cannot parse.
