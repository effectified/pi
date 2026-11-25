# PatentOS v2 on pi-effect

What PatentOS v2 gets from this repository, how the packages reach it, what was built for it and what is left.
State of 2026-11-26.

The goal of the PRD (section 4): PatentOS deletes its hand-written agent loop
(`packages/compute/src/agent/Thread.ts`) and its sequential swarm runner, and binds its ports `AgentWork`,
`SwarmRunner` and `ForkRuntime` to these packages. That is done and merged into PatentOS.

## 1. Where the work is

| | Where | State |
|---|---|---|
| The packages | This repository, branch `effect`, pushed to `origin` | Synced with upstream Pi 1.6.1. `npm run check` passes; the suites pass on Node and on Bun (versions and counts in `COMPAT.md`) |
| The binding | PatentOS, branches `build/s0-foundations` and `main`, from commit `15c7a11` on | Merged and pushed. PatentOS's gate `bun run check:all` passed on `b6419f4` (4,847 tests), which holds the packages at `6a42274ae` |
| The worktree to change it in | `/Volumes/Banana/GitHub/gunta/patentos-build-run/pi-effect-wt2`, branch `pi-effect/agent-thread-on-56fd828` | Kept level with the build's tip |

PatentOS's shared checkout (`/Volumes/Banana/GitHub/gunta/patentos`) is never edited for this work: other
sessions keep uncommitted files there. Section 7 says how a commit lands on it.

## 2. What PatentOS uses

Fifteen packages at 0.1.0, on Pi 1.6.1 and `effect` 4.1.5. `packages/compute` declares ten of them.

