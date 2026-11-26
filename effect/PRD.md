# PRD: pi-effect

Effect-native packages for Pi, built beside Pi and never inside it.

- Status: draft 1, 2026-11-24, for the owner's decision. Nothing is committed or pushed.
- Repository: `github.com/effectified/pi`, a fork of `earendil-works/pi`, identical to upstream at
  `f8149d1ab` when this was written. Local clone: `/Volumes/Banana/GitHub/gunta/pi-effect`.
- First consumer: PatentOS v2 (`/Volumes/Banana/GitHub/gunta/patentos`), whose hand-written agent loop
  this replaces.
- Evidence: the upstream repository and its Pi Durable specification (7,303 lines), the published packages
  read from npm (not run), Rivet's forking, swarm and Pi guides, and PatentOS's own compute code. What was
  not verified is listed in section 12.

## 1. Summary

Pi is the most complete open agent toolkit in TypeScript, and Pi Durable is the one durable harness with
conversation forks, child tasks, parking gates and a storage contract with a conformance suite. It is
promise-based. Our products are written in Effect. Today there is no Effect-native harness that forks and
swarms, and no maintained Effect binding for Pi Durable.

pi-effect adds that binding as **new packages in a fork of Pi**: one Effect facade per Pi package we use
(same name plus `-effect`), and a set of plugins written on those facades that every Effect product needs
(recording, budgets, approvals, guards, swarms, routing, search, a Rivet host). Pi's own packages are never
edited. The new packages could be merged upstream one day or live in the fork forever; the design works
either way.

## 2. Facts this plan stands on

| Fact | Value |
|---|---|
| Upstream | `earendil-works/pi`, MIT, 123,622 stars, 15,968 forks, pushed daily |
| Upstream packages | `agent`, `ai`, `chord`, `codemode`, `coding-agent`, `durable`, `env`, `evals`, `mcp`, `schema`, `telemetry`, `tui`; all versioned together at 1.6.0 |
| Upstream tooling | npm workspaces (`packages/*`), TypeScript 7.0.2 with `erasableSyntaxOnly`, Biome 2.3.5 (tabs, width 120), Vitest 4.1.12, Node 22.19 or later, every direct dependency pinned exactly |
| Upstream contribution rule | "pi's core is minimal. If your feature does not belong in the core, it should be an extension." Issues and PRs from new contributors are closed automatically until a maintainer approves the person; automated issue volume gets an account blocked |
| Pi Durable | `@earendil-works/pi-durable` 1.6.0, about 1.6 million downloads a week, README says "Experimental. The API changes without notice"; stored data rolls forward only |
| Pi Durable storage | SQLite through a small `SqliteDatabase` interface (`exec`, `run`, `get`, `all`, `transaction`, `close`), table prefix option, custom backends, `registerStorageConformance()` |
| Pi Durable forks | `conversation.fork(entryId, options)`: the fork sees the parent's entries up to that entry and continues alone |
| Models | `@earendil-works/pi-ai` 1.6.0: `createModels()`, provider factories (Anthropic, OpenAI, Google, OpenRouter and more), `createProvider()` for custom ones, `fauxProvider()` for tests |
| Rivet | `rivetkit` 3.1.1, `@rivetkit/effect` 3.1.1; actor fork since 3.1.0 (copy-on-write SQLite, depth 16, `onFork`); Rivet's adapter `@rivet-dev/pi` 0.5.7 pins Pi Durable `~1.5.0` |
| Effect | `effect` 4.1.5 ships `effect/ai` (`LanguageModel`, `Chat`, `Tool`, `Toolkit`, MCP client and server) and `effect/workflow`; `@effect/ai-openrouter`, `-anthropic`, `-openai` 4.1.5 |
| Name on npm | Unscoped `pi-effect` is taken (0.2.0, another author, wraps the Pi coding agent SDK, last published July 2026). `pi-ai-effect`, `pi-durable-effect`, `pi-schema-effect` are free. We publish under a scope |

## 3. Principles

1. **New packages only.** No file of an upstream package is changed. If we need something from Pi that is
   not public, we ask upstream or do without; we do not patch.
