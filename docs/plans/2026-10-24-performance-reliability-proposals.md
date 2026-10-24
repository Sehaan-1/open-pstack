# Performance and reliability proposals — 2026-10-24

Review of `main` at `b4c5e3d` (Open Pstack 1.16.0). Scope is limited to the
shipped local tooling under `plugins/pstack/skills/poteto-mode/scripts/` and
`plugins/pstack/hooks/`. No new features, UI, or changes to pstack's skill
content are proposed. Every item targets latency, redundant I/O/subprocess and
network calls, memory bounds, or failure-mode correctness. Items are ordered by
return on investment: smallest/safest first, largest refactor last.

## Evidence base (measured and inspected in this checkout)

- `orch/store.ts` `resolveFrontier()` walks a stack with one `gh pr list`
  subprocess **per branch** (head lookup, then base lookup) plus one
  `git rev-parse` **per PR**, all synchronous (`execFileSync`) and serial.
- `watch-pr/policy.ts` `readSnapshot()` issues a minimum of **four cold `gh`
  subprocesses per PR per poll** (`gh pr view`, paginated review-thread
  GraphQL, `gh pr checks` or paginated rollup GraphQL, commit-rollup GraphQL).
  `runSimple()` polls stack PRs with a serial `for...of`, and `runQueued()`
  sweeps one `readSnapshot` at a time. Default cadence is 60 s / 300 s.
- A local `gh api rate_limit` call in the review sandbox took ~0.3 s wall for
  one authenticated round trip; real `gh pr view`/`graphql` calls carry the
  same process spawn plus auth resolution plus HTTPS cost.
- `runner/run.ts` `captureStream()` accumulates the **complete** child
  stdout/stderr as JS strings while also writing them to reserved sidecar FDs.
  Five adapters (`grok`, `agy`, `amp`, `opencode`, `cursor`, `dsh`) then call
  `stdout.split("\n")` plus per-line `JSON.parse`, building a second full copy
  plus an event array. Receipt evidence is capped at 4,000 chars
  (`types.ts` `ERROR_EVIDENCE_LIMIT`), and `devin` already parses from a
  sidecar file instead of the in-memory string.
- Every external runner lane spawns a provider preflight subprocess
  (`claude auth status --json`, `grok models`, `amp usage`, `agy models`, …)
  before the model call, with no sharing across the parallel lanes of a panel.
- `orch/store.ts` lock liveness is PID-only (`process.kill(pid, 0)`), and
  `status.render()` awaits four file reads serially; `readPointers()` awaits
  each inbox file serially.

---

## 1. Collapse `orch frontier set` from ~3N subprocesses to 2 calls

**Effort: S · Risk: low · Files: `orch/store.ts`, `orch.test.ts`**

### What & Why

`resolveFrontier()` (store.ts, ~L1178–1230) reconstructs a PR stack by calling
`branchPullRequest()` → `gh pr list --head <branch>` once per branch on the
base chain, `openChildren()` → `gh pr list --base <branch>` per tip, and
`branchSha()` → `git rev-parse <branch>` once per chain PR. For a stack of N
branches that is ~2N `gh` invocations plus N git invocations, each `gh` call
being a cold process with its own network round trip, all serial and
synchronous. A ten-branch stack can spend tens of seconds in process/network
latency before `frontier set` writes one small JSON file.

The codebase already contains the cheaper pattern: `watch-pr/github.ts`
`openPullRequests()` fetches up to 300 open PRs in **one** `gh pr list` call,
and `FORGE_PULL_REQUEST_QUERIES` already abstracts the `gh` vs `origin` field
names that a single multi-field query needs.

### Open-Source Precedent

