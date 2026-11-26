---
name: pi-effect
description: Map of the fifteen pi-effect packages (@gunta/pi-*-effect), the Effect 4.1 binding of Pi Durable agents and its plugins. Says which package and export answers which need (an agent thread, tools, hooks, tasks, documents, models, routing, budgets, guards, approvals, review, records, subagents, swarms, search, telemetry, Rivet actors), how facades, plugins, the Rivet host and the thread composition layer, what a product supplies as ports and as data, and the rules that hold in every package (Effect 4.1 only, tagged errors, interruption, Clock, what Pi Durable gives and withholds). Use it first whenever a task names a @gunta/pi-*-effect package, Pi Durable, pi-ai, Composition, Threads, Harness, Registry, Extension or a Rivet actor, to pick the package and the next skill to read.
---

# pi-effect: the map

## What it is

- Pi Durable (`@earendil-works/pi-durable`) is a durable agent harness: conversations, tools, hooks, tasks and forks
  whose state is stored, so a later process continues the work. It is promise-based and experimental.
- pi-effect is fifteen packages that give it, and Pi's model library, in Effect 4.1 terms, plus the behaviour every
  product needs (guards, budgets, approvals, review, records, routing, subagents, swarms, search, a Rivet host).
- Every public function returns an `Effect`, a `Stream` or a `Layer`. No promise and no callback option in a signature.
- Nothing in it knows a product. Tools, names, prices, labels and rules come from the product as data and as ports.
- Built for Pi 1.6.1, `effect` 4.1.5 (peer `~4.1.5`), `rivetkit` 3.1.1 (peer `~3.1.1`), Node 22.19 or later, Bun.

## Which skill next

| The task | Read |
|---|---|
| Build, wire or change an agent thread in one process: `Composition`, `Threads`, outcomes, records, money, review, approvals, subagents, swarms | `pi-effect-thread` |
| Host threads or a harness in Rivet actors: `ThreadActor`, `Remote`, `Actor`, `Client`, a local engine, wake-ups, forks, `ActorSql` | `pi-effect-rivet` |
| Write a tool, a hook, a gate, a signal, a task, a stored document or a plugin of your own | `pi-effect-extending` |
| Test any of it with no network and no key: scripted models, `TestHarness`, `runTest`, restarts, engine tests | `pi-effect-testing` |
| Work inside the pi-effect repository itself (its packages, gate and checks) | `pi-effect-contributing` |
| Bring the pi-effect repository up to a new upstream Pi release | `pi-effect-upstream-sync` |

## The packages