2. **One facade per Pi package, in `packages/<pi package>-effect`, named `@effectified/<pi package>`.** A facade adds no behaviour: it gives the
   same capability in Effect terms (Effect, Stream, Layer, Scope, Schema, typed errors, interruption).
3. **Plugins are where our behaviour goes.** They are Pi extensions and host adapters written on the
   facades, each small and separately installable.
4. **Mergeable by construction.** Our packages follow upstream's rules (Biome formatting, erasable
   TypeScript, exact pins, Vitest, MIT, no emojis, their `AGENTS.md`), so moving one upstream is a
   directory move, not a rewrite.
5. **Fast lane on top, not instead.** We also run the tests under Bun and typecheck with tsrs, because Bun
   is our runtime and loop speed is our priority. Upstream's `npm run check` and `./test.sh` stay green.
6. **No product rules.** Nothing here knows about patents, tenants or PatentOS contexts. Products plug in
   their own Layers.
7. **Every package stands alone.** Each one is installable and useful by itself, depends only on the upstream
   package it wraps, on `effect`, and on the few of ours it names (section 5.4), and has its own README,
   tests and version entry. No package assumes PatentOS, Rivet or any other of ours is present unless its
   name says so. This is also what lets a package move to another home (Pi, Rivet, or its own repository)
   without the rest.

**Engine: Pi Durable.** Confirmed by the owner on 2026-11-24.

## 4. Goals and non-goals

**Goals**

- An Effect program can open a durable harness, run conversations, define tools, hooks, tasks and signals,
  fork, and run swarms, without one promise in a public signature.
- The same code runs on a local SQLite file, in a Rivet actor and in tests, on Bun and on Node.
- Any model: Pi's providers, any `effect/ai` provider, or a product's own router, with OpenRouter in both.
- Every model call and tool call can be recorded, budgeted, gated and approved by the host, exactly once.
- PatentOS deletes its own loop and binds its ports to these packages.

**Non-goals**

- Changing or reimplementing Pi's loop, storage, compaction or scheduling.
- A second system of record. The harness store is working state; the product's record stays the record.
- Supporting Effect 3.

## 5. Package map

Directory names mirror upstream (`packages/durable` gives `packages/durable-effect`). The npm name drops the suffix
(`packages/durable-effect` is `@effectified/pi-durable`, section 13.1).

### 5.1 Facades

| Priority | Directory | npm name | Wraps | Gives |
|---|---|---|---|---|
| P0 | `packages/schema-effect` | `pi-schema-effect` | `pi-schema` | Effect `Schema` to and from Pi tool parameters (JSON Schema); typed decode errors |
| P0 | `packages/ai-effect` | `pi-ai-effect` | `pi-ai` | `Models` as a service and Layer; `stream` and `complete` as `Stream` and `Effect`; both bridges to `effect/ai` (5.3); scripted models for tests |
| P0 | `packages/durable-effect` | `pi-durable-effect` | `pi-durable` | The harness in Effect: section 6 |
| P1 | `packages/telemetry-effect` | `pi-telemetry-effect` | `pi-telemetry` | Pi telemetry as Effect spans, metrics and logs; Effect trace context carried into Pi calls |
| P2 | `packages/mcp-effect` | `pi-mcp-effect` | `pi-mcp` | MCP clients and transports as scoped resources, requests as Effects, notifications as Streams, OAuth sign-in; MCP tools as Pi tools come with `coding-agent-effect`, as in Pi |
| P2 | `packages/codemode-effect` | `pi-codemode-effect` | `pi-codemode` | Code mode over Effect-defined tools |
| P3 | `packages/agent-effect` | `pi-agent-core-effect` | `pi-agent-core` | The non-durable agent loop in Effect, for short-lived uses |
| P3 | `packages/env-effect` | `pi-env-effect` | `pi-env` | Remote execution environments as scoped resources |
| P2 | `packages/chord-effect` | `pi-chord` | `chord` | Chord's context (cancellation, telemetry, values) from the fiber that makes a call, its JSON and SQLite types, so no product imports Chord |
| P2 | `packages/tui-effect` | `pi-tui` | `pi-tui` | The terminal UI's components and renderer as scoped resources, input as `Stream`s |
| P2 | `packages/coding-agent-effect` | `pi-coding-agent` | `pi-coding-agent` | Sessions, tools, settings and the extension API in Effect: a Pi extension written as an Effect program; interactive mode as a scoped service on `tui-effect` |
| P3 | `packages/evals-effect` | `pi-evals` | `pi-evals` | Evaluations whose cases and scorers are Effects |

