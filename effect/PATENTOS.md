# PatentOS v2 on pi-effect

What PatentOS v2 gets from this repository, the binding that was written for it, and what is left. State of
2026-11-25. Nothing is committed in either repository, and PatentOS's main checkout was never edited.

The goal of the PRD (section 4): PatentOS deletes its hand-written agent loop
(`packages/compute/src/agent/Thread.ts`) and its sequential swarm runner, and binds its ports `AgentWork`,
`SwarmRunner` and `ForkRuntime` to these packages. That is done, in a worktree of PatentOS.

## 1. Where the work is

| | Path | State |
|---|---|---|
| The packages | This repository, branch `effect`, uncommitted | `npm run check` passes; 1,734 tests on Node, 1,733 on Bun |
| The PatentOS binding | `/Volumes/Banana/GitHub/gunta/patentos-build-run/pi-effect-wt2`, branch `pi-effect/agent-thread-on-56fd828`, uncommitted | `bun run check` passes there: 4,050 tests, `apps/api/test/agent-thread.test.ts` unchanged from main |
| An older copy of the binding | `/Volumes/Banana/GitHub/gunta/patentos-build-run/pi-effect-wt`, branch `pi-effect/agent-thread` | On base `64ad2bc`, before main redesigned the review. Superseded by the row above |

The binding sits on PatentOS `56fd828`. Main has two commits after it (`b304824`, `b82c172`), which touch none of
the binding's 47 files.

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

The composition is public now (`packages/thread-effect`; it was the private `acceptance-effect`). Its README has
the mapping from a hand-written loop and Rivet host to the packages, and its open gaps.

## 3. How the packages get into PatentOS

Nothing is published. The binding installs tarballs:

```sh
# in pi-effect, after upstream's `npm run build` ran once
node effect/scripts/pack.ts <patentos>/vendor/pi-effect
```

- `packages/compute/package.json` declares each package at `0.1.0`; the root `overrides` point every `@gunta/*`
  name at its tarball; `.npmrc` keeps `@gunta` lookups off the network.
- `bun.lock` pins a tarball's integrity, and `bun install --force` reinstalls the old one from Bun's cache. After
  a repack: remove the changed package's line from `packages/compute/package.json`, run
  `bun install --ignore-scripts`, put the line back, run it again. Then compare the installed `dist` with the
  source's.
- PatentOS's `repo-check`, its type checker (tsrs), Oxlint and import-lint accept all of this as it is.

Once the packages are published under a scope, the `overrides`, `vendor/` and `.npmrc` go.

## 4. What the binding is

All in `packages/compute`, with small changes in `apps/node-compute` and
`apps/node-domain/src/bindings/agents/Compute.ts`. `packages/compute/README.md` in the worktree is the reference;
in short:

- **The model seam** (`ThreadSeam.ts`): one pi-ai provider that takes each request of the harness to PatentOS's
  `ModelRouter` as a structured turn, and sends `RecordModelCall` with the ledger entry itself. PatentOS's router,
  limiter, price table and prompt rules stay. Cost: no token streaming, no native tool calling.
- **Money** (`ThreadMoney.ts`): the budget's `Lease` is the lease keeper's meter. Route prices are zero; the seam
  charges what `ModelRouter` computed, so the ledger equals the bills to the micro unit.
- **The record** (`ThreadSinks.ts`, `ThreadRecord.ts`): a `RecordSink` and an `OutcomeSink` send the Agents
  commands through the outbox, under ids made of the step, so each is sent once.
- **The review is PatentOS's, not the composition's.** Main decided it while the binding was written (commit
  `7b58b8f`): a review is another thread's work, opened by the Agents context. So every PatentOS thread is
  admitted with `review: false`; an author's job, a reviewer's job and a corrective job are each a thread of the
  composition, and `pi-review-effect` is imported nowhere in compute.