| Package | In PatentOS |
|---|---|
| `pi-thread-effect` | The agent thread: `Composition`, `Threads`, `Swarms`, and from `/rivet` `ThreadActor` and `Remote` |
| `pi-durable-effect`, `pi-durable-rivet-effect` | Tools, the harness storage, the actor host and its client, and the start of each org's local engine (`LocalEngine.serve` of `/bun`, `Host.holdBackExit`) |
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
`workspace:*` and whose peers are exact), writes the commit into `SOURCE.json` and installs. Upstream's `npm run
build` must have run here once. When the packages move to another Pi version, PatentOS's own Pi pins
(`packages/compute/package.json`) move with them in the same commit. `vendor.ts` refuses to run when the packages'
Pi pins are not what this tree has (`--unreleased-pi` overrides it on purpose) and writes `SOURCE.json` itself, with
the commit and the Pi the packages were built against; PatentOS's `scripts/pi-effect.ts` still overwrites that file
with the commit alone, and should keep it instead.

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
- RivetKit's `process.exit(1)` after a failed engine start, or for an engine that died, no longer ends the edition
  (`packages/compute/test/rivet.exit.test.ts`). Since 2026-11-26 the guard and the engine start are this
  repository's (`0341cb51c`): PatentOS's own `LocalEngine.ts` and `ExitGuard.ts` are deleted, and its nine engine
  test files pass on the package's start (29 tests, the kill and restart of the edition among them; PatentOS
  `73d1b65`).
- A thread taken up after its host was killed is not stranded by its caller's polling. The restart test found it:
  the wake keeper of `pi-durable-rivet-effect` cancelled a wake whose time had come at the next call to the actor,
  and PatentOS asks a working thread's actor every 250 ms. Fixed here in `63ed08b30`; the case failed 4 of about
  26 runs before and 0 of 22 after, with the other engine tests alongside.
- A killed edition no longer stalls a stream of the journal. The restart test found this too (its case at
  ledger.sealed, about one run in seventeen): a drain of PatentOS's domain framework holds a lease in its object's
  storage for a minute, a killed process leaves it in `objects.sqlite`, and after the boot every drain of that
  object answered as done, so a thread whose last event came within that minute was never journaled further.
  Fixed in PatentOS's local host (`741e94f`: leases found when the file is opened are removed and their drains
  run), with a test that kills a process inside a projection's run and inside a reaction
  (`apps/node-domain/test/local-objects.restart.test.ts`). The restart test then passed 11 runs of 11 beside the
  other engine tests: few runs, so the proof is the host's own test, which was red before. (That test first read
  the SQLite file while its process still made its tables, which ended the process once in four gate runs; fixed
  in `0bc8147`.)

Here (scripted models; real engine, real host processes):

- A host process killed after a model request was sent, between an unsafe tool's effect and its commit, and with
  no host for 18 s; two hosts on one engine; a host that leaves; a swarm whose coordinator's host is killed; a
  host frozen until its actor moved (`packages/thread-effect/test/hosts-suite.ts`). No bug was found.
- The fork depth limit: 16 forks in a line, then `ForkTooDeep`, and a swarm's job fails as `too-deep`.
- Every package on Node 22.19.0, the lowest version declared: 1,747 tests (`COMPAT.md`).

## 6. What is left

The owner's direction of 2026-11-26: the packages are the owner's own library, made for PatentOS; nothing is sent
upstream for now. So what was "for a person to raise upstream" is closed here or worked around here.

**For the owner to decide**

1. What of `effect/` may stay public. The branch is pushed (the owner's word of 2026-11-25), the fork is of a
   public repository, and `effect/` holds the PRD and these notes with paths of the owner's machine.
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
  machines, a network partition, engine upgrades. PatentOS's own engine tests have not run on Linux; the engine
  start they use is the packages', which has (in CI and in a container: `COMPAT.md`).
- Swarms across a restart of the edition. Two editions started at once on one directory: the second stops the
  first's engine and starts its own (one engine per directory, tested in the package); what the first edition
  does without its engine is untested.
- A real Spend context that grants one lease per fork holder.

**Found in what is not ours, and how it is lived with**

- The framework PatentOS's domain runs on (`@alchemy.run/domain` 2.0.0-beta.87) deletes the callback of a drain
  that found a lease held. PatentOS's local host clears such leases at boot, which is the only host PatentOS
  runs; the framework's other hosts (several instances) would stall the same way.
- Upstream Pi's tests name models of the live catalogs its build fetches, so upstream's check and tests go red on
  a day a catalog changes (three models in two days). `effect-ci.yml` still runs them and shows them, and its
  result is that of these packages alone (`COMPAT.md`).

**Known limits**

- The 50-fork swarm takes about 0.2 s in one process and 5.2 to 5.8 s on a local engine (three runs at load 5 on
  18 cores, so not the machine's load), against the PRD's 5 s. A local engine forks in about 110 ms and one
  process hosts the source and all 50 forks; the cap of 8 does not help there.
- A request resent after a host died has a key a lease can recognise it by (`requestKey` on the reservation and
  the route events, `3b414f768`), and none a provider could: Pi's retry after a provider error has the same key
  by design (`thread-effect` gap 6). PatentOS is not exposed: its seam keys each call by the step.
- A killed host's reservations stay open until the product's lease expires them.
- An actor wakes by itself about 17 s after its host was killed. PatentOS's `recover` runs a noted job again at
  boot, so a job given and never admitted is not lost.

**Open in the packages** (`packages/thread-effect/README.md`, "Gaps"): three that need a change in Pi itself,
which PatentOS installs as published and so cannot get from this fork (a hook cannot commit with a submission's
end; a conversation cannot be deleted or measured; a provider request has no key of its send). Closed on
2026-11-26: the reviewer's model call is kept whole, every hold and deferral a thread left at once is told, and a
swarm plan's `cwd` and `compaction` cross to an actor.

**Done on 2026-11-26, on the owner's word** ("use Effect as fully as it goes, and follow upstream Pi by derived
types and generated checks instead of by hand"; the two surveys that planned it are in the run's store, outside
the repository):

- Fibers belong to a scope (Pi's timers, report lines, an actor's handlers and its database work); retries and
  paging are `Schedule` and `Stream`; the local engine reads files and the process list through Effect's platform
  services; no test waits on the real clock (`runTest`).
- `pi-durable-rivet-effect` adds `ActorSql`, an Effect `SqlClient` over the actor's database whose interrupted
  transaction rolls back. `ActorDatabase` is deprecated and works on the same queue: PatentOS's
  `ThreadActor.ts` and `ForkHygiene.ts` use it and need no change.
- A type comes from Pi's, a choice over a Pi union is exhaustive, and what stays hand-written is asserted in each
  package's `test/pi-conformance.ts`. `effect/pi-surface/` records the Pi declarations the packages use,
  `node effect/scripts/sync.ts check` proves the pins are the Pi sources in the tree, and
  `node effect/scripts/gate.ts` is the whole gate in one command (`effect/AGENTS.md`).
- Bugs found on the way and fixed: prices follow pi-ai's own cost (the 1-hour cache write, price tiers), a router
  alias offers its routes' thinking levels, the router no longer passes a request's `env` on, a failed attempt is
  no turn, `maxTurns: 0` is refused before anything is created, the guard's backstop decides every member of a
  tool. PatentOS's route prices are zero and its seam charges what its own `ModelRouter` computed, so its ledger
  does not move.

Also pinned by tests, since no type shows them: a compaction of Pi as live work of a forked actor, the provider
session of a fork, the bounds of `configure`, Pi's classification of provider errors, the names of Pi's tables.

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
- The gate is red by other causes when the machine is loaded (tests that run into their own time limits; the
  build's lanes fixed the grid benchmark and the auditor export on 2026-11-26). Read which file failed before
  suspecting the commit, run again, and land only on a green run on the tip the swap is made against. A commit
  that deletes files lands with `/tmp/land/land3.sh`, which removes a deleted file only when no lane changed it.
- `patentos-db-bench/run-all.sh` runs `pkill rivet-engine` machine-wide. The host retries a start whose engine
  was stopped; a test whose engine dies later fails that run and is run again.
- Upstream's own workflows are disabled in the fork since 2026-11-26 (before, a push to `main` started them, and
  the ones that publish or need release tags failed there).
- Early Bun runs of this repository's Rivet tests wrote test actors into the shared `~/.rivetkit/var/engine`,
  because on Bun an assignment to `process.env` does not reach rivetkit's native core. Nothing was deleted there.
  The `/bun` entry of `pi-durable-rivet-effect` now sets the variable for real.