Every Pi package has a facade (owner, 2026-11-26): an application imports `@effectified/pi-*` only. Each facade
records what it does with every value its Pi package exports (`test/index.test.ts`), and `effect/COMPAT.md` counts
what is still open.

### 5.2 Plugins and hosts

| Priority | Directory | npm name | What it does |
|---|---|---|---|
| P0 | `packages/recorder-effect` | `pi-recorder-effect` | Every message, model call and tool call goes to a host sink with a deterministic id, at least once, deduplicated; the pending rows live in the harness storage in the same commit as the step (a transactional outbox) |
| P0 | `packages/guard-effect` | `pi-guard-effect` | An exact tool allow-list per conversation, a deny-list of verbs that can never be registered, argument rules, a classification ceiling per model route; fails closed |
| P1 | `packages/budget-effect` | `pi-budget-effect` | A budget lease: reserve before each provider request, settle after the response, stop cleanly when the lease is fenced; money through a price table |
| P1 | `packages/approvals-effect` | `pi-approvals-effect` | Human approval as a parking gate: typed request and decision, expiry, bound to a digest of the arguments, who decided |
| P1 | `packages/durable-rivet-effect` | `pi-durable-rivet-effect` | The harness inside a Rivet actor through `@rivetkit/effect`: actor SQLite as storage, alarms as wake-ups, actor fork with `onFork` hygiene |
| P1 | `packages/swarm-effect` | `pi-swarm-effect` | Prime, wait for idle, fork per job under a cap, typed results, fan in, clean up; drivers for in-storage conversation forks and for Rivet actor forks |
| P1 | `packages/subagent-effect` | `pi-subagent-effect` | Ready subagent tools, foreground and background, with typed results and a share of the parent's budget |
| P2 | `packages/router-effect` | `pi-router-effect` | Model routes with fallback, a concurrency limiter with backoff, prices, region and classification filters; serves Pi through the model bridge |
| P2 | `packages/search-effect` | `pi-search-effect` | Search and fetch tools behind a provider port; an Exa adapter; raw results kept so a product can capture evidence |
| P2 | `packages/review-effect` | `pi-review-effect` | Work that must pass before an answer stands: a second model of another family, a citation check, at most N corrective runs |
| P3 | `packages/workflow-effect` | `pi-workflow-effect` | Fixed-step workflows written as Effect generators and run as Pi tasks |
| P3 | `packages/sandbox-effect` | `pi-sandbox-effect` | A sandbox port with an agentOS adapter |

### 5.3 The two model bridges (in `ai-effect`)

- **Pi serves Effect.** `PiLanguageModel.layer(modelRef)` gives an `effect/ai` `LanguageModel` backed by a
  `pi-ai` model, so any Effect AI program gets Pi's providers and catalog.
- **Effect serves Pi.** `EffectProvider.make({ id, models, layer })` gives a `pi-ai` provider (through the
  public `createProvider()`) backed by an `effect/ai` `LanguageModel` Layer, so `@effect/ai-openrouter`,
  `@effect/ai-anthropic` or a product's router can drive a Pi harness.

OpenRouter is therefore reachable twice: Pi's `openrouterProvider()` and `@effect/ai-openrouter`.

### 5.4 What depends on what, and where each could live

