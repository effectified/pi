# How pi-effect Works

## What it is

- Pi Durable (`@earendil-works/pi-durable`) is a durable agent harness: conversations, tools, hooks, tasks and forks
  whose state is stored, so a later process continues the work. It is promise-based and experimental.
- pi-effect gives it, and every other package of Pi (models, agents, MCP, environments, the terminal UI, the coding
  agent and its extensions), in Effect 4.1 terms, plus the behaviour every product needs (guards, budgets, approvals, review, records, routing, subagents, swarms, search, a Rivet host).
- Every public function returns an `Effect`, a `Stream` or a `Layer`. No promise and no callback option in a signature.
- Nothing in it knows a product. Tools, names, prices, labels and rules come from the product as data and as ports.
- Built for Pi 1.6.1, `effect` 4.1.5 (peer `~4.1.5`), `rivetkit` 3.1.1 (peer `~3.1.1`), Node 22.19 or later, Bun.

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
  `Registry.layer` is not guarded ([Quick start](../../guard-effect/README.md#quick-start)). Examples of wiring:
  the budget's `Spend` behind the router's `AttemptSettlement`
  ([With a budget](../../router-effect/README.md#with-a-budget)); the guard's `Conversations.grantIn` and the
  budget's `Shares` behind the subagent's `ChildSetup` ([The setup port](../../subagent-effect/README.md#the-setup-port)).
- Hooks are asked in extension order, so order is behaviour: the guard first, a product's tools, approvals after
  everything that blocks or rewrites a call, the review as the only `onYield` hook, the recorder's advisory hook
  last. The composition's table: [The order, and why](../../thread-effect/README.md#the-order-and-why).
- Models are layers of wrappers: the providers, the router on them, the budget on the same plain `Models`, the
  harness on the budgeted one. Never give the router the budgeted `Models`.
- A product that wants the whole thread uses `@effectified/pi-thread` and does not rebuild this order by hand.

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
registry `Layer`. The composition's port table is under [Install](../../thread-effect/README.md#install).

## True in every package

- **Effect 4.1.5 only.** Its API differs from Effect 3 in names and shapes (`Context.Service` classes,
  `Schema.TaggedError`, `Schema.Union([...])`, `Effect.forkChild`). Do not write Effect code from memory: read the
  declaration in `node_modules/effect/dist/*.d.ts`, and the package's own `.d.ts` for its exports, before calling
  a function. Start from a README example: each one is run by that package's tests.
- **Errors are tagged.** Every failure is a `Schema.TaggedError` class; handle it with `Effect.catchTag` or
  `Effect.catchTags`. Calls into Pi fail with the closed union `DurableError`
  ([Errors](../../durable-effect/README.md#errors)). Nothing throws.
- **Interruption is cancellation, both ways.** Interrupting a fiber cancels the Pi call it is in, and a Pi abort
  interrupts the handler's fiber. Interrupting a wait (`prompt`, `Submission.wait`, `waitForIdle`) cancels only the
  wait: the run goes on. `Conversation.abort` and `Harness.abortTask` stop work
  ([Interruption](../../durable-effect/README.md#interruption)).
- **Time comes from `Clock`.** Pi's clock, its sleeps, retry backoffs and the deadlines of parked calls are Effect's
  `Clock`, read when the harness is built. Every process that opens one storage must use the same clock
  ([Time](../../durable-effect/README.md#time)).
- **What Pi defines is not written a second time.** Use the shared forms the facades export instead of restating Pi:
  `ANSWERED`, `TOKEN_KINDS`, `ModelRef` ([Values that follow pi-ai's types](../../ai-effect/README.md#values-that-follow-pi-ais-types)),
  `Task.ended`, `Submission.settled`, the id schemas `Conversation.Id`, `Entry.Id`, `Task.Id`, and `Agent.ByName`.
- **What a plugin stores is in the harness storage**, through documents, entries, memos and commits, under kinds
  prefixed by the plugin (`recorder.cursor`, `budget.share`, `thread.work`). A fork copies it.
- **With a guard, a conversation calls only what it was granted.** One without a grant may call nothing (the
  policy's `ungranted`), and a tool outside the grant is not even offered to the model.
- **To act on a committed step** (a message, a tool result, a model call), use the recorder's `RecordSink`, which
  gets each one after Pi committed it, at least once, under a fixed id. Not a hook: `afterTool` runs before the result
  is committed, and Pi may ask it again ([Records](../../recorder-effect/README.md#records)).

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
| Memory storage cannot be reopened | A restart test uses a SQLite file (see [Test Without a Network](testing.md)) |
| Pi Durable 1.6 is experimental; stored data rolls forward only | Pin the versions the packages pin |

The evidence for each is in [Hook](../../durable-effect/README.md#hook), [Tool](../../durable-effect/README.md#tool)
and [Interruption](../../durable-effect/README.md#interruption).

## Where to go next

- [Packages](packages.md) lists every package with its entry points.
- [Build an Agent Thread](threads.md) puts all of them to work in a product.
- The order of the composition, and why it must not change:
  [The order, and why](../../thread-effect/README.md#the-order-and-why).
