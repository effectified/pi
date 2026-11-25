# PatentOS v2 on pi-effect

What PatentOS v2 gets from this repository, how the packages reach it, what was built for it and what is left.
State of 2026-11-25, evening.

The goal of the PRD (section 4): PatentOS deletes its hand-written agent loop
(`packages/compute/src/agent/Thread.ts`) and its sequential swarm runner, and binds its ports `AgentWork`,
`SwarmRunner` and `ForkRuntime` to these packages. That is done and merged into PatentOS.

## 1. Where the work is

| | Where | State |
|---|---|---|
| The packages | This repository, branch `effect`, committed, not pushed | `npm run check` passes; the suites pass on Node and on Bun (versions and counts in `COMPAT.md`) |
| The binding | PatentOS, branches `build/s0-foundations` and `main`, from commit `15c7a11` on | Merged. PatentOS's gate `bun run check:all` passed on `8ef540f` (4,598 tests) |
| The worktree to change it in | `/Volumes/Banana/GitHub/gunta/patentos-build-run/pi-effect-wt2`, branch `pi-effect/agent-thread-on-56fd828` | Level with `8ef540f` |

PatentOS's shared checkout (`/Volumes/Banana/GitHub/gunta/patentos`) is never edited for this work: other
sessions keep uncommitted files there. Section 7 says how a commit lands on it.

## 2. What PatentOS uses

Fifteen packages at 0.1.0, on Pi 1.6.0 and `effect` 4.1.5. `packages/compute` declares ten of them.

| Package | In PatentOS |
|---|---|
| `pi-thread-effect` | The agent thread: `Composition`, `Threads`, `Swarms`, and from `/rivet` `ThreadActor` and `Remote` |
| `pi-durable-effect`, `pi-durable-rivet-effect` | Tools, the harness storage, the actor host and its client |
| `pi-guard-effect` | The denied verbs of the old `FORBIDDEN`, and a thread's grant |
| `pi-budget-effect` | The `Lease` port, served by PatentOS's lease keeper |
| `pi-router-effect` | A route table of two aliases that both lead to PatentOS's own `ModelRouter` |
| `pi-recorder-effect` | The `RecordSink` that writes the Agents record by command |
| `pi-swarm-effect` | Swarms on conversation forks and on actor forks |
| `pi-approvals-effect`, `pi-telemetry-effect` | Ports the composition requires; no PatentOS call waits for a person yet |
| `pi-review-effect`, `pi-subagent-effect`, `pi-search-effect`, `pi-ai-effect`, `pi-schema-effect` | Not imported by PatentOS: they come with `pi-thread-effect` |

## 3. How the packages get into PatentOS