| Need | Package | Kind | Entry exports | README |
|---|---|---|---|---|
| An agent thread worked from one call, guarded, budgeted, routed, recorded, reviewed | `@gunta/pi-thread-effect` | composition | `Composition.open`, `Threads`, `Swarms`, `OutcomeSink`, `Outcome`; `/rivet`: `ThreadActor`, `Remote` | [thread](../../../thread-effect/README.md) |
| The durable harness: conversations, commits, tools, hooks, gates, signals, tasks, documents, entries | `@gunta/pi-durable-effect` | facade | `Harness`, `Registry`, `Extension`, `Tool`, `Hook`, `Gate`, `Signal`, `Task`, `Doc`, `Entry`, `Storage`; `/testing`: `TestHarness` | [durable](../../../durable-effect/README.md) |
| Models: requests as `Stream` and `Effect`, the two `effect/ai` bridges, the key of a request | `@gunta/pi-ai-effect` | facade | `Models`, `getModel`, `stream`, `complete`, `PiLanguageModel`, `EffectProvider`, `requestKey`, `ANSWERED`; `/testing`: `ScriptedModels`, `runTest`, `conditions` | [ai](../../../ai-effect/README.md) |
| Effect `Schema` to and from the JSON Schema of tool parameters | `@gunta/pi-schema-effect` | facade | `toJsonSchema`, `fromJsonSchema`, `decodeUnknown`, `encode`, `validator` | [schema](../../../schema-effect/README.md) |
| Pi's spans, metrics and events on Effect's tracer, metrics and logger | `@gunta/pi-telemetry-effect` | facade | `PiTelemetry` | [telemetry](../../../telemetry-effect/README.md) |
| A harness inside a Rivet actor: actor SQLite as storage, schedules as wake-ups, actor forks | `@gunta/pi-durable-rivet-effect` | host | `Actor`, `Action`, `Client`, `Host`, `Self`, `ActorSql`, `ActorInfo`; `/node` and `/bun`: `serve`; `/testing` | [rivet host](../../../durable-rivet-effect/README.md) |
| An exact tool allow-list per conversation, denied verbs, argument rules, classification ceilings | `@gunta/pi-guard-effect` | plugin | `Guard`, `Conversations`, `Policy`, `Matcher`, `Rule`, `Refused` | [guard](../../../guard-effect/README.md) |
| Money reserved and settled for every provider request under the product's lease | `@gunta/pi-budget-effect` | plugin | `BudgetedModels`, `Lease`, `Estimator`, `Prices`, `Shares`, `Spend`, `stopOf`, `continueStopped` | [budget](../../../budget-effect/README.md) |
| Aliases served by routes, fallback, limiter, prices, per-conversation constraints | `@gunta/pi-router-effect` | plugin | `Router`, `RouteTable`, `ConstraintSource`, `AttemptSettlement`, `priceRows`, `RouteEvents` | [router](../../../router-effect/README.md) |
| A person's approval of a tool call, bound to its arguments | `@gunta/pi-approvals-effect` | plugin | `extension`, `Inbox`, `decide`, `approve`, `deny`, `pending`, `applied` | [approvals](../../../approvals-effect/README.md) |
| Every message, model call and tool call to the product's sink, at least once, under fixed ids | `@gunta/pi-recorder-effect` | plugin | `Recorder`, `RecordSink`, `Records`, `Advisory`, `onStorageFork` | [recorder](../../../recorder-effect/README.md) |
| Review by a model of another family, checks, corrections, holds a person releases | `@gunta/pi-review-effect` | plugin | `extension`, `Policy`, `Check`, `Citations`, `state`, `verdicts`, `release`, `retry` | [review](../../../review-effect/README.md) |
| Tools that delegate to declared child agents, foreground and background | `@gunta/pi-subagent-effect` | plugin | `Subagents`, `Subagent`, `ChildSetup`, `Child` | [subagent](../../../subagent-effect/README.md) |
| Keyed forks of a primed conversation under a cap, typed fan-in | `@gunta/pi-swarm-effect` | plugin | `make`, `start`, `status`, `result`, `cancel`, `ConversationForks`, `ForkSetup`; `/rivet`; `/driver` | [swarm](../../../swarm-effect/README.md) |
| Web search and fetch tools that keep the raw evidence; an Exa adapter | `@gunta/pi-search-effect` | plugin | `SearchTools`, `SearchProvider`, `Evidence`, `Limits`; `/exa`; `/provider` | [search](../../../search-effect/README.md) |

Modules are namespaces: `import { Harness, Tool } from "@gunta/pi-durable-effect"`, then `Harness.root`,
`Tool.make`. A few packages are imported whole: `import * as Approvals from "@gunta/pi-approvals-effect"`,
`import * as Review from "@gunta/pi-review-effect"`, `import * as Swarm from "@gunta/pi-swarm-effect"`. Copy the
import lines of the README example you start from.

Not built: an MCP facade, code mode, the non-durable agent loop, remote environments, fixed-step workflows, a
sandbox. Reach what a facade does not wrap through Pi's own objects (each README ends with "Not wrapped yet").

## How the kinds layer

- **Facade** (`ai`, `durable`, `schema`, `telemetry`): one per Pi package. It adds no behaviour: what Pi does is what
  happens, in Effect terms. Pi's own objects stay reachable (`yield* Harness.Harness` is Pi's harness).
- **Plugin** (`guard`, `budget`, `router`, `approvals`, `recorder`, `review`, `subagent`, `swarm`, `search`): our
  behaviour, written on the facades. Each gives `Extension`s (tools, hooks, tasks), `Layer`s and services.
- **Host** (`durable-rivet-effect`): runs a harness inside a Rivet actor.
- **Composition** (`thread-effect`): all of them composed in the order their READMEs require, in one process and as
  one Rivet actor per thread. Nothing depends on it.