| Package | Depends on (besides `effect`) | Natural home if it moves |
|---|---|---|
| `schema-effect` | `pi-schema` | Pi |
| `ai-effect` | `pi-ai`, `schema-effect` | Pi |
| `telemetry-effect` | `pi-telemetry` | Pi |
| `durable-effect` | `pi-durable`, `ai-effect`, `schema-effect`, `chord-effect` (the Chord context of its calls) | Pi |
| `mcp-effect`, `codemode-effect`, `agent-effect` | the Pi package each wraps, and `durable-effect` where it adds tools | Pi |
| `env-effect` | `pi-env`, `pi-durable` (Pi's environment contract, `ExecutionEnv` and its results, is declared in `pi-durable/env`), `chord-effect` (the Chord context of its calls, with the calling fiber's span) | Pi |
| `chord-effect` | `chord`, `telemetry-effect` (the calling fiber's current span in the contexts it makes) | Pi |
| `tui-effect` | `pi-tui` | Pi |
| `coding-agent-effect` | `pi-coding-agent`, `agent-effect`, `ai-effect`, `mcp-effect` (MCP tools as Pi tools), `env-effect` (where bash runs its commands), `schema-effect`, `tui-effect` (interactive mode and its components) | Pi |
| `evals-effect` | `pi-evals`, `ai-effect` | Pi |
| `recorder-effect`, `guard-effect`, `budget-effect`, `approvals-effect`, `subagent-effect`, `review-effect`, `workflow-effect` | `durable-effect` only | Pi, as extensions, or their own repository |
| `router-effect` | `ai-effect` only | Its own repository; it is useful without a harness |
| `search-effect` | `durable-effect` for the tools; the provider port alone needs nothing | Its own repository |
| `swarm-effect` | `durable-effect`; the Rivet driver is an optional subpath that needs `durable-rivet-effect` | Pi, or Rivet for the actor driver |
| `durable-rivet-effect` | `durable-effect`, `chord-effect` (Chord's SQLite database type and its prefix rule), `rivetkit`, `@rivetkit/effect` | **Rivet** (`rivet-dev/agents`, next to `@rivet-dev/pi`), or ours |
| `sandbox-effect` | `durable-effect`; the agentOS adapter is an optional subpath | Rivet for the agentOS adapter |

Rules that keep this true: no cycles; a plugin never imports another plugin, it composes through
`durable-effect`'s extension and hook types; anything Rivet-specific sits in a package or subpath with
`rivet` in its name; `effect/scripts/check-deps.ts` fails CI on an undeclared import between our packages.

**Rivet as a second upstream.** The Rivet host and the agentOS adapter are the two pieces that belong with
Rivet more than with Pi. They are written so that they can be offered to `rivet-dev/agents` unchanged: they
use only Rivet's and Pi's public interfaces, and MIT code can be contributed to an Apache-2.0 project. Until
then they live here. We do not fork `rivet-dev/agents` now; one fork to keep in sync is enough, and the
packages do not need its source.

## 6. `pi-durable-effect` in detail

### 6.1 Mapping

| Pi Durable | Effect facade |
|---|---|
| `Harness.open(storage, options, context)` and `close` | `Harness.layer(options)`: a scoped Layer; closing the Scope closes the harness. Requires `HarnessStorage`, `Models`, `Registry` |
| `openNodeSqliteStorage`, `SqliteStorage.open(database, { prefix })`, `MemoryStorage` | `Storage.memory`, `Storage.sql({ prefix })` over any Effect `SqlClient` with the SQLite dialect (Bun, Node, wasm, Durable Objects), `Storage.custom` |
| Pi's `context` argument (cancellation, deadline) | Derived from the fiber: interrupting the Effect aborts the Pi call; a Pi abort fails the Effect with a typed error |
| `harness.root`, `conversation`, `createConversation` | `Harness.root`, `Harness.conversation(id)`, `Harness.createConversation(options)` returning `Conversation` values |
| `submit`, `Submission.wait`, `abort`, `status` | `Conversation.submit(draft)` returns a `Submission` with `wait`, `abort`, `status` as Effects; `Conversation.prompt(input)` is submit then wait |
| `fork(entryId, options)` | `Conversation.fork({ at, ownership, agent })` |
| `configure`, `compact`, `reset`, `waitForIdle`, `entries`, `context` | The same names as Effects; `entries` as a `Stream` |
| `watch`, `watchTaskGraph`, `observeConversation` | `Conversation.changes`, `Harness.taskGraph` as `Stream`s that release their watch with the Scope |
| `defineTool({ name, parameters, replay, execute })` | `Tool.make(name, { parameters: Schema, success: Schema, replay, callers, handler })`; the handler returns `Effect<A, E, R>`; `R` is provided from a Layer when the registry is built |
| An `effect/ai` `Toolkit` | `Tool.fromToolkit(toolkit)`: existing Effect AI tools become Pi tools |
| `hook(GenerationTask, …)`, `hook(ToolTask, …)` | `Hook.beforeRequest`, `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools`, `afterRun`, `beforeCompact`, `beforeTool`, `afterTool`, each an Effect |
| `beforeTool` returning block, rewrite or sleep | `Gate.allow`, `Gate.block(reason)`, `Gate.rewrite(args)`, `Gate.park({ signals, until })` |
| `defineSignal`, `harness.signal`, `api.readSignal` | `Signal.make(name, version, Schema)`, `Harness.signal(taskId, signal, key, value)` |
| `defineTask({ phases, abort })`, `tx.createTask`, waiting on children | `Task.make({ name, version, input, state, result, phases, abort })` with phases as Effects; `Task.children(ids, "allSettled" or "failFast" or "any")`; `Task.sleepUntil` |
| `defineDoc`, `defineEntry` | `Doc.make`, `Entry.make` with `Schema` |
| `defineExtension`, `createRegistry` | `Extension.make({ tools, hooks, tasks, docs })`, `Registry.layer(extensions)` |
| `harness.usage`, `docs["pi.usage"]` | `Harness.usage`; `Harness.usageEvents` as a `Stream` of per-call usage |
| `now`, `setTimer`, `onWake`, `onReport` | Effect `Clock` (so `TestClock` drives sleeps), a wake `Queue` for hosts, reports to the Effect logger and an optional sink |
| Pi error classes and result codes | A closed union of `Schema.TaggedError`s: `StorageRequestError`, `TaskOutcomeError`, `ReadOnlySession`, `ConversationIdle`, `ToolBlocked`, and the rest |

### 6.2 Target shape (illustrative, not final)

```ts
import { Effect, Layer, Schema } from "effect";
import { Conversation, Gate, Harness, Hook, Registry, Storage, Tool } from "pi-durable-effect";
import { Models } from "pi-ai-effect";

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: ({ id }) => Records.get(id), // Effect<{ title }, NotFound, Records>
});

const NoWrites = Hook.beforeTool((call) =>
	call.name.startsWith("write") ? Effect.succeed(Gate.block("read only")) : Effect.succeed(Gate.allow),
);

const program = Effect.gen(function* () {
	const root = yield* Harness.root;
	yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
	yield* root.waitForIdle;
	const head = yield* root.head;
	const branch = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
	return yield* branch.prompt("Now argue the opposite.", { requestId: "opposite-42" });
});

const live = Harness.layer({ settings: {} }).pipe(
	Layer.provide(Registry.layer([{ name: "app", tools: [Lookup], hooks: [NoWrites] }])),
	Layer.provide(Storage.sql({ prefix: "pi_" })),
	Layer.provide(Models.layer([/* providers */])),
);
```

### 6.3 Requirements

- D1. Every public function returns `Effect` or `Stream`. No promise, no callback, no `any`.
- D2. Interruption is abort, in both directions, and never leaves a turn half recorded.
- D3. A handler's requirements are checked at compile time: a registry whose tools need `Records` does not
  build without it.
- D4. `Storage.sql` passes Pi's own `registerStorageConformance()` on Bun's SQLite and Node's.
- D5. Reopening the harness on the same storage resumes pending work (`resume()`), exposed as part of the
  Layer's start, with a read-only mode.
- D6. `TestClock` advances Pi's sleeps and deadlines.
- D7. No behaviour is added. A feature that is not in Pi Durable belongs in a plugin.

## 7. Plugin requirements

| Plugin | Must hold |
|---|---|
| recorder | A step and its pending record commit together. A crash between a model call and its delivery never loses or doubles a record. Ids are derived from conversation, run and step, so a redelivery is recognised. The sink is an Effect service the product provides |
| guard | A tool outside the allow-list is not offered to the model and is blocked if called. A denied verb fails registry construction. Rules run before approvals and budgets |
| budget | No provider request without a live lease. Usage of failed and aborted attempts is settled too. A fenced lease parks the conversation with a typed reason; nothing is retried on a dead lease |
| approvals | A decision binds to the digest of the arguments it saw; changed arguments ask again. A parked call survives restarts. Deciders are authenticated by the host, never by the plugin |
| durable-rivet | One actor is one harness storage. Wake-ups use actor alarms. `fork` returns a handle to a new actor; `onFork` drops inherited pending records, leases and schedules before the first call. A fork is made only of an idle harness |
| swarm | Keyed forks, so a retried job never makes a second copy. A cap on live forks. The coordinator survives a crash and finds its forks again. Unpinned forks are destroyed. Results are decoded against a `Schema` |
| subagent | The child starts from a declared agent, not the parent's tools. Parent abort reaches attached children; background children outlive it. A child's budget comes out of the parent's |
| router | A model id comes only from the route table. A route names provider, model, region, classification ceiling and price. Fallback is explicit and recorded |
| search | The tool result keeps the raw response and its retrieval time. The provider port has Exa first; adding one is one file |
| review | The reviewer's model family differs from the author's. A failed review produces at most N corrective runs, then the conversation is held |

## 8. Requirements for all packages

- **Runtimes:** Bun 1.4 or later and Node 22.19 or later. No `node:` import in a package core; platform code
  sits behind subpath exports, as upstream does.
- **Effect:** 4.1.x, declared as a peer so a consumer has one copy. `effect/ai` and `effect/workflow` only
  through public modules.
- **Upstream dependency:** each facade depends on exactly one upstream version; a table in `effect/COMPAT.md`
  says which of ours works with which of theirs.
- **Style:** upstream's Biome config and erasable TypeScript; Effect idioms; errors as `Schema.TaggedError`;
  no `throw` in library code; no cast except at a decode boundary.
- **Determinism:** time and ids only through services; every package testable with scripted models.
- **Performance:** the facade adds under 5% to a scripted 100-turn run; fork of an idle conversation under
  20 ms in memory and under 100 ms on SQLite; a 50-fork swarm with scripted models under 5 s.
- **Security:** credentials through `Config` and `Redacted`; nothing logs prompt content by default.

## 9. Repository plan

### 9.1 Branches

- `main` mirrors `earendil-works/pi` `main` and only fast-forwards. Nobody commits to it.
- `effect` is the default branch of the fork: `main` plus our commits. All work lands there.
- An upstream contribution is a branch off `main`, never off `effect`.

### 9.2 The boundary

A commit on `effect` may touch only:

- `packages/*-effect/**`
- `effect/**` (this PRD, `COMPAT.md`, `AGENTS.md` for our packages, scripts, design notes)
- `.github/workflows/effect-*.yml`
- `package-lock.json`, regenerated by `npm install --package-lock-only --ignore-scripts`, never by hand
- a short list of root lines recorded in `effect/boundary.json`, each with its reason, if milestone 0 shows
  one is unavoidable (candidates: path entries in `tsconfig.json`, aliases in `vitest.base.ts`)

`effect/scripts/check-boundary.ts` compares `main...effect` against that list and fails CI otherwise. If the
root lines prove painful, the fallback is to move our packages to `effect/packages/*` with their own
workspace; the code does not change.

### 9.3 Tooling

| Concern | Upstream way (kept green) | Our fast lane (added) |
|---|---|---|
| Install | npm workspaces, exact pins | the same lockfile |
| Format and lint | Biome, upstream config | the same |
| Typecheck | `tsc` through `npm run check` | `tsrs` per package |
| Tests | Vitest on Node through `./test.sh` | the same test files under `bun test` |
| Build | `tsc -p tsconfig.build.json` per package | `effect/scripts/build.ts`, in dependency order |

### 9.4 CI (`effect-ci.yml`, guarded to run only in this fork)

1. Boundary check.
2. `npm run check` and `./test.sh` unchanged from upstream.
3. Our packages: tsrs, `bun test`, storage conformance on both SQLite drivers.
4. Nightly: fast-forward `main`, merge into `effect`, regenerate the lockfile, run everything, open a pull
   request in the fork if anything breaks.

Upstream's own workflows (issue gates, contributor approval, publishing) stay disabled in the fork.

### 9.5 Versions and publishing

- Our packages share one version, starting at 0.1.0, independent of upstream's.
- Each release records the upstream version it was built and tested against in `COMPAT.md`.
- Published from the fork under our scope with npm provenance. PatentOS pins exact versions.

### 9.6 Working with upstream

- We do not open issues or pull requests on `earendil-works/pi` from automation, ever: their rules block
  accounts for it. A person writes, in their own words, and only when we have something small and concrete.
- The first contact is a short note in their Discussions or Discord once the three P0 facades work, saying
  what exists and asking whether they want any of it.
- If they want a package, it moves as a directory with its history. If not, nothing changes for us.
- The Rivet host is offered to Rivet the same way, since `@rivet-dev/pi` is theirs.

### 9.7 Rules for agents working in the repository

Upstream's `AGENTS.md` binds every agent (run from the repository root, `npm run check` after code changes,
never the full Vitest suite directly, no emojis, erasable TypeScript only, exact pins). `effect/AGENTS.md`
adds ours: the boundary, Effect idioms, one heavy command at a time, and never editing an upstream package.

## 10. Tests

| Kind | What |
|---|---|
| Parity | For each facade function, a test that the Effect call and the Pi call leave the same storage records |
| Conformance | Pi's storage conformance suite against `Storage.sql` on Bun and Node SQLite |
| Kill and resume | Close the harness at every step boundary of a scripted run and reopen: no step runs twice, no record doubles |
| Interruption | Interrupt at every await point: the conversation is idle and consistent afterwards |
| Type tests | A registry with an unprovided requirement does not compile; tool arguments are inferred from `Schema` |
| Fork and swarm | 50 forks of a 30-turn conversation, keyed retries, cap respected, fan-in typed |
| Upgrade | The whole suite reruns on every upstream version bump before `COMPAT.md` changes |

## 11. Milestones

| | Outcome | Done when |
|---|---|---|
| M0, 2 to 3 days | The repository works and the unknowns are settled | `effect` branch, boundary check, CI in the fork; an empty `packages/schema-effect` passes upstream's `npm run check` and `./test.sh` and our Bun lane; answers written down for every item of section 12; the scope and names decided |
| M1 | The three P0 facades | `schema-effect`, `ai-effect` (both bridges, scripted models), `durable-effect` (harness, conversations, tools, hooks, gates, signals, storage, errors, testing kit); parity, conformance, kill-and-resume and interruption tests pass on Bun and Node |
| M2 | Record and control | `recorder-effect`, `guard-effect`, `budget-effect`, `approvals-effect`; PatentOS runs its agent thread on them and deletes its loop (`packages/compute/src/agent/Thread.ts`, 739 lines); its `AgentWork` port is bound |
| M3 | Rivet, forks, swarms | `durable-rivet-effect`, `swarm-effect`, `subagent-effect`; PatentOS binds `SwarmRunner` and `ForkRuntime`; the 50-fork test passes on Rivet locally |
| M4 | Models, search, review | `router-effect` with OpenRouter, `search-effect` with Exa, `review-effect`, `telemetry-effect` |
| M5 | The rest | tasks and child tasks in `durable-effect`, `workflow-effect`, `mcp-effect`, `codemode-effect`, `sandbox-effect` |

What PatentOS keeps and plugs in as Layers: its tool registry built from each context's `AgentApi`, the
recorder sink that sends commands to the Agents context, the Spend lease, the Providers route table and its
host seam. What it deletes: the hand-written loop and the sequential swarm runner.

## 12. Risks and what is not verified

| Risk or unknown | Plan |
|---|---|
| Pi Durable changes without notice | One exact upstream pin; the nightly sync; the parity suite tells us what moved |
| Lockfile and root-file conflicts on every sync | The lockfile is regenerated, never merged; the boundary list keeps root edits few; fallback layout in 9.2 |
| Not verified: Pi Durable and its tests under Bun | Milestone 0. Upstream says the portable SQLite and JSONL cores run on Bun |
| Not verified: Bun running upstream-style Vitest files | Milestone 0. If not, our lane runs Vitest on Node and Bun only runs the kill-and-resume and conformance suites |
| Not verified: `createProvider()` can host an `effect/ai` model with streaming, tools and usage intact | Milestone 0 spike for the second bridge |
| Not verified: upstream checks (`check-pinned-deps`, `check-entry-graphs`, `check-runtime-deps`) accept a new package and a peer range on `effect` | Milestone 0 |
| Not verified: `@rivetkit/effect` exposes what a harness host needs (raw SQLite, alarms, fork, `onFork`) | Milestone 0. PatentOS's current Rivet host uses `rivetkit` directly and works |
| Two SQLite writers in one actor (Pi and the product) | Pi's table prefix and one shared database adapter, as Pi documents for shared databases |
| Forks copy pending records, leases and schedules | `onFork` hygiene in the Rivet host; a test that a fork starts clean |
| The unscoped name is taken and a scope is needed | Section 13 |
| Upstream never wants the packages | Nothing depends on it |

## 13. Decisions for the owner

1. **npm scope.** Decided on 2026-11-26: the organisation scope `@effectified`, without the `-effect` suffix
   (`@effectified/pi-durable`). The repository moved to `effectified/pi` with it.
2. **Default branch.** `effect` as the fork's default, `main` as a pure mirror (assumed above).
3. **Layout.** `packages/*-effect` inside upstream's workspace (assumed above, best for a later merge) or
   `effect/packages/*` with its own workspace (zero conflicts, a directory move away from mergeable).
4. **Rivet host.** Our own Effect host on Pi's public storage interface (assumed above, because Rivet's
   adapter lags and is not Effect), or a wrapper around `@rivet-dev/pi`. And its home: here, offered to
   Rivet later (assumed), or a second fork of `rivet-dev/agents` from the start.