Nothing is published, and PatentOS pins no version (the owner's decision of 2026-11-25). The packages are
workspace packages of PatentOS, kept built in its `vendor/pi-effect`, and `packages/compute` depends on each as
`workspace:*`.

```sh
# in a PatentOS worktree, after a change here was committed
bun run pi-effect /Volumes/Banana/GitHub/gunta/pi-effect
```

That runs `effect/scripts/vendor.ts` of this repository: it builds every package, replaces the directories in
`vendor/pi-effect` (`dist` without source maps, the README, a manifest whose pi-effect dependencies are
`workspace:*` and whose peers are exact), writes the commit into `SOURCE.json` and installs. Upstream's
`npm run build` must have run here once.

Why not a link or a git dependency: a link to this checkout gives PatentOS two copies of `effect`, Pi Durable and
RivetKit and does not install in CI or in a worktree at another depth; a git dependency cannot name a package
inside a monorepo; PatentOS's `repo-check` allows an exact version or `workspace:*` and nothing else.
`vendor/pi-effect/README.md` in PatentOS says the same.

`effect/scripts/pack.ts` still makes tarballs, for a product that wants them.

## 4. What the binding is

All in PatentOS's `packages/compute`, `apps/node-compute` and a few files of `apps/node-domain`.
`packages/compute/README.md` there is the reference; in short:

- **The model seam** (`ThreadSeam.ts`): one pi-ai provider that takes each request of the harness to PatentOS's
  `ModelRouter` as a structured turn, and sends `RecordModelCall` with the ledger entry itself. PatentOS's router,
  limiter, price table and prompt rules stay. Cost: no token streaming, no native tool calling.
- **Money** (`ThreadMoney.ts`): the budget's `Lease` is the lease keeper's meter. Route prices are zero; the seam
  charges what `ModelRouter` computed, so the ledger equals the bills to the micro unit.
- **The record** (`ThreadSinks.ts`, `ThreadRecord.ts`): a `RecordSink` and an `OutcomeSink` send the Agents
  commands through the outbox, under ids made of the step, so each is sent once.
- **The review is PatentOS's, not the composition's** (PatentOS commit `7b58b8f`): a review is another thread's
  work, opened by the Agents context. Every PatentOS thread is admitted with `review: false`, and
  `pi-review-effect` is imported nowhere in compute.
- **Two forms, chosen by a setting.** `apps/node-compute` takes `ThreadHosting`: `OneProcess` (the default: a
  harness per job on a SQLite file per thread) or `RivetActors` (an actor per thread on an engine, a swarm's fork
  a fork of its thread's actor; `threadHostLayer` of `@patentos/compute/rivet`). The local edition chooses with
  `PATENTOS_THREADS=rivet`, which gives each org an engine of its own under the edition's directory.
- **Ports.** `AgentWork` and `SwarmRunner` are served whole, `ForkRuntime.destroy` too.

The old loop is deleted. `Thread.ts` keeps the vocabulary (`ThreadInput`, `ThreadOutcome`, the toolbox).

## 5. What is proven, and by what

In PatentOS (fake providers everywhere; engines, actors, forks and kills are real):

- A thread over HTTP in both forms: `apps/api/test/agent-thread.test.ts` runs its whole story under each.
- The edition's process killed with SIGKILL while a thread works in an actor, at two points, and booted again on
  the same directory: the thread ends as an undisturbed one does, the ledger equals the bills of both processes,
  nothing is left leased (`apps/api/test/agent-thread.restart.test.ts`).
- A swarm of one job end to end in the local edition, through the real commands, reactions and compute's runner
  (`apps/api/test/agent-swarm.test.ts`). It needed the Agents model to build `PrimerFact` (`primerFactOf`).
- Threads and swarms of one and three jobs on actor forks through the app's own bindings, two orgs' engines kept
  apart, a cancel mid-request (`apps/node-compute/test/threads.rivet.test.ts`).
- RivetKit's `process.exit(1)` after a failed engine start no longer ends the edition
  (`packages/compute/test/rivet.exit.test.ts`).
- A thread taken up after its host was killed is not stranded by its caller's polling. The restart test found it:
  the wake keeper of `pi-durable-rivet-effect` cancelled a wake whose time had come at the next call to the actor,
  and PatentOS asks a working thread's actor every 250 ms. Fixed here in `63ed08b30`; the case failed 4 of about
  26 runs before and 0 of 22 after, with the other engine tests alongside.

Here (scripted models; real engine, real host processes):

- A host process killed after a model request was sent, between an unsafe tool's effect and its commit, and with
  no host for 18 s; two hosts on one engine; a host that leaves; a swarm whose coordinator's host is killed; a
  host frozen until its actor moved (`packages/thread-effect/test/hosts-suite.ts`). No bug was found.
- The fork depth limit: 16 forks in a line, then `ForkTooDeep`, and a swarm's job fails as `too-deep`.
- Every package on Node 22.19.0, the lowest version declared: 1,747 tests (`COMPAT.md`).

## 6. What is left

**For the owner to decide**

1. Push this repository's branch `effect`. It is committed and local. The fork is of a public repository, and
   `effect/` holds the PRD and these notes: decide what may be public first. CI (`effect-ci.yml`) has never run.
2. The open domain decisions in PatentOS's `packages/compute/README.md` (17 of 18 rows; row 7 is closed). The ones
   that block a feature:
   - A swarm is accepted only while its thread's session is `working` (rows 4 and 12). Once the thread waits for
     its review the host refuses `StartSwarm`, `ReportSwarmJob` and `FinishSwarm`.
   - Nothing proposes a plan with a swarm step: only the test does. So no person can get a swarm yet.
   - The edition plans one job per swarm; what a swarm's jobs are is not modelled (row 5).
   - ADR 0025 forbids forking an actor that holds money, and a thread's unit holds a lease. The binding forks it
     and deletes the copied lease in the fork before its first call (rows 13 and 14).

**Not proven**

- A real model provider: every test uses scripted or fake models.
- An engine that dies while it is up (the edition lives; that org's thread calls are untested then), several
  machines, a network partition, engine upgrades, the engine tests on Linux.
- Swarms across a restart of the edition; two editions started at once on one directory.
- A real Spend context that grants one lease per fork holder.

**Found and not ours to fix**

- After a hard kill of the edition, the journal stream of a thread can stop for good: an event the Agents context
  took just before the kill is not copied into the journal after the boot, nor anything after it in that stream.
  It makes `agent-thread.restart.test.ts` red about one run in seventeen beside the other engine tests (the case at
  ledger.sealed), with compute's work done and every command accepted. It is PatentOS's host (the journal
  projection); the evidence is in `patentos-build-run/build-run.md` and
  `patentos-build-run/logs/pi-effect-restart-journal-stall.log`.

**Known limits**

- The 50-fork swarm takes about 0.2 s in one process and 5.2 to 5.8 s on a local engine (three runs at load 5 on
  18 cores, so not the machine's load), against the PRD's 5 s. A local engine forks in about 110 ms and one
  process hosts the source and all 50 forks; the cap of 8 does not help there.
- A request resent after a host died has no key of the packages' own that a provider or a lease could recognise
  (`thread-effect` gap 6). PatentOS is not exposed: its seam keys each call by the step.
- A killed host's reservations stay open until the product's lease expires them.
- An actor wakes by itself about 17 s after its host was killed. PatentOS's `recover` runs a noted job again at
  boot, so a job given and never admitted is not lost.

**Open in the packages** (`packages/thread-effect/README.md`, "Gaps"): the reviewer's model call record lacks its
api and cost parts, and an outcome a thread left before its courier looked is not told (both in the review
plugin, which PatentOS does not use); two that need a change in Pi (a hook cannot commit with a submission's end;
a conversation cannot be deleted or measured); `cwd` and `compaction` of an agent change do not cross to an actor.

**Worth doing next**: export the exit guard and a kept engine directory from `pi-durable-rivet-effect`, so that
PatentOS's `ExitGuard.ts` and most of its `LocalEngine.ts` can go.

**Not built**: `mcp-effect`, `codemode-effect`, `agent-effect`, `env-effect`, `workflow-effect`, `sandbox-effect`
(PRD priorities P2 and P3). PatentOS's loop used none of them.

## 7. Landing a commit on PatentOS, and hazards of the shared machine

- PatentOS's shared checkout holds other sessions' uncommitted files, and a root agent commits on
  `build/s0-foundations` every few minutes. Commit in the worktree, rebase on the branch's tip, run
  `bun run check:all`, then land by that build's practice (`patentos-build-run/build-run.md`, "Standing
  practice"): `git update-ref refs/heads/build/s0-foundations <new> <the tip it was built on>`, `git reset -q`,
  and write only the commit's paths into the tree. A path another lane has open gets a three-way merge
  (`git merge-file`); `bun.lock` is never merged as text (`bun install --ignore-scripts` adds to it). An
  "Addition" in `build-run.md` tells that root what landed.
- A test that boots the edition can pass on the committed head and fail in the shared tree because of another
  lane's unfinished work there. Judge a commit in the worktree.
- `patentos-db-bench/run-all.sh` runs `pkill rivet-engine` machine-wide. The host retries a start whose engine
  was stopped; a test whose engine dies later fails that run and is run again.
- Early Bun runs of this repository's Rivet tests wrote test actors into the shared `~/.rivetkit/var/engine`,
  because on Bun an assignment to `process.env` does not reach rivetkit's native core. Nothing was deleted there.
  The `/bun` entry of `pi-durable-rivet-effect` now sets the variable for real.