- **Two forms, one binding.** In one process: a harness per job on a SQLite file per thread (`agentWorkLayer`,
  `swarmRunnerLayer`), which is what `apps/node-compute` binds. In Rivet actors: one actor per thread with the
  unit's tables in the actor's SQLite, swarms on actor forks, PatentOS's own fork hygiene
  (`host/rivet/`: `remoteAgentWorkLayer`, `remoteSwarmRunnerLayer`). No app starts the actor form yet; the README
  says what a composition root does to choose it.
- **Ports.** `AgentWork` and `SwarmRunner` are served whole, `ForkRuntime.destroy` too. Only
  `AgentPackCatalog.roster` for packs other than the demo pack still fails closed, as on main.

The old loop is deleted. `Thread.ts` keeps the vocabulary (`ThreadInput`, `ThreadOutcome`, the toolbox).

## 5. What changed for the domain

- A request cut off by a restart is sent again under the same effect key: one more request and reservation.
- Cancel aborts the request in flight; the old loop finished its turn.
- A corrective run is a new conversation that starts from the task with the findings, as main's loop did.
- A swarm is real: one fork per job under `maxForks`, an equal share of `maxSpend` per fork.
- `storageBytesWritten` is the JSON size of a fork's entries in one process, and the growth of a fork's database
  in whole pages in an actor. Neither is bytes written.

## 6. What is left

**For the owner to decide or do**

1. Commit both trees. Everything above exists only as uncommitted files.
2. Merge the binding. It is level with `56fd828`; a later main redoes `Thread.ts`'s schemas, `threadWork` in
   `Bindings.ts` and `thread.test.ts` when it changes the loop's inputs again.
3. The npm scope and publishing (PRD 13.1). Until then PatentOS carries tarballs.
4. Eighteen open domain decisions, listed in the worktree's `packages/compute/README.md` with the canvas section
   and the smallest change for each. The ones that block a feature:
   - `StartSwarm` cannot be accepted in the local edition: `PrimerFact` has no builder. Swarms are proven on fakes
     only.
   - The Agents model does not say what a swarm's jobs are. Compute defines the simplest kind: a question, with the
     fork's answer as text.
   - ADR 0025 forbids forking an actor that holds money, and a thread's unit holds a lease. The binding forks it
     and deletes the copied lease in the fork before its first call.
5. A composition root that hosts threads in actors. The actor form is proven on a local engine by tests only.

**Not proven**

- A real model provider: every test uses scripted or fake models.
- An actor process that crashes (a forced sleep was tested), several host processes, the fork depth limit, a real
  Spend context that grants one lease per fork holder.
- Node 22.19 (24.22 and 26.13 ran), the engine tests on Linux, CI (it needs a push).
- The 50-fork swarm takes about 0.2 s in process and 5 to 8 s on a local engine, against the PRD's 5 s.

**Open in the packages** (`packages/thread-effect/README.md`, "Gaps"): the reviewer's model call record lacks its
api and cost parts; an outcome a thread left before its courier looked is not told; a destroyed in-storage fork
frees nothing; an agent change sent to an actor is not checked against its registry. PatentOS's binding meets only
the fork size.

**Not built**: `mcp-effect`, `codemode-effect`, `agent-effect`, `env-effect`, `workflow-effect`, `sandbox-effect`
(PRD priorities P2 and P3). PatentOS's loop used none of them.

## 7. Hazards on the shared machine

- `patentos-db-bench/run-all.sh` runs `pkill rivet-engine` machine-wide. It stopped test engines mid-run; the host
  retries a start whose engine was stopped, and a test whose engine dies later fails that run.
- Early Bun runs of this repository's Rivet tests wrote test actors into the shared `~/.rivetkit/var/engine`,
  because on Bun an assignment to `process.env` does not reach rivetkit's native core. Nothing was deleted there.
  The `/bun` entry of `pi-durable-rivet-effect` now sets the variable for real, and PatentOS's own `LocalEngine`
  keeps its engine out of that directory.