5. **When to talk to upstream.** After milestone 1 (assumed), or not until asked.

## Appendix A. Versions on 2026-11-24

| Package | Version | Licence |
|---|---|---|
| `@earendil-works/pi-durable`, `pi-ai`, `pi-agent-core`, `pi-schema`, `pi-codemode`, `pi-telemetry`, `pi-mcp`, `pi-env`, `chord` | 1.6.0 | MIT |
| `@rivet-dev/pi`, `@rivet-dev/sandbox-adapter` | 0.5.7 | Apache-2.0 |
| `rivetkit`, `@rivetkit/effect` | 3.1.1 | Apache-2.0 |
| `effect`, `@effect/ai-openrouter`, `@effect/ai-anthropic`, `@effect/ai-openai` | 4.1.5 | MIT |
| `exa-js` | 2.29.0 | MIT |
| TypeScript, Biome, Vitest (upstream pins) | 7.0.2, 2.3.5, 4.1.12 | |

## Appendix B. The public Harness surface the facade must cover

From the Pi Durable specification, section 2.2.

- `Harness`: `open`, `resume`, `wake`, `root`, `conversation`, `createConversation`, `getTask`, `inspect`,
  `submission`, `abortSubmission`, `abortTask`, `signal`, `waitForTask`, `waitForIdle`, `usage`,
  `watchTaskGraph`, `observeConversation`, `observeTaskGraph`.