The rules that keep this true:

- A plugin never imports another plugin. Plugins meet only in a product's composition: the product installs their
  extensions in one registry, in order, and wires one plugin's port with another's service in product code. The
  registry is `Registry.layer([...])`, or with a guard `Guard.layer({ policy, rules, extensions })` (or
  `Guard.registry`), which builds it and puts the guard's own extension first: a harness on a plain
  `Registry.layer` is not guarded ([Quick start](../../../guard-effect/README.md#quick-start)). Examples of wiring:
  the budget's `Spend` behind the router's `AttemptSettlement`
  ([With a budget](../../../router-effect/README.md#with-a-budget)); the guard's `Conversations.grantIn` and the
  budget's `Shares` behind the subagent's `ChildSetup` ([The setup port](../../../subagent-effect/README.md#the-setup-port)).
- Hooks are asked in extension order, so order is behaviour: the guard first, a product's tools, approvals after
  everything that blocks or rewrites a call, the review as the only `onYield` hook, the recorder's advisory hook
  last. The composition's table: [The order, and why](../../../thread-effect/README.md#the-order-and-why).
- Models are layers of wrappers: the providers, the router on them, the budget on the same plain `Models`, the
  harness on the budgeted one. Never give the router the budgeted `Models`.
- A product that wants the whole thread uses `@gunta/pi-thread-effect` and does not rebuild this order by hand.

## What a product supplies

**Data**, as plain values or decoded `Schema`s: tools in extensions, the guard's `Policy`, the approval policy,
providers and a `RouteTable` with prices, the review `Policy` with its family table, subagent declarations, swarm
definitions, search limits.

**Ports**, as `Context.Service`s the product provides in a `Layer` (never a callback option):

| Port | Package | Called with |
|---|---|---|
| `Lease` (`reserve`, `settle`), `Estimator`, `Prices` | budget | Every provider request of the harness, on one lease: reserve before it is sent, settle once after it ends; the request names its conversation and session |
| `RecordSink` (`deliver`) | recorder | Batches of records, at least once: idempotent by `record.id` |
| `OutcomeSink` (`deliver`) | thread | Each outcome event of a thread, at least once: idempotent by `event.id` |
| `Approvals.Inbox` (`publish`) | approvals | Each request for a person, at least once: idempotent by `request.id` |
| `ChildSetup`, `ForkSetup` | subagent, swarm | Inside the commit that creates a child or a fork: grant it, cap it |
| `ConstraintSource`, `AttemptSettlement` | router | Every request: the conversation's constraints; each billed attempt another route takes over |
| `Review.Citations.Verifier`, `SearchProvider` | review, search | Each citation to verify; each search and fetch |
| `PiTelemetry` | telemetry | Pi's spans and metrics |
| `HarnessStorage` | durable | `Storage.sql()` over an Effect SQLite client, or the actor's SQLite in Rivet |

A missing service is a compile error: what a tool, hook, rule or check needs joins the requirements of the
registry `Layer`. The composition's port table is under [Install](../../../thread-effect/README.md#install).

## True in every package

- **Effect 4.1.5 only.** Its API differs from Effect 3 in names and shapes (`Context.Service` classes,
  `Schema.TaggedError`, `Schema.Union([...])`, `Effect.forkChild`). Do not write Effect code from memory: read the
  declaration in `node_modules/effect/dist/*.d.ts`, and the package's own `.d.ts` for its exports, before calling
  a function. Start from a README example: each one is run by that package's tests.
- **Errors are tagged.** Every failure is a `Schema.TaggedError` class; handle it with `Effect.catchTag` or
  `Effect.catchTags`. Calls into Pi fail with the closed union `DurableError`
  ([Errors](../../../durable-effect/README.md#errors)). Nothing throws.
- **Interruption is cancellation, both ways.** Interrupting a fiber cancels the Pi call it is in, and a Pi abort
  interrupts the handler's fiber. Interrupting a wait (`prompt`, `Submission.wait`, `waitForIdle`) cancels only the
  wait: the run goes on. `Conversation.abort` and `Harness.abortTask` stop work
  ([Interruption](../../../durable-effect/README.md#interruption)).
- **Time comes from `Clock`.** Pi's clock, its sleeps, retry backoffs and the deadlines of parked calls are Effect's
  `Clock`, read when the harness is built. Every process that opens one storage must use the same clock
  ([Time](../../../durable-effect/README.md#time)).
- **What Pi defines is not written a second time.** Use the shared forms the facades export instead of restating Pi:
  `ANSWERED`, `TOKEN_KINDS`, `ModelRef` ([Values that follow pi-ai's types](../../../ai-effect/README.md#values-that-follow-pi-ais-types)),
  `Task.ended`, `Submission.settled`, the id schemas `Conversation.Id`, `Entry.Id`, `Task.Id`, and `Agent.ByName`.
- **What a plugin stores is in the harness storage**, through documents, entries, memos and commits, under kinds
  prefixed by the plugin (`recorder.cursor`, `budget.share`, `thread.work`). A fork copies it.
- **With a guard, a conversation calls only what it was granted.** One without a grant may call nothing (the
  policy's `ungranted`), and a tool outside the grant is not even offered to the model.
- **To act on a committed step** (a message, a tool result, a model call), use the recorder's `RecordSink`, which
  gets each one after Pi committed it, at least once, under a fixed id. Not a hook: `afterTool` runs before the result
  is committed, and Pi may ask it again ([Records](../../../recorder-effect/README.md#records)).

### What Pi Durable gives and withholds

These hold for every tool, hook and task, in every package:

| Fact | So |
|---|---|
| A hook answers; it cannot commit. Its only write is a memo, a commit of its own | What must be atomic with a step is the step's own entry, a tool's `api.commit`, a task's commit, or a host commit |
| Pi asks a hook again after a crash or a close that came before its answer was committed, and `beforeTool` at every wake and reopen of a parked call | What a hook does outside must be idempotent. A decision that must not change is a memo with a candidate (first writer wins) |
| A failing hook is reported and skipped: it fails open. Only `beforeTool` fails closed | No generation hook can stop a provider request. Money and routes are enforced at the `Models` boundary |
| A model request a close stopped is sent again on reopen | One more request and one more reservation; the budget's `requestKey` names both sends alike |
| A `replay: "unsafe"` tool never runs twice: Pi writes an `interrupted` result. A `replay: "safe"` tool runs again | Mark a tool safe only when running it twice is harmless |
| Interrupting a caller never stops a run | Stop work with `Conversation.abort` or `Harness.abortTask` |
| Memory storage cannot be reopened | A restart test uses a SQLite file (see `pi-effect-testing`) |
| Pi Durable 1.6 is experimental; stored data rolls forward only | Pin the versions the packages pin |

The evidence for each is in [Hook](../../../durable-effect/README.md#hook), [Tool](../../../durable-effect/README.md#tool)
and [Interruption](../../../durable-effect/README.md#interruption).

## Installing in a product

- Every package names `effect` as a peer (`~4.1.5`): the application has one copy. The Rivet entries also need
  `rivetkit` (`~3.1.1`). Each README's "Install" section lists the Pi packages it needs beside it.
- In a product that vendors the packages, each sits beside `docs-effect/` (the package that holds these skills) as
  `<package>-effect/`, with its `README.md` and its built output, so the links of this skill resolve there as here.
  The README is the reference; the `.d.ts` files are the signatures.
- The package cores import no `node:` or `bun:` module; platform code is behind a subpath of its own. Pick the
  entry for the runtime: the Rivet host's local engine is `/node` or `/bun`, an SQLite client is
  `@effect/sql-sqlite-node` or `@effect/sql-sqlite-bun`.

## Where to read more

- Each package's README is the source of truth; its examples run as tests. Its sections "Guarantees and their
  limits" (or "What holds" and "Limits") say what is promised and what is not.
- What a product inherits from all of them at once:
  [Limits the packages document, which a product inherits](../../../thread-effect/README.md#limits-the-packages-document-which-a-product-inherits).
- What a hand-written agent loop maps to:
  [From the consumer's loop to the packages](../../../thread-effect/README.md#from-the-consumers-loop-to-the-packages).
