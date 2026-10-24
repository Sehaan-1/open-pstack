# Minimum-change plan: collapse `orch frontier set` to two data calls

Date: 2026-10-24. Scope: item 1 of
[`2026-10-24-performance-reliability-proposals.md`](2026-10-24-performance-reliability-proposals.md).
Single file of shipped code
(`plugins/pstack/skills/poteto-mode/scripts/orch/store.ts`) plus its colocated
test (`orch/orch.test.ts`). No CLI flags, exit codes, file formats, locks, or
documented contracts change. This is an internal subprocess-count refactor
with byte-identical `frontier.json` output.

## 1. Goal and measured subprocess accounting

`frontier.set` calls the module-private `resolveFrontier(repo, forge)`
(store.ts L1184). Today it discovers the PR base chain by asking the forge
about **one branch at a time** and resolves **one SHA at a time**.

For a linear stack of N PRs resolved from the tip branch, today's process
inventory is:

| Step | Current call | Count |
| --- | --- | --- |
| Trunk branch | `git symbolic-ref --short refs/remotes/origin/HEAD` (caught failure → `"main"`) | 1 |
| Current branch | `git symbolic-ref --short HEAD` | 1 |
| Down-walk to trunk | `branchPullRequest` → `<forge> pr list --head <b> --state all --json …` per branch | N |
| Up-walk to tip | `openChildren` → `<forge> pr list --base <b> --state all --json …` per visited branch (including the final empty answer) | N |
| Head SHAs | `branchSha` → `git rev-parse <b>` per chain PR | N |
| **Total** | | **3N + 2** |

The 4-PR test fixture (current branch is `stack/open`, not the tip) exercises
11 subprocesses: 2 symbolic-refs, 3 `--head` lists, 2 `--base` lists,
4 `rev-parse` calls.

Target inventory, independent of N:

| Step | Target call | Count |
| --- | --- | --- |
| Trunk + current branch | unchanged (local git, no network) | 2 |
| All PR rows | one repo-wide `<forge> pr list --state all [--limit 300] --json …` | 1 |
| All head SHAs | one `git rev-parse <b1> <b2> … <bN>` (verified: one SHA per line, argument order preserved; bad ref exits 128 and prints the ref name, which the hex check rejects) | 1 |
| **Total** | | **4, flat** |

The "two calls" in the proposal are the two N-scaled data fetches collapsing
to one forge call and one git call. The two constant local-git calls stay:
they never touch the network and carry no N scaling.

## 2. Systems view: invariants that must not move

The external contract is documented in
`playbooks/orchestrate.md` (L81): the command walks the PR base chain from the
checkout's current branch; chain order and PR states come from the forge; head
SHAs come from local branch refs; a branch with no PR errors rather than
guessing. The refactor must preserve, byte for byte:

1. The `Frontier`/`FrontierPr` shapes and `frontier.json` contents, including
   `generation` incrementing and `lowestUnmerged` semantics (untouched code).
2. Every `UserError` message currently reachable from `frontier set`, because
   tests and operator runbooks pin the strings:
   - `branch <b> has no pull request; open one with <forge> pr create, or resolve the frontier from a branch whose chain is fully submitted`
   - `branch <b> has multiple pull request (#a, #b); close the stale ones first`
   - `pull request base chain loops at branch <b>` (both walk directions)
   - `stack is not linear: branches <…> all target <tip>`
   - `pull request base chain contains duplicate pull requests`
   - `git rev-parse <b> returned an invalid SHA`
   - forge output labels `<forge> pr list … output is not valid JSON` / `… is not a JSON array` / `… output has an invalid PR row` (the command label inside these three is the **only** sanctioned string change).
3. Forge neutrality: the `gh`/`origin` field mapping in
   `FORGE_PULL_REQUEST_QUERIES`, including `origin`'s `draft` → `OPEN` state
   mapping and the rule that merged/closed PRs still anchor the down-chain.