- `Conversation`: `submit`, `admit`, `agent`, `configure`, `commit`, `context`, `entries`, `fork`, `compact`,
  `reset`, `abort`, `waitForIdle`, `watch`.
- `Submission`: `status`, `wait`, `abort`.
- Definitions: `defineTool`, `defineTask`, `defineSignal`, `defineDoc`, `defineDocFamily`, `defineEntry`,
  `defineExtension`, `createRegistry`, `hook`, `hookTask`, `wrapTool`, `configure`.
- Built-in tasks with hooks: `GenerationTask`, `ToolTask`, `CompactionTask`.

## Appendix C. Related work

| Project | What it is | Why it is not this |
|---|---|---|
| `pi-effect` 0.2.0 on npm (another author) | An Effect adapter around the Pi coding agent SDK | Not the durable harness; built on an Effect 4 beta; last published July 2026 |
| `@rivet-dev/pi` | Rivet's actor adapter for Pi Durable | Promise-based; pins Pi Durable `~1.5.0` |
| Yielded Agent (`@yielded/agent`) | An Effect-native durable agent runtime | No fork, no Rivet host; ideas worth borrowing: reconciling uncertain writes, a budget tree, approval records |
| Tardigrade (`tardie`) | Agents as state machines over an immutable event log | Pins another Effect version, no host interface; ideas worth borrowing: its actor checker with generated trajectories |
| Flue | The Astro team's framework on `pi-agent-core` | Sandbox-centred; its Rivet integration needs a fork and an older RivetKit |
