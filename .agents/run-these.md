# run-these in this repository

## Setup

Nothing beyond `AGENTS.md`. The package scripts install their own dependencies.

## Gate

`AGENTS.md` names the four checks to run before opening a pull request. From the repository root: `bun run test`, `bun run typecheck`, `bun run static` and `claude plugin validate plugins/pstack`.

## Live proof

`AGENTS.md`: every head needs its own `live-gate` commit status from the `verify-open-pstack` skill, whose rule picks the features. A docs-only path still needs a registry entry in that skill's `features/registry.json`, because an unmapped path fails closed.

## Review and merge

`AGENTS.md`: this repository lands on green once `verify` and `live-gate` pass and no review thread is unresolved. Mergify reads no `hold` label here; keep a pull request a draft to stop it landing. `.github/workflows/unfret-threads.yml` resolves Unfret's threads. Before posting `live-gate`, read the other reviewers' threads with `watch-pr --status-only`, then fix or answer each one and resolve it.

## Deploy or release

`AGENTS.md`: once every pull request merged since the previous release has an Unfret verdict on its merged head and each material finding has a merged fix-forward pull request, run `python3 scripts/release.py publish` from a clean checkout of `main`. Cut the release whenever merged changes are user-facing.

## Ticket states after merge

Work is tracked in this repository's GitHub Issues. The live proof comes before the merge here, so a merged pull request closes its issue. Confirm that each merged pull request closed its issue, or that its body says why it did not.

## Closeout

Records go in `~/projects/docs/projects/open-pstack/records/<YYYY-MM-DD>-batch-<first issue>/`.