4. The `--state all` semantics (a draft counts as `OPEN`; closed children are
   filtered out of the up-walk — fixture PR #15 proves this).
5. The early return `current === trunk → []` before any forge call.
6. Pin validation (`validateFrontierPin`), locking (`beginWrite`), and atomic
   write behavior — no edits anywhere near them.

Allowed to change: process count, argv shape of the forge/git calls, private
helper factoring, and the one command-label substring in three error strings.

## 3. Target design

### 3.1 One forge read, turned into an in-memory graph

Add a repo-wide read that reuses the existing row validator verbatim:

```ts
function listAllPullRequests(args: {
  readonly forge: Forge;
  readonly repo: string;
}): readonly ForgePullRequest[] {
  const query = FORGE_PULL_REQUEST_QUERIES[args.forge];
  const command = `${args.forge} pr list`;
  const argv: string[] = [
    "pr", "list",
    "--state", "all",
    ...(query.listLimit === undefined
      ? []
      : ["--limit", String(query.listLimit)]),
    "--json",
    ["number", query.stateField, query.headField, query.baseField].join(","),
  ];
  const raw = runTool({ command: args.forge, args: argv, repo: args.repo });
  // … identical JSON.parse / array / per-row validation as listPullRequests,
  // emitting `${forge} pr list output is not valid JSON` (and the array/row
  // variants) so the error class is unchanged.
}
```

`FORGE_PULL_REQUEST_QUERIES` gains one optional field:
`gh: { …, listLimit: 300 }`, `origin: { … /* no listLimit */ }`. Rationale:
`gh pr list` defaults to 30 rows, so the repo-wide read needs the explicit
cap (the same value `watch-pr/github.ts` already uses in
`openPullRequests`). The `origin` CLI cannot be exercised in this environment,
so its argv stays exactly what it accepts today minus the branch filter;
adding `--limit` there is a separately verified one-line follow-up rather than
an untested assumption.

Build two indexes once — O(rows), replacing every per-branch subprocess:

```ts
interface PrGraph {
  readonly byHead: ReadonlyMap<string, readonly ForgePullRequest[]>;
  readonly openByBase: ReadonlyMap<string, readonly ForgePullRequest[]>;
}

function buildPrGraph(rows: readonly ForgePullRequest[]): PrGraph {
  const byHead = new Map<string, ForgePullRequest[]>();
  const openByBase = new Map<string, ForgePullRequest[]>();
  for (const row of rows) {
    (byHead.get(row.branch) ?? byHead.set(row.branch, []).get(row.branch)!).push(row);
    if (row.state === "OPEN") {
      (openByBase.get(row.base) ?? openByBase.set(row.base, []).get(row.base)!).push(row);
    }
  }
  return { byHead, openByBase };
}
```

The two walk predicates become pure map lookups that throw the **existing**
messages:

```ts
function headPrFor(graph: PrGraph, branch: string, forge: Forge): ForgePullRequest {
  const rows = graph.byHead.get(branch) ?? [];
  const row = rows[0];
  if (row === undefined) {
    throw new UserError(
      `branch ${branch} has no pull request; open one with ${forge} pr create, ` +
        "or resolve the frontier from a branch whose chain is fully submitted"
    );
  }
  if (rows.length > 1) {
    throw new UserError(
      `branch ${branch} has multiple pull requests (${rows.map((item) => `#${item.pr}`).join(", ")}); close the stale ones first`
    );
  }
  return row;
}

const openChildrenOf = (graph: PrGraph, branch: string): readonly ForgePullRequest[] =>
  graph.openByBase.get(branch) ?? [];
```

### 3.2 One batched SHA read

Verified locally: `git rev-parse b1 b2 … bN` prints one full SHA per line in
argument order and exits non-zero when any ref is missing.

```ts
function parseRevParseLines(branches: readonly string[], raw: string): string[] {
  const lines = raw.trim().split("\n");
  if (lines.length !== branches.length) {
    throw new UserError(
      `git rev-parse ${branches.join(" ")} returned ${lines.length} SHAs for ${branches.length} branches`
    );
  }
  return lines.map((sha, index) => {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      // Also catches a missing ref: git echoes the ref name rather than a SHA.
      throw new UserError(`git rev-parse ${branches[index]} returned an invalid SHA`);
    }
    return sha;
  });
}

function branchShas(args: {
  readonly branches: readonly string[];
  readonly repo: string;
}): string[] {
  const raw = runGit({ args: ["rev-parse", ...args.branches], repo: args.repo });
  return parseRevParseLines(args.branches, raw);
}
```

### 3.3 `resolveFrontier` after the change

Same skeleton, same `seen` sets, same loop/non-linear/duplicate guards — only
the data source changes from subprocesses to the graph, and the final map
zips one batched SHA array:

```ts
function resolveFrontier(repo: string, forge: Forge): readonly FrontierPr[] {
  const trunk = trunkBranch(repo);
  const current = currentBranch(repo);
  if (current === trunk) return [];

  const graph = buildPrGraph(listAllPullRequests({ forge, repo }));

  const seen = new Set([current]);
  let bottom = headPrFor(graph, current, forge);
  const chain = [bottom];
  while (bottom.base !== trunk) {
    if (seen.has(bottom.base)) {
      throw new UserError(`pull request base chain loops at branch ${bottom.base}`);
    }
    seen.add(bottom.base);
    bottom = headPrFor(graph, bottom.base, forge);
    chain.unshift(bottom);
  }

  let tip = current;
  for (;;) {
    const children = openChildrenOf(graph, tip);
    const child = children[0];
    if (child === undefined) break;
    if (children.length > 1) {
      throw new UserError(
        `stack is not linear: branches ${children.map((row) => row.branch).join(", ")} all target ${tip}`
      );
    }
    if (seen.has(child.branch)) {
      throw new UserError(`pull request base chain loops at branch ${child.branch}`);
    }
    seen.add(child.branch);
    chain.push(child);
    tip = child.branch;
  }

  if (new Set(chain.map((row) => row.pr)).size !== chain.length) {
    throw new UserError("pull request base chain contains duplicate pull requests");
  }

  const shas = branchShas({ branches: chain.map((row) => row.branch), repo });
  return chain.map((row, index) => ({
    pr: row.pr,
    branches: row.branch,
    sha: shas[index]!,
    state: row.state,
  }));
}
```

### 3.4 Deletions

Delete `listPullRequests`, `branchPullRequest`, `openChildren`, and
`branchSha` (all private, each with a single call site inside
`resolveFrontier` — confirmed by grep). `runTool`, `runGit`,
`currentBranch`, `trunkBranch`, `FORGE_PULL_REQUEST_QUERIES`,
`validateFrontierPin`, and the `frontier.set` store method are untouched.

## 4. Test changes (`orch.test.ts`)

### 4.1 Rewrite the fake forge from five patterns to one

`withFakeForge` currently installs a bash fake matching five exact argv
strings and exiting 2 on anything else. Replace the `case` body with:

- one match for the new argv (`pr list --state all --limit 300 --json …` for
  `gh`; no `--limit` token for `origin`), emitting the **union** of today's
  five fixtures as one array (PRs #10, #11, #13, #14, #15);
- an invocation counter: append a byte to `$directory/forge-calls` on each
  match;
- the existing `*) exit 2` arm stays, which mechanically proves no
  per-branch `--head`/`--base` call survives the refactor.

The `currentRows` override mechanism (malformed string, `[]`) is reused
unchanged — it now feeds the single repo-wide command.

### 4.2 Assertion updates

| Test | Change |
| --- | --- |
| `resolves the ordered frontier … and validates an optional pin` (runs per forge) | Expected `frontier.json` and all pin-mismatch strings: **no changes**. Add: after each `frontier.set`, read `forge-calls` and assert exactly one forge invocation per call (two calls → counter equals 2). |
| `rejects unparseable <forge> output loudly` | Expected string becomes `` `${forge} pr list output is not valid JSON` `` (the old label named `--head stack/open`). |
| `names the missing pull request when a chain branch has none` | No string change: repo-wide `[]` still makes `headPrFor` throw `branch stack/open has no pull request; open one with gh pr create …`. |

### 4.3 New behavior tests (all driven through the same fake + real git fixture)

1. **Multiple PRs on one head branch** — two rows with
   `headRefName: stack/open`; assert the existing multi-PR error text.
2. **Non-linear stack** — two `OPEN` rows targeting `stack/open` (plus any
   closed one, which must be ignored); assert the existing
   `stack is not linear` text and branch list order.
3. **Base-chain loop** — rows whose bases cycle without reaching trunk;
   assert `pull request base chain loops at branch …` from the down-walk, and
   a second fixture for the up-walk variant.
4. **Invalid forge row** — a row missing `baseRefName`; assert
   `<forge> pr list output has an invalid PR row`.
5. **Batched SHA failure** — delete the local `stack/merged` ref before
   `frontier.set`; assert a loud `UserError` (git 128 wrapped by `runTool`, or
   the invalid-SHA message), proving the one batched `rev-parse` still fails
   closed per branch.
6. **Trunk short-circuit** — checkout `main` in the fixture repo; assert `[]`
   and that `forge-calls` was never created (zero forge traffic).
7. **Forge argv contract** — the fake's strict match already encodes this;
   add an explicit assertion that the `origin` fake never receives a
   `--limit` token while the `gh` fake requires one.

### 4.4 Why no exported helper unit test

`store.ts` exports only its public store API; the new pure helpers stay
private to match that convention. `parseRevParseLines` and the graph lookups
are covered through the store-level behavior tests above (including the
missing-ref and no-PR paths), which exercise the same branches. If reviewers
prefer direct unit tests, the fallback is extracting the frontier walk into a
sibling `frontier.ts` — explicitly rejected here as a larger structural diff
that the minimum change does not need.

## 5. Failure-mode matrix

| Condition | Before | After | Behavior delta |
| --- | --- | --- | --- |
| Forge CLI missing / non-zero exit | `runTool` wraps as `UserError` | Same wrapper, new argv | None (loud, non-zero) |
| Malformed / non-array / bad row JSON | Per-branch command label | Repo-wide command label | Label string only |
| Chain branch has no PR | Named-branch error | Same error from map lookup | None |
| Two PRs on one head | Multi-PR error | Same | None |
| Two OPEN children | Non-linear error | Same; closed child still filtered | None |
| Base-chain loop | Loop error, both directions | Same `seen` logic | None |
| Duplicate PR numbers in chain | Duplicate error | Same | None |
| Missing local branch ref | Per-branch `rev-parse` 128 | Batched 128 + per-line hex guard naming the branch | Still loud, still names branch |
| Current branch is trunk | `[]`, no forge traffic | Same early return | None |
| Repo with >30 open PRs | Old `gh` calls silently capped at 30 rows each | Explicit `--limit 300`; documented bound | Strictly more correct |
| `origin` lacks `--limit` | n/a | Flag omitted via `listLimit` field | No argv assumption |
| Unrelated PRs in repo | Never fetched (branch filter) | Fetched, ignored by graph walk | Output identical; only payload wider, bounded at 300 rows × 4 fields |

## 6. Verification gates and rollback

1. `bun test` for the orch suite, then the full parallel script
   (`bun run test` from `scripts/`): `bootstrap orch watch-pr runner check-plan resolve-codex-transcript`.
2. `bun run typecheck` and `bun run static` from the repository root. Note
   orch has no dedicated `tsconfig.json` and is not in the `tsc` script;
   `bun test` is its type gate — keep the new code strict-clean regardless.
3. Process-count proof on Linux (manual, in a scratch clone with the fake
   forge on `PATH`): `strace -f -e trace=execve -o /tmp/trace <bun orch …>`
   and confirm exactly four execve events (2 git, 1 forge, 1 git) versus
   eleven on the current build with the same fixture. The durable guard in CI
   is the fake's invocation counter plus its exit-2 arm.
4. Live gate per `AGENTS.md`: this changes shipped tooling, so the
   `verify-open-pstack` frontier recipe runs against the installed exact-head
   candidate on the Darwin verifier and publishes `live-gate`; the changed
   behavior is `orch frontier set` producing the same `frontier.json` from
   the fixture stack.
5. Add a `CHANGES.md` entry at release time (internal performance fix, no
   user-facing behavior change) and open the tracking issue first, per
   `AGENTS.md`'s "track all durable work in GitHub Issues".
6. Rollback is one revert: no persisted format, schema, or on-disk state
   changes; `frontier.json` written before and after is byte-identical for the
   same forge state.

## 7. Explicit non-goals

- No change to `frontier.json` schema, generation rules, CLI arguments,
  exit codes, locking, or the pin syntax.
- No batching of the two `symbolic-ref` calls (constant cost, local, and
  `trunkBranch` carries a try/catch fallback that a combined call would
  complicate).
- No GraphQL migration, no new dependency, no change to `watch-pr` (its own
  batching is proposal item 2).
- No change to `origin`'s argv beyond removing the branch filter until the
  `origin` CLI's `--limit` support is verified on a host that has it.
- No concurrency or promise work: the function stays synchronous, matching
  `execFileSync` and the store's existing write-path style.

## 8. Sequenced implementation checklist

1. Issue: open the tracking issue describing the 3N+2 → 4 subprocess collapse
   and linking this plan. (15 min)
2. `store.ts`: add `listLimit` to the query map; add
   `listAllPullRequests`, `PrGraph`/`buildPrGraph`, `headPrFor`,
   `openChildrenOf`, `parseRevParseLines`, `branchShas`; rewrite
   `resolveFrontier`; delete the four old private functions. (~2–3 h)
3. `orch.test.ts`: single-command fake with call counter; update the one
   malformed-output string; add the seven tests in §4.3. (~2–3 h)
4. Run the gates in §6.1–6.2; diff a fixture `frontier.json` before/after to
   prove identical bytes. (30 min)
5. PR using the repository template, marking the live-gate checkboxes as
   pending the verifier run; reference the issue and this plan. (20 min)

Estimated diff: ~110–130 lines changed in `store.ts` (net fewer), ~90–110 in
`orch.test.ts`. One focused PR, no follow-up required except the optional
`origin --limit` verification.