- **git-spice** ([abhinav/git-spice](https://github.com/abhinav/git-spice),
  779★) keeps branch relationships as local state and builds the stack graph
  in memory instead of issuing one forge query per branch; network calls happen
  only at submit/sync boundaries.
- **cc-context PR #196** (merged, [yasyf/cc-context#196](https://github.com/yasyf/cc-context/pull/196))
  replaced per-branch REST lookups with batched reads of up to 40 branches per
  query after parallel lanes exhausted a shared token's REST budget.
- **Graphite's `gt submit --stack`** submits a whole stack from one in-memory
  graph rather than per-branch PR reads
  ([graphite.com/docs/create-submit-prs](https://graphite.com/docs/create-submit-prs)).

### Expected Impact

- Subprocess count for a N-branch frontier resolution: ~3N → **2** (one
  `pr list --state all --json number,state,headRefName,baseRefName`, one
  `git rev-parse branch1 branch2 …` which accepts multiple refs and prints one
  SHA per line), independent of stack depth.
- Wall time dominated by a single network round trip instead of 2N; deep
  stacks (the documented autopilot/orchestrate use case) see the largest gain.
- REST/GraphQL quota burn and `gh` auth-token resolutions cut by the same
  factor, which also removes a plausible secondary-rate-limit failure mode.
- Behavior and error contracts (loop detection, non-linear stack, multiple PRs
  per branch, pin validation) are preserved by reusing the existing checks on
  the in-memory graph.

### Implementation Plan

1. Add `listAllPullRequests(repo, forge)` issuing one `pr list --state all`
   with `number`, state, head, base fields via the existing
   `FORGE_PULL_REQUEST_QUERIES` mapping (merged/closed rows stay visible — the
   current comment already states they still anchor the chain).
2. Build `head → row` and `base → rows` maps in memory. Re-implement
   `resolveFrontier()` as the same walk (base chain to trunk, then children to
   tip) over those maps, keeping the exact `UserError` messages for loops,
   duplicate PRs, and non-linear stacks.
3. Replace per-PR `branchSha()` calls with one multi-ref `git rev-parse`
   invocation, mapping output lines back to branches by argument order; keep
   the 40/64-hex SHA validation.
4. Keep `trunkBranch`/`currentBranch` (two local git calls, no network) as-is.
5. Extend `orch.test.ts` with the existing fixture-repo style covering: linear
   chain, branching/loop rejection, merged anchor, `origin` forge field
   mapping, and pin mismatch — asserting the number of spawned forge/git
   processes with a fake runner so the N+1 regression cannot return.

---

## 2. Batch `watch-pr` polling into one aliased GraphQL sweep per cycle

**Effort: M · Risk: medium · Files: `watch-pr/github.ts`, `policy.ts`,
`types.ts`, `github.test.ts`, `policy.test.ts`**

### What & Why

Each `readSnapshot()` (policy.ts L59) runs, per PR: `gh pr view`; review
threads through one or more paginated `gh api graphql` calls; checks via
`gh pr checks` with a GraphQL rollup fallback; and commit rollups via another
GraphQL call (always, because `runSimple` passes `pendingHistory: "include"`).
`runSimple()` then loops stack PRs serially (L427–435), and the queued runner's
whole-stack sweeps are serial too (L742). A five-PR stack therefore spawns
20+ cold `gh` processes every 60 seconds, each with its own HTTPS round trip,
and pays GitHub per request against both the GraphQL point budget and the
secondary per-minute request limits (max 100 concurrent; 2,000 GraphQL
points/min per
[GitHub's rate-limit docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

### Open-Source Precedent

- **diri PR #551** (merged, [cristicretu/diri#551](https://github.com/cristicretu/diri/pull/551))
  replaced per-PR sweeps with one aliased GraphQL request per host (chunks of
  25). Measured on 26 open PRs: **26–52 `gh` processes and 27.6–45.8 s wall →
  2 processes and 4.2–5.9 s**, with GraphQL point cost collapsing to roughly
  one request's cost. Failed batches fall back to the per-PR path.
- **Sotto PR #827 / issue #820** (merged,
  [millZach/Sotto#827](https://github.com/millZach/Sotto/pull/827)): aliased
  `pullRequests(headRefName:)` lookups, max 25 per query, variables (not string
  interpolation) for branch names, coalesced reads, and answer TTLs keyed by how
  fast state changes (open PR 60 s, merged/closed 15 min; failures uncached).
- **firstmate PR #66** (merged,
  [gsp-agent/firstmate#66](https://github.com/gsp-agent/firstmate/pull/66)):
  one aliased `pullRequest` field per PR per sweep, plus reading cheap fields
  first and fetching `statusCheckRollup` only while the PR is open and
  otherwise mergeable.
- **cc-context #196** keeps a REST fallback for GraphQL rate-limit refusals,
  and **pr-dashboard #2**
  ([anneodonovan/pr-dashboard#2](https://github.com/anneodonovan/pr-dashboard/pull/2))
  caps in-flight batches at three and adds exponential backoff.

### Expected Impact

- For an N-PR stack: ~4N `gh` processes per cycle → ~1–2 (one aliased document
  per chunk of 10–25 PRs, plus the retained `gh pr checks` fast path where it
  wins). The diri measurements imply roughly a 5–8× wall-time reduction per
  sweep and proportionally less CPU, token resolution, and quota use.
- Fewer serial round trips make the 60 s poll interval reliable on slow
  networks, where a deep stack can currently take longer to read than the
  interval itself.
- Pagination stays inside the single document (first/after cursors per alias),
  and per-alias nulls let one missing PR fall back without failing the batch —
  the t3code lesson from
  [pingdotgg/t3code#19224](https://github.com/pingdotgg/t3code/pull/19224).

### Implementation Plan

1. Extend the `GitHubReader` interface with `snapshotBatch(contexts)` that
   sends one `gh api graphql` document using aliases
   (`pr1: pullRequest(number: $n1) { … }`), passing every number/owner as an
   `-F`/`-f` variable. Select the union of fields currently read by
   `pullRequest()`, `resolveReviewThreads()`, `resolveChecks()` rollup, and
   `commitRollups()`, with `rateLimit { remaining resetAt }` attached (zero
   extra cost) to drive backoff.
2. Decode each alias into the existing `PullRequestFacts`/thread/check/rollup
   shapes behind the current parsers, so classification in `policy.ts` is
   byte-identical. Keep `GhGitHubReader`'s per-PR methods as the fallback for:
   a null alias, a document-level error, a pagination overflow, or a
   rate-limit refusal, with at most two fallback reads per cycle.
3. In `runSimple`, replace the serial loop with one batched read; in
   `runQueued`, batch the whole-stack sweep while keeping frontier-only polls
   on the single-PR path. Bound concurrency at 2–3 chunks.
4. Honor `Retry-After`/secondary-limit responses through the existing
   `WatcherQueryError` retryable path and `queryBackoffSeconds`, and add a
   GraphQL-cost assertion test using GitHub's `rateLimit(dryRun: true)`
   pattern documented in the query-limit guide.
5. Tests: fixture-driven alias documents (mirroring today's `fixtures/`
   approach) covering merged/closed early returns, null aliases, paged
   threads/checks, and fallback invariance; add a process-count assertion like
   proposal 1.

---

## 3. Harden the orch lockfile and parallelize its file reads

**Effort: S · Risk: low–medium · Files: `orch/store.ts`, `orch.test.ts`**

### What & Why

Two distinct issues in the plain-file store:

1. **Reliability.** `holderIsDead()` decides liveness with
   `process.kill(pid, 0)` alone. After a hard crash or machine restart, PID
   reuse makes an unrelated live process appear to own the lock (the store
   then refuses to start until a human deletes `.orch.lock`), and the
   `--force` takeover is a check-then-`unlink`-then-create window in which two
   processes can both believe they hold the lock.
2. **Latency.** `status.render()` awaits four independent file reads serially
   (L1611–1614) and `readPointers()` awaits each inbox pointer file one at a
   time (L570–590). Every `orch` invocation is already a fresh Bun process, so
   needless serial fsync/read latency lands directly on every command.

### Open-Source Precedent

- **Astro #17671** ([commit 09f0dc7](https://github.com/withastro/astro/commit/09f0dc7f90ef92f8520e13b7ba130e4b8aad31bd))
  fixed the identical PID-reuse bug by recording the kernel process start time
  alongside the PID and verifying both.
- **proper-lockfile** ([moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile),
  285★) uses an `O_EXCL`/mkdir lock plus an mtime heartbeat and staleness
  threshold instead of trusting a PID.
- **s3lite issue #1** ([0-AI-UG/s3lite#1](https://github.com/0-AI-UG/s3lite/issues/1))
  documents the permanent "database is locked" failure that PID-only stale
  detection produces on persistent volumes; its first recommended remedy is
  kernel-advisory locks, with boot-id + start-time as the portable fallback.
- **agent-control-stack #398** (merged,
  [jnibarger01/agent-control-stack#398](https://github.com/jnibarger01/agent-control-stack/pull/398))
  moved to `flock(1)` so the kernel releases the lock on holder death. Note:
  macOS ships no `flock(1)` in its base install and this tooling must run on
  both macOS and Ubuntu, so the start-time/heartbeat design is the portable
  choice here; `flock` could be an optional fast path on Linux.

### Expected Impact

- Eliminates a wedged-store failure mode that currently requires manual
  intervention, and closes the double-holder takeover race — important because
  orch coordinates concurrent agent lanes whose writes must not interleave.
- `status render` and inbox drains approach the latency of the slowest single
  read instead of the sum (four small files today; grows as the store
  accumulates units, ledger rows, and pointers).
- No on-disk format change for the TSV/Markdown/JSON data files; only the lock
  file content gains fields, with old PID-only locks treated as stale once
  their PID is dead exactly as today.

### Implementation Plan

1. Write the lock as JSON `{ "pid", "ppid", "startedAt", "hostname",
   "updatedAt" }`; derive `startedAt` from `/proc/<pid>/stat` on Linux and
   `ps -o lstat=` (or `sysctl`-free `ps`) on macOS, behind one small
   platform module with tests faking both.
2. `holderIsDead` returns dead only when the PID is gone **or** the recorded
   start time differs. Add an mtime heartbeat while a long-lived store handle
   is held (the orch CLI is short-lived, so this primarily protects future
   long-running callers), and make takeover re-read the lock immediately
   before unlink, claiming it via a unique claim file so a fresh lock is never
   removed (the worklane #20 pattern).
3. Wrap the four `status.render` reads in `Promise.all`, and `readPointers`'
   per-file reads in `Promise.all` over the sorted `readdir` result (order is
   re-established after reading, so output is unchanged).
4. Tests: PID reuse (live PID, mismatched start time → stale), live holder
   with matching start time → refused, concurrent takeover simulation, and a
   golden-file test that parallel-read output equals serial-read output.

---

## 4. Add a short-TTL, positive-only preflight cache for runner lanes

**Effort: M · Risk: medium (security-sensitive path) · Files:
`runner/run.ts`, new `runner/preflight-cache.ts`, `runner/types.ts`,
`run.test.ts`, provider adapter tests**

### What & Why

`executeLane()` runs every adapter's authentication/model preflight
(`claude auth status --json`, `grok models`, `amp usage`, `agy models`, …) as a
subprocess before every model call. A panel fans out several lanes — often
repeating the same provider — as independent runner processes, so the same
login/model probe is paid repeatedly within seconds: one cold CLI startup (and
for some providers, a network call) per lane, before any model work begins.

### Open-Source Precedent

- **AWS SDK credential providers**
  ([@aws-sdk/credential-providers](https://www.npmjs.com/package/@aws-sdk/credential-providers),
  [Go SDK credentials](https://docs.aws.amazon.com/sdk-for-go/api/aws/credentials/))
  memoize a successful retrieval until a TTL, share one refresh between
  concurrent callers, and never serve a cached failure as success — the
  canonical "probe once, reuse briefly" pattern.
- **Sotto #820** caches positive answers with state-dependent TTLs (open PR
  60 s, settled 15 min) and explicitly never caches failures.
- **Apache Iceberg #17789** keys its cached supplier by the full request
  context so different credentials/tables never share an entry, with a
  60-second default TTL.

### Safety Constraints (non-negotiable for this codebase)

The runner's loud-dropout, no-fallback, allowlist-env contracts must not
weaken. The cache therefore:

- caches **only `passed` verdicts** — any failure, inconclusive result,
  timeout, or cancellation always runs live and is never written;
- is keyed by provider id, executable realpath, preflight argv, the lane's
  model id, and a fingerprint of the effective child environment (the
  allowlist/drop policy output of `childEnvironment()`), so a different
  credential or PATH can never reuse an entry;
- lives only in the per-user OS temp/cache directory with `0600` files written
  via the existing temp-file-plus-rename atomic pattern, with a short TTL
  (proposed 60 s, configurable only downward via env);
- is bypassed by `setup-pstack` probes and when `PSTACK_NO_PREFLIGHT_CACHE` is
  set, and concurrent lanes tolerate a missing/stale entry by simply probing;
- records both `argv` and a `cached: true` marker plus the original probe
  timestamp in the receipt's preflight block (a schema-versioned additive
  field), so evidence still shows exactly what was and was not executed.

### Expected Impact

- A K-lane panel with P distinct providers runs P preflight processes instead
  of K, removing seconds-to-tens-of-seconds of cold CLI startup from fan-out
  latency and cutting redundant auth API traffic that can itself hit provider
  rate limits.
- No change to model execution, receipts on failure, or the "never substitute
  a weaker model" guarantee — this only deduplicates a liveness probe.

### Implementation Plan

1. Add `preflight-cache.ts` with `read(key)`/`write(key, verdict)` over
   `os.tmpdir()/pstack-preflight/<hash>.json`, TTL and mtime checks, and
   corruption-tolerant reads (any parse error → cache miss, never a throw).
2. In `run.ts`, after lane resolution and environment construction, compute the
   key and consult the cache only for the authenticated-model preflight (the
   shared-git-dir guard and any adapter `guard` stay live, since they depend on
   cwd-specific filesystem state). On a hit, populate the receipt preflight
   block with the cached evidence and marker; on a miss, run the existing path
   and persist only a pass.
3. Keep the existing unauthenticated one-retry flow entirely on the live path.
4. Tests: hit/miss/expiry, env-fingerprint mismatch forces live, failure is
   not cached, concurrent first-writer-wins, cache-file tamper → miss, receipt
   marker presence/absence, and a setup-probe bypass test. Update
   `provider-dispatch.md` to document the cache and its opt-out.

---

## 5. Bound runner memory: stream child output to sidecars with ring-buffer tails

**Effort: L · Risk: medium · Files: `runner/run.ts`, provider `parse`
contracts, all `providers/*.ts`, `run.test.ts`, adapter fixtures**

### What & Why

`captureStream()` (run.ts L218–244) holds the complete stdout and stderr of
every model child in memory while simultaneously streaming those bytes to the
reserved `.stdout`/`.stderr` sidecar files. On success the JSONL adapters then
call `stdout.split("\n")` and per-line `JSON.parse`, producing a second full
string copy and an array of every event even though only the terminal event
and usage metadata are retained. The project documents 90-minute writer lanes;
multi-megabyte JSONL turns therefore create a heap footprint several times the
output size for no behavioral gain — the full bytes already exist on disk, and
failure evidence is capped at 4,000 characters.

### Open-Source Precedent

- **sumocode PR #524** (merged,
  [dhruvkelawala/sumocode#524](https://github.com/dhruvkelawala/sumocode/pull/524))
  replaced `execFile` buffering with spawn streaming plus a bounded 64 KiB
  tail per stream and a truncation notice, eliminating
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` kills on verbose commands.
- **Node.js child-process guidance**
  ([nodejs.org/api/child_process](https://nodejs.org/api/child_process.html)):
  `spawn` streams output as produced precisely because `exec`-style full
  buffering is unsuitable for long-running or large-output processes.
- This repository already proves the end-state pattern: the **Devin adapter
  parses from the exported sidecar file** (`run.sidecar`) rather than from an
  accumulated string.

### Expected Impact

- Peak runner heap becomes independent of child output length: during a run
  only two fixed-size tails (sized to `ERROR_EVIDENCE_LIMIT` plus headroom)
  stay resident; the sidecars remain the complete, byte-exact record.
- Removes the OOM-kill class on long writer lanes and on providers that emit
  verbose tool-event streams, and reduces GC pressure on every lane (the
  streaming path also stops decoding bytes twice).
- Outputs, receipts, status codes, and cancellation/timeout behavior stay
  identical; the change is internal to capture and parsing.

### Implementation Plan

1. Introduce a `TailBuffer` that keeps the newest N bytes per stream with a
   truncation marker, and make `captureStream` write chunks to the sidecar FD
   (as today) while feeding only the tail — drop the unbounded `text +=`
   accumulation.
2. Change the `ChildRun` parse contract to expose either (a) an incremental
   JSONL line sink for the six line-oriented adapters (`grok`, `agy`, `amp`,
   `opencode`, `cursor`, `dsh`), keeping only the latest terminal/usage event
   as lines arrive, or (b) a one-time read of the completed sidecar file for
   document-shaped outputs (Claude's terminal JSON object/array), read once at
   exit instead of held for the whole run. Devin's existing sidecar path
   becomes the uniform mechanism.
3. Feed failure classification (`modelFailureStatus`, evidence strings) from
   the tail buffers, preserving the 4,000-character evidence contract and the
   exact receipt fields.
4. Reuse every existing provider fixture (including the sigint/sigterm and
   malformed-stream cases) with golden assertions that receipts and parsed
   metadata match current output byte-for-byte; add a multi-megabyte synthetic
   stream test asserting bounded heap (via `process.memoryUsage()` deltas) and
   complete sidecar contents.

---

## Out of scope / deliberately not proposed

- No new skills, commands, UI, dashboards, or providers.
- No change to model fallback/dropout semantics, sandbox policy, or the
  allowlist environment contract.
- No migration off Bun or the plain-file orch storage format; a SQLite-backed
  store was considered (the repo already uses `bun:sqlite` in
  `resolve-codex-transcript`) but rejected as a larger, format-breaking bet
  whose gains are mostly captured by items 1 and 3.
- `resolve-codex-transcript` opens at most eight bounded, read-only SQLite
  indexes per call; its budgets (`MAX_INDEXES`, 2 MiB read cap) already make
  this a non-issue, so it is untouched.

## Suggested sequencing

1. Item 1 (frontier N+1) — isolated, high ratio, no new state.
2. Item 3 (lock hardening + parallel reads) — small, local, independently
   shippable.
3. Item 2 (watch-pr batching) — the largest latency/quota win; ship behind the
   per-PR fallback so behavior can be diffed in one release cycle.
4. Item 4 (preflight cache) — after the receipt-schema discussion, since it
   adds an additive field and documented operator controls.
5. Item 5 (streaming capture) — last, as the only cross-cutting refactor; it
   is fully covered by the existing fixture suite and can land per-adapter.

All five fit the repository's existing gates: colocated `*.test.ts` under
Bun, typecheck, the static manifest checks in `.github/workflows/ci.yml`, and
the operator Mac live-gate for anything touching real provider CLIs.
