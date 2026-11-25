# @gunta/pi-thread-effect

An agent thread for [Pi Durable](../durable) in Effect 4.1: a conversation that is guarded, budgeted, routed,
recorded and reviewed, with approvals, subagents and swarms, worked to its end from one call and told to the product
when it gets there. It is the pi-effect plugins composed in the order their READMEs require, in one process or as
one Rivet actor per thread. For `effect` 4.1 and Pi Durable 1.6.1.

- **A thread is the product's key.** `Threads.work({ thread, task, model, grant, cap })` creates the conversation
  with its grant, its cap and its routing limits in one commit, admits the task once, and gives the `Outcome`:
  reviewed, answered, held for a person, stopped by the budget, errored or cancelled.
- **Outcomes are delivered.** The product's `OutcomeSink` is told that work started and every outcome the thread
  reaches, at least once, in order, under a deterministic id, after the records the outcome rests on.
- **Everything is recorded.** The product's `RecordSink` gets every message, model call and tool call, the review's
  verdicts, and the reviewer's request as a model call like any other.
- **Swarms run on a thread.** Forks of the primed thread under a cap, each with its own allowance and money, with
  typed results fanned in.
- **Nothing here knows a product.** No tool, label, verb or price is in the code: the product supplies them as data
  and as ports.

## Install

```sh
npm install @gunta/pi-thread-effect effect
```

`effect` is a peer dependency (`~4.1.5`), and so is `rivetkit` (`~3.1.1`), which only the `/rivet` entry loads. The
plugins come with the package; a product imports the ones whose ports it implements (`@gunta/pi-budget-effect` for
`Lease`, `@gunta/pi-recorder-effect` for `RecordSink`, `@gunta/pi-approvals-effect` for `Inbox`).

| Entry | For | Holds |
|---|---|---|
| `@gunta/pi-thread-effect` | One process | `Composition`, the services `Threads` and `Swarms`, `Outcome`, `OutcomeEvent`, the port `OutcomeSink`, and the parts a host builds one by one |
| `@gunta/pi-thread-effect/rivet` | Rivet actors | `ThreadActor` (the actor a host registers), `Remote` (the client service a product binds its ports to), `SwarmId`, `ForkAgent` |

**What a product supplies.** As data, a `Composition.Config`: its tools, the guard's policy, the approval policy,
the providers and the route table with its prices, the review policy and checks, the subagents and swarms. As
services, its ports:

| Port | Of | Called |
|---|---|---|
| `Lease`, `Estimator`, `Prices` | `@gunta/pi-budget-effect` | To reserve and settle every model request; `Prices` is `priceRows(routes)` of the router |
| `RecordSink` | `@gunta/pi-recorder-effect` | With every record of what the harness committed |
| `OutcomeSink` | this package | With every outcome event of a thread ([Outcomes are delivered](#outcomes-are-delivered)); `OutcomeSink.none` for a product that asks instead |
| `Approvals.Inbox` | `@gunta/pi-approvals-effect` | With every call parked for a person |
| `PiTelemetry` | `@gunta/pi-telemetry-effect` | For Pi's spans |
| A `HarnessStorage` | `@gunta/pi-durable-effect` | In one process; in a Rivet actor the host gives the actor's SQLite |
| What its own tools, rules and checks need | The product | Such as a `Review.Citations.Verifier`, a `SearchProvider` |

This README also holds what a product that replaces a hand-written agent loop needs to know: the
[mapping](#from-the-consumers-loop-to-the-packages) from the first consumer's loop and host, and the section
[Gaps](#gaps), which lists what still does not fit.

## The composition

```ts
import { Effect, Layer } from "effect";
import { Prices } from "@gunta/pi-budget-effect";
import { Storage } from "@gunta/pi-durable-effect";
import { priceRows } from "@gunta/pi-router-effect";
import { Composition, Threads } from "@gunta/pi-thread-effect";

const live = Composition.open({
	extensions: [App, SearchTools.extension()], // the product's tools
	guard: { policy, rules },
	approvals: { tools: ["transfer"], expiresAfter: "1 day" },
	models: { providers, routes },
	review: { policy: reviewPolicy, checks: [Cited] },
	subagents: { subagents: [Researcher], maxDepth: 1, maxLive: 2, caps: { researcher: 50_000n } },
	swarms: [Covers],
}).pipe(
	Layer.provide(Storage.sql()), // over an Effect SQLite client
	// The product's ports: Lease, Estimator, Approvals.Inbox, RecordSink, OutcomeSink, PiTelemetry, and what its
	// tools and checks need (a Review.Citations.Verifier, a SearchProvider).
	Layer.provide(ports),
	// A price is written once, in the route table: the router gives the rows the budget decodes.
	Layer.provide(Layer.unwrap(Effect.map(priceRows(routes), Prices.layer))),
);

const outcome = Threads.Threads.use((threads) =>
	threads.work({
		thread: "thread-42", // the product's key, and the idempotency key
		task: "What is record 42 called?",
		model: { provider: "router", modelId: "author" },
		grant: { tools: ["lookup"], classification: "internal" },
		cap: 1_000_000n, // micro units of the lease this thread may settle
		routing: { regions: ["eu"], requires: ["zero-data-retention"] }, // optional
		review: true, // optional; false ends an answered thread `Answered`, unreviewed
	}),
).pipe(Effect.provide(live));
```

`Composition.open` is three parts a host can also build one by one, which is what a Rivet actor takes
(`Actor.make({ layer, harness, services })` of `@gunta/pi-durable-rivet-effect`):

| Part | Built | Requires | Provides |
|---|---|---|---|
| `Composition.layer(config)` | Before the harness | The product's ports: `Lease`, `Estimator`, `Prices`, `Approvals.Inbox`, `RecordSink`, and what its tools, rules, approval rule and checks need; and what the chosen fork driver needs of the host | `Registry`, the budgeted `Models`, `Guard`, `Shares`, `Spend`, `BudgetEvents`, `Router`, `RouteEvents`, `ForkDriver`, `ForkSetup`, `Forks.Accounts`, `Reviewers`, `Opened`, `OutcomeCourier.Delivery` |
| `Composition.harness(config?)` | An Effect giving the options of `Harness.layer` | `PiTelemetry` | `conversationCreated` (the guard's, then the session index), Pi's telemetry, the settings |
| `Composition.services(config?)` | On the open harness | `Harness`, and of what `layer` provides: `Guard`, `Shares`, `ForkDriver`, `Forks.Accounts`, `Reviewers`, `Opened`, `OutcomeCourier.Delivery`; and the product's `RecordSink` and `OutcomeSink` | `Threads`, `Swarms`, the recorder's pump; the delivery of outcome events starts |

The storage and the host seams stay outside: `Composition.open` requires a `HarnessStorage`.

**Where a swarm's forks live is the host's choice** (`config.forks`, a `Forks.Forks`):

| Choice | A fork is | A fork's money |
|---|---|---|
| `Forks.conversations` (the default) | A conversation of the harness the swarm runs in: the swarm's in-storage driver. In one process, and in an actor alike | The stored share of its conversation, one read |
| `Accounts.forks(options)` of `@gunta/pi-thread-effect/rivet` | A fork of the Rivet actor the composition runs in: the swarm's Rivet driver | The share in the fork actor's storage, asked of the fork, and kept in the swarm's storage before the fork is destroyed |

A choice is two Layers: `driver`, built before the harness, and `attach`, built on it. Pass the same one to `layer`
and to `services`, as `Composition.open` and `ThreadActor.make` do.

### The order, and why

Hooks are asked in extension order, and the models are layers of wrappers, so the order is the behaviour.

**Before anything: the guard**, from its policy alone (`Guard.fromPolicy`). It needs no registry, so everything
below can hold it: the constraint source reads grants with it, the two setup ports grant with it, and
`Guard.registry` checks the registry against it. One Layer value, so one guard.

**Models, inside out:**

1. The providers (`Models.layer(providers)`).
2. The router, built on them, with the composition's `ConstraintSource` under it: the router takes the source of
   the context it is built in. Its attempts go to the providers directly.
3. The budget (`BudgetedModels.layerWithShares`) on the same plain `Models` value, into which the router put its
   provider, and the harness on the budget: one request of the harness to an alias is one reservation, whichever
   route serves it, and nothing reaches a provider unreserved.
4. Under the router, `Fallbacks.layer`: the router's `AttemptSettlement` port on the budget's `Spend`. The router
   waits for it before it tries the next route, so an attempt another route takes over is charged in order.

**Extensions:**

| # | Extension | Why there |
|---|---|---|
| 1 | `guard` | Installed first by `Guard.registry`: its `beforeTool` hook decides before anyone else, and a denied tool name fails the build |
| 2 | The product's tools | No hooks. Every tool gets the guard's backstop |
| 3 | `approvals` | After everything that blocks or rewrites a call: nobody is asked to approve a call the guard refuses |
| 4 | `review` | The only `onYield` hook: Pi takes the first answer, so nothing with one may come before it |
| 5 | `subagent`, `swarm`, `thread` | Tools and tasks, no hooks: their place does not matter. `thread` holds the courier that delivers a thread's outcome events |
| 6 | `recorder` (the advisory record) | Last: it observes and decides nothing |

**Before the harness opens:** `Opened.layer` (the place the open harness is given to), `Shares.layer`, the fork
driver of the host's choice, the reviewer check (`Reviewers.layer`), `OutcomeCourier.holder` (the place the delivery
of outcome events is given to), and the two setup ports, `ChildSetup.layer` and `ForkSetup.layer`. Both take the
`Guard` and the `Shares` from their context and do all their work in the commit that creates the conversation.

**In every creating commit** (`conversationCreated`): the guard's `Conversations.created` first, so the new
conversation is offered what it may call and a task-owned one is never labelled below its owner; then
`Session.noteIn`, which reads the `pi.provider` document Pi has just created.

**On the open harness, in this order:** `Shares.attach`, the fork driver's `attach` and `Opened.attach` (until then
every request that names a session, every call of the in-storage driver and every question to the constraint source
waits), `Recorder.layer` on the product's sink behind `ReviewCalls.layer` (it queues what an earlier process left
undelivered), then `Threads`, `Swarms` and `Outcomes.layer` (it gives the couriers what they do, and looks at every
thread for an event an earlier process did not deliver).

### What the composition decides

- **A thread is a conversation found by the product's key.** The document `thread.work` holds the key's
  conversation, written in the commit that creates the conversation with its grant, cap and limits, and with the
  courier of its outcome events.
- **A thread's outcomes are told by the process that works it.** Each thread has a durable task that delivers its
  events to the product's `OutcomeSink`: see [Outcomes are delivered](#outcomes-are-delivered).
- **The reviewer's request is a model call record.** The recorder's sink is the product's behind
  `ReviewCalls.layer`: see [The reviewer's request](#the-reviewers-request-as-a-model-call).
- **A thread's work is admitted under request keys.** Its task, and every continuation of a run that ended without
  an answer, is one Pi submission whose request id is the key the product gave (or `<thread>#<n>`). The document
  keeps the keys in order. So an admission is idempotent by its key, and a thread is started once: a start under
  another key finds the thread and admits nothing.
- **A thread that asks for a review is not started with a reviewer of its author's family.** `Reviewers.check` holds
  the route table against the review's family table for the thread's model, before anything is created: when a
  route of the reviewer's alias and a route of the thread's alias are of one family, `admit` fails with
  `ReviewerSharesFamily`, which names every such pair by its routes. It is checked at the start, not when the
  composition is built: a table may hold an alias of the reviewer's family for threads that ask for no review, and
  for subagents and forks, which are not reviewed.
- **A thread has a cap, from its first request.** The share is written in the creating commit (`setCapIn`). The
  budget stores a settled total only for a conversation with a share, so this is also how the outcome knows what
  the thread spent.
- **A thread's classification, regions and labels reach the router with every request.** The router asks the
  composition's `ConstraintSource` by pi-ai's `sessionId`. The document `thread.session`, one per provider
  session, written in every creating commit, maps the session back to its conversation; the source then reads the
  guard's grant (`Conversations.granted`) and the document `thread.routing`. That is three document reads per
  provider request, no scan, and nothing kept in memory, so a reopened process answers the same. A grant without a
  classification is answered with the policy's highest label. A request that names no session, or one no
  conversation holds, is refused: a tool that asks a model through the harness's `Models` must pass its
  conversation's session.
- **A child is granted at most its declared tools** (`mode: "narrow"`), with its parent's classification and
  routing limits, and needs a cap: a declaration without one in `subagents.caps` starts no child.
- **A swarm's forks have an allowance**: the tools they may call at most and the micro units each may settle, given
  with the plan (`Swarms.run`), stored in `thread.swarm` before the swarm starts, and applied in each fork's
  creating commit. A fork never gets a tool its thread does not have, and a fork of a swarm without an allowance
  does not exist: its job fails as `gone`.
- **A thread's money is all it caused, wherever its swarms' forks live.** `settledMicros` adds two things. First,
  the stored shares of the thread's conversation and of every conversation its tasks own, at any depth: its
  subagents' children and the forks that are conversations of its storage. Second, for every swarm started on the
  thread, the account of each job whose fork is an actor (`Forks.Accounts`): kept in the thread's storage once the
  fork is destroyed, asked of the fork until then. The thread's document keeps the ids of its swarms, written in
  the commit that gives a swarm its allowance, before the swarm exists. A fork in the thread's own storage is
  counted by its share and not again as an account. A swarm that runs after the thread ended raises the amount of
  an outcome read later; `Swarms.spent` gives the same money per job. A fork that cannot be asked now counts as
  zero until it can.
- **Only a thread's answer is reviewed, and only when the thread asks.** `Work.review: false`, subagent children
  and swarm forks leave the `review` extension out of their own selection, in the creating commit: Pi then asks no
  hook, and the review reads `NotRequired`.
- **A route attempt another route takes over is charged before that route is tried**, to the lease and to the share
  of the conversation whose session the request named, through the router's settlement port. When the lease refuses
  that charge, no other route is tried: the request ends with the failed attempt, settled on its own reservation.

## The services

`Threads` and `Swarms` are `Context.Service`s. Every operation is an Effect without requirements.

| Operation | |
|---|---|
| `Threads.admit(input, key?)` | Admits a thread's task under a request key and returns `{ created, key }`. Idempotent by `thread`: a later call applies only `cap`. Fails with `ReviewerSharesFamily` before anything is created, and with `SchemaDecodeError`, creating nothing, for a `maxTurns` below 1, which Pi's `configure` refuses |
| `Threads.work(input)` | `admit`, then `ended`: works a thread to its end and gives its `Outcome`. Also the way to reattach after a restart. It never waits for a person or for a lease: a held answer and a deferred review end it |
| `Threads.takeOn(thread, key?)` | Takes a stopped thread on and returns `continued`, `retried` or `unchanged`: a run that ended without an answer (`BudgetStopped`, `Errored`) is continued under the key, a deferred review (`BudgetStopped` with `review`, `ReviewDeferred`) is asked for again |
| `Threads.resume(thread)` | `takeOn`, then `ended` |
| `Threads.decide(thread, decision)` | Delivers a person's `Accept` or `Correct` to a held thread and returns once it is stored |
| `Threads.release(thread, decision)` | `decide`, a wait for the hold's end, then `ended`: the outcome that follows |
| `Threads.cancel(thread)` | Aborts the thread's run, a model request in flight included; also a held one and one that waits for its review |
| `Threads.probe(thread)` | `{ alive }`: whether the thread's submission is open, so also while parked, held or deferred |
| `Threads.outcome(thread)`, `ended(thread)`, `conversation(thread)` | The outcome now (none while it works); the outcome once there is one (it waits); the conversation, for `Review.verdicts` |
| `Swarms.run(swarm, plan)` | Starts a swarm on a primed thread, with the allowance of its forks (`plan.fork`). Idempotent by `plan.id` |
| `Swarms.cancel(id)`, `probe(id)` | Cancel; `{ alive, jobKeys }` |
| `Swarms.result(swarm, id)`, `stored(id)` | The typed result (it waits); the result as stored, values in JSON, none while the swarm runs (it never waits) |
| `Swarms.spent(id)` | Per job, in plan order, what its fork settled so far: none before its fork accepted a request |
| `Swarms.destroyFork(id, jobKey)` | Destroys one fork, a pinned one included: `{ bytesWritten }`, what the fork wrote as its driver measures it ([below](#what-a-destroyed-fork-wrote)) |

`admit`, `takeOn`, `decide` and `stored` return once their work is durably admitted or read: they are what a host
that cannot hold a call open calls, such as a Rivet action. The others wait.

`Outcome` is a `Schema` union, so it crosses a host boundary as JSON (`Schema.toCodecJson`):

| `_tag` | Read from |
|---|---|
| `Reviewed` (`verdict`, `accepted`) | The submission is `done`, and `Review.state` is `Reviewed` or `Accepted` |
| `Answered` | The submission is `done`, and `Review.state` is `NotRequired`: the thread asked for no review |
| `NotReviewed` (`reason`, `verdict?`) | The submission is `done`, and `Review.state` is `NotReviewed` for a reason no abort gives |
| `Held` (`verdict`) | `Review.state` is `Held`; the submission is open |
| `ReviewDeferred` (`verdict`, `attempt`, `reason`) | `Review.state` is `Deferred`, and its reason decodes as no budget refusal; the submission is open |
| `BudgetStopped` (`refusal`, `review?`) | The submission is `unanswered` with a detail `refusalOf` decodes; or `Review.state` is `Deferred` with a reason it decodes, and `review` is the deferred verdict |
| `Errored` (`reason`, `detail`) | The submission is `unanswered` for any other reason of Pi's |
| `Cancelled` | The submission is `unanswered` with `aborted`; or `done` with the review's `review_aborted` or `hold_ended` |

Each carries `counts`: `turns` and `toolCalls` (from the conversation's entries; a turn is a model response that
answered, `stop`, `length` or `toolUse`, by Pi Durable's rule, so an attempt Pi stored as failed is none),
`refusedToolCalls` (the tool results that carry the guard's own record, `Refused.of`) and `settledMicros`. Everything
is read from the harness storage, so an outcome is the same in a process that just opened it.

## Outcomes are delivered

A product does not ask a thread whether it has ended: the process that works the thread tells it. The port is
`OutcomeSink`, a `Context.Service` in the manner of the recorder's `RecordSink`:

```ts
import { Effect, Layer } from "effect";
import { type OutcomeEvent, OutcomeSink, OutcomeSinkError } from "@gunta/pi-thread-effect";

const Outcomes = Layer.succeed(OutcomeSink, {
	// One event. Success means it is stored; the same event may come again, so key it by `event.id`.
	deliver: (event: OutcomeEvent) =>
		store.put(event.id, event).pipe(Effect.mapError((cause) => new OutcomeSinkError({ cause }))),
});
```

`OutcomeEvent` is a `Schema` union, so it crosses a boundary as JSON (`Schema.toCodecJson`):

| `_tag` | When | Fields | `id` |
|---|---|---|---|
| `Started` | A submission of the thread was admitted: its task, or a continuation of a run that ended without an answer (`Threads.takeOn`). Once per submission | `thread`, `key` (the request key of the submission), `attempt` (0 for the task, 1 and up for continuations) | `<thread>:<submission>:started` |
| `Reached` | The thread stands at an outcome: `Reviewed`, `Answered`, `NotReviewed`, `Held`, `ReviewDeferred`, `BudgetStopped`, `Errored` or `Cancelled` | The same, and `outcome`: the `Outcome`, as `Threads.outcome` gives it, counts included | `<thread>:<submission>:<entry>:<state>` |

`<submission>` is Pi's id of the submission, `<entry>` the id of the newest entry of the thread's conversation when
the state was read (0 for none), and for a hold or a deferral the entry of its verdict, `<state>` the outcome's
`_tag`. A thread reaches several outcomes in a row when a
held answer is released or a deferred review is asked for again: `Held`, then `Reviewed`, on the same submission. A
state of one submission that comes again, a second hold after a person's correction, rests on a newer entry, the
verdict that holds it, and so has an id of its own.

**A parked call is no event of this port.** A thread that waits for a person's approval has an open submission and
no outcome. The product is told of every parked call by its `Approvals.Inbox`, at least once, under the request's
own id: a second channel would tell it twice under two ids.

**What holds:**

- **At least once, in order per thread.** The events of one thread come one at a time. An event is stored before the
  sink is called (`thread.outcomes`, `pending`), and the cursor moves, in a commit of its own, only after the sink
  took it. A repeat, after a failure or a process that died in between, is the stored value: the same id and the
  same content, counts included.
- **`Started` before the outcomes of its submission**, always.
- **Not lost across a close, a sleep or a restart.** What a thread reached and its sink did not take is delivered
  when the harness opens again: every thread of the storage is looked at as the composition's services are built.
- **After the records.** Before the sink is called, the recorder is flushed (`Recorder.flushAll`): the records of
  everything this harness storage had committed are in the product's `RecordSink` first, the verdict and the
  reviewer's model call included. A product that reacts to `Reviewed` finds the transcript recorded. This order is
  guaranteed, and it is why a record sink that fails holds an outcome back: the outcome waits while the recorder
  tries its sink again, and an attempt whose flush fails is made again as a whole. The records of a swarm's fork
  that is an actor of its own are that actor's to deliver.
- **A failing sink never holds the thread up.** The delivery is a task of its own, the thread's courier: the
  thread's run, `Threads.work` and every other operation go on. A failed attempt is made again on the schedule of
  `Config.outcomes.retry` (default: forever, from 100 milliseconds, doubling up to 30 seconds), as a durable sleep of
  the courier, so the wait holds no process and outlives one. When a schedule of the product's ends, the event stays
  undelivered until the thread's next change, or until the harness opens again.
- **A fork of a swarm is no thread.** A job's conversation has no courier and no event. A copied storage tells of
  nothing its source reached: see [the fork hygiene](#what-a-fork-inherits-and-the-fork-hygiene).

**What does not:**

- **A hold or a deferral whose verdict was stored before this package recorded a verdict's submission** (threads in
  flight at an upgrade) is told from where the thread stands, as before: one the thread had left already stays
  passed over. Every later one is told from the transcript, also when the thread left it at once.
- **A process that dies between the commit that ends a thread's work and the commit that wakes its courier** (two
  commits of this process, with no port call between them) delivers at its next open.
- **Counts are those of the first read.** `outcome.counts` of an event that is delivered again is what it was first:
  a swarm that ran later is in a later read of `Threads.outcome`, not in the event.
- **An outcome of a settled submission is read 250 milliseconds after the run at most**, while the conversation is
  not idle: a task the product's own `afterRun` hook started, or a swarm started on the thread at once, is not
  waited for.

`OutcomeSink.none` is the sink that takes every event and keeps none, for a product that asks:
`Threads.outcome`, `Threads.ended` and `Remote.threads.ended` stand as they were.

## The reviewer's request as a model call

A reviewer's request is the review task's own, not a generation: the recorder derives no `ModelCall` from it, and
its verdict is an `Entry` record of kind `review.verdict` whose `data.call` holds the request. The composition's
recorder delivers to the product's sink behind `ReviewCalls.layer`, which adds, for every such record with a call, a
`ModelCall` record right after it, in the same batch. Nothing else changes: no record is dropped or rewritten, and
no id of the recorder is used twice.

| Field | Is |
|---|---|
| `id` | `<conversation>:<entry>:0:model`: the recorder's id of the model call of an entry's first message. No record of the recorder has it, because an entry that gives an `Entry` record has no model message |
| `entry`, `task`, `conversation` | The verdict's entry, the review task that appended it, the thread's conversation |
| `time` | When the reviewer's request started; for a verdict stored before it kept that, when the verdict was decided |
| `provider`, `model`, `stopReason`, `error` | The verdict's `call`: the route that served (the policy's reviewer when the request ended without a response), how it ended, the provider's error text |
| `usage` | The tokens of the response, which are those the lease settled, `cacheWrite1h` and `reasoning` included (`null` where pi-ai reported none) |
| `cost.total` | pi-ai's cost of the response, as the verdict holds it: what `cost.total` is in every other `ModelCall`. It is not what the lease was charged: that is the route's price, which the product's `Lease` was told at `settle` |
| `api`, `responseModel`, `responseId`, `durationMs`, the parts of `cost`, `cost.fromProvider` | The response's, as the verdict keeps them; of a request that ended without a response, the reviewer model's `api` and the time it was sent |
| `derived` | `from`: the id of the verdict's record. `unknown`: empty for a verdict of this version. For a verdict stored before it kept the whole response, the fields it does not hold, which carry their empty value (`""`, `0`, `false`): `api`, the four parts of `cost`, `cost.fromProvider`; and `usage` and `cost.total` for a request that ended without a response |

`derived` is an optional field of the recorder's `ModelCall` that no record of the recorder carries: a sink tells a
derived call from a recorded one by it. A verdict without a request (the family rule stopped the review before one
was sent) gives no model call.

## What a destroyed fork wrote

`Swarms.destroyFork` and a swarm's result answer `bytesWritten`, as the fork's driver measures it:

| Forks | `bytesWritten` is | It is not |
|---|---|---|
| Conversations of the thread's storage (`Forks.conversations`) | The size in bytes of the UTF-8 JSON of the entries the fork's conversation appended after its fork point, read after the fork's work was aborted and before it is marked destroyed. The same number for every later call | The storage the fork took: documents, indexes, tasks and submissions are not counted. And nothing is freed: Pi cannot delete a conversation, so the entries stay |
| Actor forks (`/rivet`) | The size of the fork's SQLite database when it was destroyed less its source's when it was forked, in whole pages, never below zero | Bytes written: Rivet reports none per actor |

None for a fork that was gone or never made.

## The Rivet form

`@gunta/pi-thread-effect/rivet` hosts the composition in Rivet actors: one actor per thread (the first consumer's
unit `thread:{threadId}`), on [`@gunta/pi-durable-rivet-effect`](../durable-rivet-effect), with swarms as actor
forks through [`@gunta/pi-swarm-effect/rivet`](../swarm-effect).

```ts
import { Effect, Layer, Schedule } from "effect";
import { ActorInfo, Client, Host } from "@gunta/pi-durable-rivet-effect";
import { Remote, ThreadActor } from "@gunta/pi-thread-effect/rivet";

// The product's ports as one Layer, built in each actor at each wake. It may read the actor it is built in.
const ports = Layer.unwrap(ActorInfo.use((actor) => Effect.succeed(productPorts(actor))));

const Thread = ThreadActor.make("thread", {
	composition: config, // `Composition.Config`, without `forks`
	ports,
	forkHygiene: [openRecordStream], // the product's own, after the composition's
});

// The process that hosts the actors:
const host = Host.serve({ actors: [Thread], endpoint });

// A caller, such as the binding of the product's ports:
const program = Effect.gen(function* () {
	const remote = yield* Remote.Remote;
	yield* remote.threads.start(work, jobKey); // returns once the task is durably admitted
	// The thread's actor tells the product's `OutcomeSink` when it ends. A caller that wants to wait asks:
	return yield* remote.threads.ended(work.thread, Schedule.spaced("2 seconds"));
}).pipe(Effect.provide(Remote.layer(Thread)), Effect.provide(Client.layer({ endpoint })));
```

### The thread actor

`ThreadActor.make(name, options)` gives an `Actor.Definition`. One definition is the thread and every fork of it.

| What a product supplies | |
|---|---|
| `composition` | The composition's `Config`, as for one process. Where forks live is not a choice here: they are forks of the thread's actor |
| `ports` | One Layer with its `Lease`, `Estimator`, `Prices`, `RecordSink`, `OutcomeSink`, `Approvals.Inbox`, `PiTelemetry`, and what its tools, rules and checks need. It may require `ActorInfo`, `ActorDatabase` and `ActorEngine`: a fork gets a lease and a record stream of its own from the actor it is built in |
| `swarm` | Options of the swarm's Rivet driver: `pollMillis`, how often a coordinator asks its forks (default 1000) |
| `actions` | The product's own actions, beside the fixed ones ([below](#product-actions)) |
| `services` | A Layer of the product's own on the open harness, built after the composition's services at each wake and not while fork hygiene runs: what a product builds on `Composition.open` in one process. For what a port built before the harness needs of it: the recorder to flush before the product's own sender writes, the shares to read. It may use the harness, the composition's services and all the `ports` Layer provides; what it provides itself reaches nobody. Its failure is a harness that did not open |
| `forkHygiene` | The product's own steps on a copied storage, run after the composition's |
| `prefix`, `rivet` | The host's: the prefix of Pi's tables in the actor database, and Rivet's actor options |

At each wake the host builds `Composition.layer` on the ports, the harness on the actor's SQLite, and
`Composition.services`. The host's wake keeper holds the actor awake while the thread works and lets it sleep while
a call is parked for a person, an answer is held, or the thread stopped; a scheduled wake brings it back.

**An actor does not sleep on an outcome it has not delivered.** The keeper follows Pi's own activity, and the
delivery of an outcome event is a Pi task, the thread's courier:

- **While an event is being delivered** the courier runs, so Pi has work that can run: the keeper holds the actor
  awake, however long the product's sink takes, and keeps a recovery wake at most 15 seconds ahead. An actor that
  is put to sleep or dies in the middle is woken by that wake, and the courier's phase runs again from its top.
- **After a failed attempt** the courier sleeps until the time the product's schedule gives. Pi then has a sleep
  that is due at that time and nothing that can run: the keeper schedules one wake action for it, and only then
  lets the actor sleep. Rivet wakes the actor at that time, the harness opens, and the event is offered again.
  `test/rivet-suite.ts` shows it: a sink that refuses once, an actor forced to sleep, no caller, and the event in
  the sink after the scheduled wake.
- **Every other wake delivers too**: whatever wakes the actor opens the harness, and the opening looks at the
  thread and offers at once what is due, also when the courier's own time is later.
- **Once everything is delivered** and the thread's submission settled, the courier ends: the actor has no live
  task and no schedule left because of it.

**Actions.** None waits for a thread or a swarm to finish: Rivet ends an action after its timeout (60 seconds). Each
is safe to send again.

| Action | |
|---|---|
| `start` | `Threads.admit(work, key)`: `{ created, key }` |
| `resume` | `Threads.takeOn(thread, key)`: `continued`, `retried` or `unchanged` |
| `cancel`, `release`, `probe`, `outcome` | `Threads.cancel`, `decide`, `probe`, `outcome` |
| `pending`, `decide` | `Approvals.pending`; `Approvals.decide(request, decision)` |
| `runSwarm` | `Swarms.run`, with the definition by its name, every job's input in its JSON form, and the agent change of the forks with tools and extensions by name (`ForkAgent.Wire`): `{ created }`. The swarm's id must name the thread: `<thread>/<name>` |
| `cancelSwarm`, `probeSwarm`, `swarmResult`, `swarmSpent`, `destroyFork` | `Swarms.cancel`, `probe`, `stored`, `spent`, `destroyFork` |
| `swarmRun`, `swarmJob`, `swarmCancel` | The swarm driver's own, served by a fork to its source |
| `forkAccount` | Served by a fork to its source: delivers the records the fork still holds, then answers what its job settled |

A failure crosses as data: `ThreadNotFound`, `ReviewerSharesFamily` (of `start`), or `OperationFailed` with the tag
and the message of what failed. Nothing checks who calls an action: authenticate in the host.

#### Product actions

The fixed actions are all a thread needs. What a product needs beside them is its own: the first is a way to give
an actor its work before `start`. An actor is created by its key alone, and the first thing its Layers read is its
own database, so what a product's ports work from (a task, a reservation, a grant) has to be there before a thread
is admitted. `options.actions` is a record of `Action`s of `@gunta/pi-durable-rivet-effect`, registered beside the
fixed ones:

```ts
const Thread = ThreadActor.make("thread", {
	composition: config,
	ports, // may provide services of the product's own beside the ports
	actions: {
		// Runs inside the actor, like every action: on its database, its harness and the composition's services.
		assign: Action.make({
			input: Schema.Struct({ task: Schema.String }),
			output: Schema.Null,
			handler: ({ task }) => ActorDatabase.use((database) => keep(database, task)),
		}),
	},
});
```

- **What one runs with** (`ThreadActor.InActor`): the harness, the registry and the models; `ActorInfo`,
  `ActorDatabase` and `ActorEngine`; what the composition provides (`Threads`, `Swarms`, the recorder, the guard, the
  shares); and everything the product's `ports` Layer provides, its own services included. An action that needs
  anything else does not type check.
- **Its name is its own.** A record with the name of a fixed action, or with the host's `pi` or `destroy`, does not
  type check.
- **It is typed into the definition** (`ThreadActor.Definition<Name, Product>`): `Client.call` knows it, and so does
  `Remote.product` ([below](#the-client-service)).
- **It is an action like the others**: it returns within Rivet's action timeout, it is safe to send again, and it
  also runs in a fork, which is an actor of the same definition.

**Swarms.** A swarm's coordinator lives in the actor of its thread, and its id begins with that thread's key:
`<thread>/<name>` (`SwarmId.of(thread, name)`), the name without a slash. So a swarm is found by its id alone, and
an id that does not name the thread it is started on starts nothing (`SwarmIdNotOfThread`). Each fork is an actor
fork under its source actor's own key followed by `"swarm", <swarm id>, <job key>` (`[<thread>, "swarm", <swarm id>,
<job key>]` with one actor per thread), and its job runs in a conversation of its own in the fork's storage. The composition's `ForkSetup` runs inside the fork actor, in the commit that creates that
conversation, on the fork's own guard, shares and lease: the allowance it reads (`thread.swarm`) came with the
copied storage. Before a fork is destroyed, by the coordinator's clean-up, a cancel or `destroyFork`, its source asks
it for its account (`forkAccount`): the fork flushes its records to the sink, and what its job settled is kept in
the source (`thread.spent`). A fork that cannot be asked is not destroyed now.

**The agent of a swarm's forks.** `Remote.Plan.agent` (`ForkAgent.ForkAgent`) is what a caller may change of the
agent every fork runs with: the model, the thinking level, the instructions, the tool rounds of one run, and the
selection of extensions and tools. It crosses to the actor as data: a tool or an extension is given by its name or
by anything that carries one, and only the name crosses, since the code is installed in the actor under that name.
The actor stores the change with the swarm as `Swarm.start` stores one, and each fork's actor applies it in the
commit that creates the job's conversation, before the fork setup, which then narrows the tools to what the
allowance and the thread's grant leave of them and takes the review out. So a fork runs on the model the plan names
and is offered, of the tools the plan names, those it may have, in the plan's `cwd` and with its `compaction`
settings. A change that is no data of that shape (a number of turns below 1, a negative token count) fails with
`InvalidPlan` in the
caller, before anything is sent. The
actor holds every name of the change, of tools and of extensions, against its own registry: with one that nothing is
installed under, `runSwarm` fails with `OperationFailed` of the reason `InvalidPlan`, which lists the names, and
nothing is stored.

### What a fork inherits, and the fork hygiene

A fork is a copy of the whole actor storage. The host makes one only of an actor with nothing in flight: no
unsettled submission, and no live task but a background task of the product. So a thread that works, has a parked
call, or is held or deferred is never copied, and a swarm started on such a thread waits for it. What a copy can
hold live is a swarm's coordinator, and the run of a background subagent whose child is not at work at that moment.
Inside a fork, before its first call, the host cancels every inherited schedule and then runs `ThreadActor.hygiene`,
in this order, then the product's steps:

1. **The recorder's `onStorageFork`.** Every conversation's cursor moves to the copied head: the fork delivers only
   what it commits itself, and nothing its source delivered or still has to deliver.
2. **The swarm's `Rivet.forkHygiene`.** The copied coordinators end as copied, the driver's record of forks is
   emptied, and the job conversation of a source that was itself a fork is forgotten.
3. **The subagents' `onStorageFork`.** Every run the copy inherited live ends as copied: it hands its child no
   task, sends its parent no report, and the child's document says why (`Failed`, `copied`).
4. **The budget's `onStorageFork`**, under the fork's actor id. What every copied share had settled becomes what it
   inherited: a cap still counts it, and the share's own total starts at zero.
5. **The composition's own**, `StorageFork.onStorageFork`. The swarms the copied thread lists are marked as its
   source's: the fork does not add their forks' money to its copy of the thread. And the copied thread's outcome
   events are its source's to tell: the courier the copy inherited ends as copied, no event is pending, and the
   delivery cursor says that everything up to where the thread stands is told.

**Why this order.** The recorder is first so that whatever the fork commits from then on is its own to deliver.
Steps 2 to 5 do not depend on each other: each writes documents and abort marks of its own plugin and reads nothing
another step writes. They are in the order of what they end: the tasks first, then the money, then what is added up
over both and what is told of the thread. All of them are idempotent before the fork's first call, which is when the host runs them again after a
crash; the budget's is also idempotent afterwards, by the fork's name.

| Plugin | What the copy holds | Right as it is? |
|---|---|---|
| recorder | `recorder.cursor`, entries the source has not delivered yet | No: step 1 |
| swarm | The live coordinator, the driver's record | No: step 2 |
| subagent | `subagent.child` documents with their conversations; a background run that is live but has no open submission | A finished child, yes. A live run, no: step 3 |
| budget | The `budget.share` of every copied conversation, cap and total | No: step 4. Afterwards a share reads `{ cap, settled: 0, inherited }`: a copy that goes on with a copied conversation stays under its cap, and a sum of `settled` over actors counts every request once. The fork's own work runs in a new conversation with a new share |
| guard | The grants of its conversations | Yes. The job's conversation is narrowed by the fork setup |
| approvals | Nothing pending: an actor with a parked call is not forked | Yes |
| review | The verdict and release entries of the transcript; no held or deferred review, whose submission is open | Yes. The fork setup leaves the review out of the job's conversation |
| this package | The thread's document with its swarm ids, the session index, the routing limits, the swarm allowances and accounts; the thread's delivery cursor, maybe with a pending event, and its courier when an event was still to be told | The swarm ids and accounts, the cursor and the courier, no: step 5. The rest, yes: the fork setup reads the allowance in the fork |

So a pinned fork answers the thread's `outcome` with everything but the money: its `settledMicros` is what the fork
itself settled for its copy of the thread, zero for a fork that only ran its job. What the job settled is in the
job's own conversation, and is the account the fork gives its source (`forkAccount`).

This is what the consumer's ADR 0025 asks of a forkable actor's `onFork`: inherited schedules are cancelled by the
host, inherited outbox rows are dropped by step 1 (the entries are the outbox, and the cursor is what is pending),
and the new record stream is the product's: its `ports` Layer is built in the fork from `ActorInfo`, and its
`forkHygiene` step writes the stream's first record.

### The client service

`Remote.layer(definition, { timeout, actorKey })` provides `Remote` on the `RivetClient` of the context. Threads are
found by key, one actor per thread; a swarm by its id, which begins with its thread's key; a fork by its swarm and
its job.

**Several threads in one actor.** `actorKey` is the key of the actor that holds a thread, as a function of the
thread's key. Without it the thread's key is the actor's. A product whose actor holds several threads, such as one
conversation per session of the same piece of work, keys its threads so that the actor can be read off the key, and
gives that function:

```ts
// Threads are keyed `<work>/<session>`; one actor holds every session of a piece of work.
const actorKey = (thread: string) => [thread.slice(0, thread.indexOf("/"))];
const remote = Remote.layer(Thread, { actorKey });
```

Every operation finds its actor through it: a thread's by its key, a swarm's by the thread its id names, a fork's by
its swarm. Inside the actor nothing changes: a thread and a swarm keep their own keys, and a fork's key is made from
its source actor's key, so it follows. An operation on a thread the actor does not hold fails as it does for any
unknown thread, and `probe` of a thread whose actor does not exist creates none.

| Operation | |
|---|---|
| `threads.start(work, key)` | Finds or creates the thread's actor and admits the task under `key` |
| `threads.resume(thread, key)`, `cancel`, `release`, `outcome` | The actions of the same names |
| `threads.probe(thread)` | `{ alive }`; false for a thread nothing started, and no actor is created to ask |
| `threads.pending(thread)`, `decide(thread, request, decision)` | The thread's pending approval requests, and a decision about one |
| `threads.ended(thread, schedule)` | The outcome once there is one, asking again on `schedule`, for a caller that wants to wait: the thread's actor tells the product's `OutcomeSink` by itself. Fails with `StillWorking` when the schedule ends |
| `swarms.run(swarm, plan)` | On the actor of `plan.thread`. `plan.id` must be `SwarmId.of(plan.thread, name)`: it fails with `SwarmIdNotOfThread` before anything is sent. `plan.agent` crosses by name; one that is no data fails with `InvalidPlan` |
| `swarms.cancel(id)`, `probe(id)`, `spent(id)` | On the actor of the thread the id names |
| `swarms.result(swarm, id)` | The typed result, none while the swarm runs |
| `forks.destroy({ swarmId, jobKey })` | `{ bytesWritten }` |

Each swarm operation also takes the thread first (`cancel(thread, id)`, `result(swarm, thread, id)`, a `thread` in
the fork's reference): the id is then taken as it is, and `SwarmIdNotOfThread` cannot happen.

`Remote.product(definition, options)` gives the product's own actions for a thread, on the same client and with the
same options, so with the same `actorKey`:

| Operation | |
|---|---|
| `call(thread, action, input)` | One product action of the actor of a thread that has one, typed by the action's schemas. It creates no actor: `ThreadNotFound` |
| `callOrCreate(thread, action, input)` | The same on the thread's actor, created empty when there is none: what a product calls before `threads.start` to give the actor its work |

Both fail with the action's own error, decoded, or as every operation does (below). A fixed action is not a product
action: it is an operation of `Remote`.

Every operation fails with one of three kinds, so a caller knows what to do:

| Error | Means | Do |
|---|---|---|
| `HostUnavailable` | The engine could not be reached, refused for now, or did not answer in `timeout` (30 seconds) | Send the same call again |
| `ThreadNotFound` | No actor under the thread's key, or the actor is gone | Start the thread |
| `OperationFailed`, and `ReviewerSharesFamily` of `start` | The operation ran and failed: `reason` is the tag of what failed (`NotHeld`, `SwarmNotFound`, `InvalidPlan`, `ActorDefect`) | Read the reason |

A swarm operation given an id that names no thread fails with `SwarmIdNotOfThread`, in the caller, before any call.

## From the consumer's loop to the packages

The consumer is PatentOS v2: `packages/compute/src/agent/Thread.ts` (the loop), the ports `AgentWork`, `SwarmRunner`
and `ForkRuntime` of `packages/contexts/agents/src/model/ports/Ports.ts`, their binding
`apps/node-domain/src/bindings/agents/Compute.ts`, its hand-written Rivet host
`packages/compute/src/host/rivet/RivetHost.ts`, and `docs/adr/0025-actor-forking-and-agent-swarms.md`.

| What `Thread.ts` does | Replaced by | What differs |
|---|---|---|
| Tools from a grant (`input.tools`), others refused | `Conversations.grantIn` in the creating commit; Pi offers exactly the grant | The model is not offered an ungranted tool at all. A call to one is Pi's `tool_unavailable`, not a hook's block |
| Forbidden verbs (`FORBIDDEN`), filtered out of the tool set | `Policy.denied` with `Matcher.firstWord` | The registry does not build. The loop silently drops the command |
| `RecordToolCall` requested, returned, failed, refused | The recorder's `ToolCallRequested` and `ToolCallResult` | Derived from committed entries, so they exist exactly when the step does. `isError` and `codes` say how it ended, and `details.guard` which rule refused it |
| `refusedTools` | `counts.refusedToolCalls` | Counted from the guard's record in each result. A person's denial is not one |
| `lease.withBudget` around every model call | `BudgetedModels` under the harness, the product's `Lease` port | Reserve and settle at the model boundary, for every request of the harness, the reviewer's included |
| `charge` for a returned call | `Lease.settle` with `outcome: "returned"` | Cost at the route table's prices (`priceRows`), at the route that served |
| `charge` for a failed call that was billed | `Lease.settle` with `outcome: "failed"` or `"aborted"`; for an attempt another route takes over, `Spend.record` through the router's settlement port | The taken-over attempt is a reservation of its own, under the key `<request id>#<attempt>`, reserved and settled inside its request, before the next route is tried |
| `spentMicros` | `counts.settledMicros` | The stored share totals of the thread and its subagents, and what its swarms' forks settled, in its storage or in actors of their own |
| `RecordMessage` per turn | The recorder's `Message` | Also the user's messages and a correction message |
| `RecordModelCall` requested, returned, failed | `ModelCallRequested` (advisory), `ModelCall` | The reviewer's request too: a `ModelCall` after its verdict's `Entry` record, with `derived` naming what a verdict does not hold (the api, the parts of the cost). No advisory record for it: its task is asked no hook |
| `RecordWorkStarted`, `ReportReadyForReview`, `RecordBudgetPause`, `RecordThreadError`, `RecordCancelled`, `SkipThreadReview`, sent by the loop | The product's `OutcomeSink`: `Started`, and `Reached` with `Reviewed`, `Answered`, `Held`, `NotReviewed`, `ReviewDeferred`, `BudgetStopped`, `Errored`, `Cancelled` | The composition calls the port; the product sends its own commands from it, keyed by the event's id. `Started` once per submission, as the loop's once per job. Delivered after the records, at least once |
| Command ids from the job key | Record ids `<conversation>:<entry>:<message>:<part>`, and `<conversation>:<entry>:entry` | Unique per harness storage: key a record by storage and id |
| Memoised turns: a resumed thread never pays twice | Pi's durable run | A committed response is never asked again. A request a close cut off is sent again: one more request and one more reservation |
| Tool commands through the outbox, once per id | Pi's tool task, `replay: "safe"` or `"unsafe"` | A safe tool runs again after a close; an unsafe one gets Pi's `interrupted` result |
| `maxTurns` | The agent's `maxTurns` | A run that reaches it ends `Errored` with `turn_limit` |
| Routes from `Routes.plan` with classification, region, zero data retention and BYOK | The route table; per thread, the grant's classification and `Work.routing` | `regions` are a list; zero data retention and BYOK are labels the product puts on routes and asks for in `requires`. No `batch` |
| Fallback routes (`fallbacks`) | The router: one attempt per route, recorded as `RouteEvent`s | Only for a retryable error before any output |
| Cross-family review, `SkipThreadReview` | `Reviewers.check` before the thread starts; `Review.extension`, `NotReviewed` with the reason | A thread whose reviewer shares a family with its author is not started. In the plugin the rule is applied to the configured reviewer before the request and to the route that served after it |
| One corrective run, then held | `maxCorrections: 1`, `Held` | The same run continues with the correction as a user message. A person releases a hold (`Threads.release`) |
| `RecordThreadReview`, `RequestCorrectiveRun` | `review.verdict` and `review.release` entries, delivered as `Entry` records | The verdict's outcome says `Corrected`; the correction itself is the next `Message` |
| `budget_paused`, in a turn or at the review | `BudgetStopped` with the typed refusal; at the review also the deferred verdict | `Threads.resume` continues the run, or asks for the review again |
| A reviewer call that fails: `ready_for_review` | `ReviewDeferred` with the provider's error text | The answer is not passed off as unreviewed for good: `Threads.resume` reviews it |
| `errored`, `RecordThreadError` | `Errored` with Pi's reason and detail | The failed response is a `ModelCall` record |
| `cancelled`, obeyed before the next turn | `Cancelled`; `Conversation.abort` | Immediate: the request in flight is aborted and settled, a review included |
| `ready_for_review` when `review` is false | `Work.review: false`, `Answered` | The thread's conversation does not select the review: nobody is asked or paid |
| `Sealer`: bodies sealed under the tenant key | Nothing | Records carry content in clear. Sealing is the sink's |

In one process the ports are served by `Threads` and `Swarms`; hosted in Rivet actors, by `Remote`:

| Port operation | Served by (`Remote`) | What differs from the consumer's contract |
|---|---|---|
| `AgentWork.start(threadId, jobKey)` | `threads.start(work, jobKey)` | The port carries no work: the binding builds `work` (task, model, grant, cap, routing) from the thread's own record. It returns at durable admission, as the binding's background start does. `jobKey` is the request key of the task, and the `key` of the outcome events of that submission. A start under another job key for a thread that exists is the same work (`created: false`, the first key stands): the loop would run it as a new job |
| `AgentWork.resume(threadId, jobKey)` | `threads.resume(thread, jobKey)` | The binding runs `run(threadId, jobKey)` for start and resume alike. Here resume only takes a stopped thread on: `unchanged` for one that works or ended for good. A continuation is idempotent by `jobKey`; the retry of a deferred review is idempotent by the review's state, so a late duplicate can ask the reviewer once more |
| `AgentWork.cancel(threadId, idempotencyKey)` | `threads.cancel(thread)` | No key is taken: it is idempotent by itself. Immediate: the request in flight is aborted and settled |
| `AgentWork.probe(threadId)` | `threads.probe(thread)` | `alive` means unfinished work, also parked, held or deferred, not "the actor answers". An engine that cannot be reached is `HostUnavailable`, never `alive: false` |
| `SwarmRunner.run(threadId, step, idempotencyKey)` | `swarms.run(swarm, plan)` | The swarm id is the idempotency key, and it names the thread: the binding gives `SwarmId.of(threadId, idempotencyKey)` as `plan.id`, and that is the `swarmId` the port's other operations take. It makes the plan from `step`: jobs, cap, pins, the allowance of every fork (tools, budget cap), and an agent change for the forks (a cheaper model, fewer tools), by name. A real swarm: keyed actor forks under a cap, typed fan-in. The binding runs one job sequentially |
| `SwarmRunner.cancel(swarmId, idempotencyKey)` | `swarms.cancel(swarmId)` | Hosted, where the binding fails closed. The id alone finds the actor of the swarm's thread. No key: idempotent, `cancelling` then `ended` |
| `SwarmRunner.probe(swarmId)` | `swarms.probe(swarmId)` | Hosted: `{ alive, jobKeys }` from committed reads |
| `ForkRuntime.destroy(forkId, idempotencyKey)` | `forks.destroy({ swarmId, jobKey })` | Hosted. A fork is named by its swarm and its job, which with the thread the swarm id names is its actor's key. No key: idempotent, the second call answers what the first learnt. `storageBytesWritten` is `bytesWritten`, an option: the size of the fork's SQLite database when it was destroyed less its source's when it was forked, in whole pages, never below zero. It is growth, not bytes written (Rivet reports none), and none for a fork that was gone or unrecorded: the port wants an integer |

| The hand-written Rivet host (`RivetHost.ts`) | Replaced by | What differs |
|---|---|---|
| The actor `computeUnit` keyed `[kind, key]`, programs found by name in a registry of this process | `ThreadActor.make`: one definition, one actor per thread keyed `[thread]` (or per piece of work, with `Remote`'s `actorKey`), a fixed set of typed actions and the product's own beside them | No program registry: what an actor can do is its actions, with `Schema`s at the boundary |
| `scratch` and `command_outbox` tables, `BEGIN IMMEDIATE` under the actor's own semaphores | Pi's storage on the actor's SQLite through the host's queued adapter; the recorder's cursor over Pi's entries is the outbox | No outbox rows: a record is derived from a committed entry, delivered at least once under a deterministic id |
| The `run` action runs a program inside the action | Actions admit and return; the harness works outside any action, and the wake keeper holds the actor awake | Long work no longer needs to fit Rivet's action timeout, which is what the host's header leaves open ("the Rivet Workflow form") |
| `transact`: a closure registered in this process, run by the actor | Nothing: every call is an action that carries data | Works with several host processes; the hand-written host serves one node |
| `keys(kind)`: the units this process has seen | `Client.find` by key; the product knows its thread ids | No listing of actors |
| `Answer`: success, failure or defect as JSON | The host's `Answer`, `Client.call`'s typed errors, and `Remote`'s three kinds | A caller is told whether to try again |
| `startLocalEngine` in a folder and on ports the caller chooses | `LocalEngine.serve` of the host's `/node` or `/bun` entry | A free port set and a temporary directory, removed with the scope |
| No `onFork` | The host cancels inherited schedules; `ThreadActor.hygiene`; the product's `forkHygiene` | ADR 0025, decision 3 |
| Nobody polls: the loop itself sends the commands that say a thread's state changed | The thread's actor calls the product's `OutcomeSink`, and is woken for an event its sink refused | The port is built in the actor from the product's `ports`: what it reaches (the domain's API) is the product's |

## Kill and resume

`test/kill-resume.ts` runs one thread on a SQLite file with both drivers, closes the composition at one point, and
reopens it with the same lease, sinks, inbox and providers. Each case reaches the outcome of an uninterrupted run,
delivers the same records under the same ids with no id carrying two contents, tells its outcome sink the same
events under the same ids with no id carrying two contents, and settles every reservation once. Record deliveries
are the committed records the sink took, repeats included; delivery is at least once, and in these runs no record
came twice.

| Closed | Provider requests | Reservations and settlements | Record deliveries | Why |
|---|---|---|---|---|
| (uninterrupted) | 2 author, 1 reviewer | 3, all `returned` | 8 of 8 | Six of the transcript, one `review.verdict`, the reviewer's model call |
| In a model request | 3 author, 1 reviewer | 4: one `aborted` at zero cost | 8 of 8 | Pi sends a request a close stopped again |
| In a tool call | 2 author, 1 reviewer | 3 | 8 of 8 | A `replay: "safe"` tool runs again: its handler ran twice |
| While parked for approval | 2 author, 1 reviewer | 3 | 8 of 8 | The parked call survives; the request is published again with the same id |
| In a review | 2 author, 2 reviewer | 4: one `aborted` at zero cost | 8 of 8 | A check that had not answered runs again |
| (uninterrupted, lease fenced at the review, renewed, resumed) | 2 author, 1 reviewer | 3, all `returned`; the lease refused once | 10 of 10 | Two verdicts, `Deferred`, then `Passed`, each with its reviewer's call: the refused one a failed call of no tokens |
| While the review is deferred | 2 author, 1 reviewer | 3; the lease refused once | 10 of 10 | Deferred stays deferred: the reopen asks neither the reviewer nor the lease, and reads the same `BudgetStopped` |

The outcome sink is told `Started`, then `Reviewed`, in every case of the first five rows, and `Started`,
`BudgetStopped`, `Reviewed` in the last two: the same ids as the uninterrupted run. One more case closes a
composition whose sink refused `Started` an hour before its next attempt: the thread ends in it untold, and the
composition that opens the file again tells both events at once, the refused one as it was first offered, with no
thread operation called.

On Rivet the same holds for an actor that sleeps (`test/rivet-suite.ts`, on a real engine): forced to sleep in a model
request, the actor is woken by the recovery wake its keeper scheduled, and the thread ends reviewed after 3 author
requests and 1 reviewer request, with 4 reservations, one `aborted` at zero cost, and the same 8 records; put to
sleep twice while parked for approval, it repeats no model request and publishes the same approval request again;
put to sleep with an outcome its sink had refused, it is woken by the wake of its courier's next attempt and tells
it.

### A host process that dies, and several of them

`test/hosts-suite.ts` runs the actors in child processes on one local engine that outlives them, with everything the
hosts change (the lease, the sinks, the models, what the tools do) in the test's process behind HTTP. The local
engine keeps an actor's storage and its schedules when the host's process dies. Every case passed on Node and on Bun.

| What happens | What was seen |
|---|---|
| SIGKILL with a model request out, then a second host | The recovery wake brings the actor up in the second host, with no caller, about 15 seconds later. The request is sent again, with the same session and the same advisory record id. The tool runs once, `Reviewed` is told once. The killed request's reservation is settled by nobody; every other one once, and the thread's amount is what was settled |
| SIGKILL after an unsafe tool's effect, before its commit | The tool does not run again: the model reads an `interrupted` error result. No request is repeated |
| SIGKILL in a safe tool, and no host for 18 seconds | The wake that came due with nobody to run it is kept: the thread goes on in the next host, and the tool runs again. A call made meanwhile fails with `HostUnavailable` |
| SIGKILL after the outcome sink took an event, before its reply | The event is told again under the same id with the same content: at least once, as the port says |
| Two hosts, twelve threads | Both hosts run some, each actor in one host. A call reaches every actor; eight `getOrCreate`s of one key at once are one actor |
| One of two hosts leaves, by SIGKILL or SIGTERM, with requests out | Every thread ends in the host that stays. SIGTERM settles the requests it cuts off; SIGKILL leaves their reservations open |
| A host is frozen (SIGSTOP) until the engine moved its actor, then goes on with the model's reply in its socket | The other host took over after about 30 seconds. The thawed host sends no request, runs no tool, and delivers no record and no event: it closes its actor, at most after settling the request it had sent |
| The host of a swarm's coordinator is killed while forks work | The swarm ends with every typed result and one fork per job; a job whose host died is asked again with its session |

Two limits show in it. **A frozen host is not stopped the instant its actor moves**: after the thaw it still holds the
actor in memory for some milliseconds until it is told, and a settlement and a sign of life were seen from it. None
of its commits was seen to land. Code that acts outside without a commit before it (a tool in the middle of its effect) is not
fenced by the host: the product's own service must refuse it, by the lease or by an idempotency key. **A killed
host's reservations stay open**: the product's lease expires them.

## Gaps

What remains: where the packages still do not compose, or cannot express what the consumer's loop and host do. Most
serious first. Each names its evidence, the smallest change that would close it, and the package it belongs to. What
earlier passes closed is listed below (1 to 30).

**1.** Closed: the reviewer's model call says its api, the parts of its cost and whether a provider billed it, and
its time is when the request started (29).

**2.** Closed: an outcome a thread left before its courier looked is told, from the transcript: a hold a person
released at once, a deferral asked for again at once, and the end of a run the product took on at once (30).

**3. A process that dies between the end of a thread's work and the wake of its courier tells at its next open
only.** The two are two commits of the same process: the first is Pi's, and a hook cannot commit with it.
- Evidence: none of that window, which is two commits wide. `test/kill-resume.ts` closes at five points and loses no
  event; `test/hosts-suite.ts` kills the process before the sink replied, and the event is told again.
- Smallest fix, Pi: a submission that notifies a task when it settles does so in the settling commit already
  (`notify`); the same for a task that ends (a hold, a deferral) would close the window.

**4. A destroyed fork frees nothing in the thread's storage, and its bytes are those of its entries as JSON.** Pi
cannot delete or measure a conversation.
- Evidence: `swarm-effect`, `test/conversation-forks.test.ts`, "aborts the fork's work, marks it destroyed for
  good, and says what its own entries weigh"; `test/swarm.test.ts`, "fans typed results in …".
- Smallest fix: Pi, a delete of a conversation and its size.

**5.** Closed: the agent change that crosses to an actor carries `cwd` and `compaction` (27).

**6. A request that is sent again has no key of its own that a provider could refuse a repeat by.** The lease has
one now (28): a key of the session and the whole context, the same for the request a crash cut off and the request
Pi sends again. A provider gets none, and the packages cannot make one it could use. Pi's retry after a provider
error sends the same context, so it has the key of the send that failed: a provider that answered a key it has seen
from its record would answer every retry with that error. What tells a resend from a retry is which attempt a send
is, and that reaches no provider call. Nor would Pi's attempt number do as it is: Pi 1.6.1 counts a send a crash cut
off as a failed attempt (`interrupted` in `generation.ts`), so the resend is the next attempt.
- Evidence: `budget-effect`, `test/budgeted-models.test.ts`, "is reserved under the key of the send that failed when
  Pi retries it after a provider error"; the resend's key is 28's evidence.
- Smallest fix, Pi: the generation task keeps a key per send in its checkpoint, kept by `interrupted` for a send a
  crash cut off and made anew after an attempt a provider answered (`classify`), and passes it with the request
  options where `generation.ts` sets `sessionId`. pi-ai has no option for such a key today, so it needs one that its
  adapters send where a provider's API takes it.

### Not proven on a local engine

A local engine is one node on one machine. What needs a Rivet deployment, or a moment no test can hold, to be shown:

- **A background subagent's run that is live when its actor is forked.** The host copies one only in two windows a
  few commits wide: after the run was created and before its child got the task, and after the child's submission
  settled and before the run recorded it. Nothing in the composition holds a run there (its `ChildSetup` answers at
  once), so no engine test can make the fork happen in one. The evidence is `subagent-effect`'s suite on a copied
  SQLite file, on both drivers, which holds a run in the first window with a setup port that does not answer, and
  copies another in the middle of its child's request. On the engine, step 3 runs in every fork of the suite, on
  storages without a live run.

- **The product's own ports.** In the host process suite the lease and the sinks are reached over HTTP from each
  host, but they are a test's: a real lease that fences a fork's actor, and a sink that keys a record by the actor
  it came from, are the product's.
- **Host processes on several machines**, an engine of several nodes, an engine process that dies, engine upgrades
  (the only source of `actor.fork_unavailable`), and a network that parts a host from the engine. A frozen process
  is the nearest the suite comes to the last.
- **An engine that cannot be reached.** A call that nobody answers was made to happen (below), an engine that is gone
  was not.
- **A statement the storage refuses in the middle of a Pi commit.** The engine answered `depot.overloaded`
  (`volume_transition`) to forks of the 50-fork swarm, once or twice a run; the host sent them again, as its README
  says. None was seen inside a commit.
- **Load.** One process hosted the thread, its 50 forks and their harnesses. Under a cap of 8, at most 4 jobs were
  at a model at once: the engine's cost per fork, not the cap, bounds the swarm.

### Limits the packages document, which a product inherits

- **A crash between `reserve` and `settle`** leaves a reservation the product's lease must expire, or release when
  the request is sent again: the new reservation carries the same `requestKey`. The provider may have billed the
  request (budget-effect).
- **A close or a crash between a settlement and the commit of a share's total** leaves the stored total, and so
  `settledMicros`, short by that request. The suite's aborted requests settle zero (budget-effect).
- **A request a close cut off is sent and reserved again** (durable-effect; the table above).
- **A response Pi never committed is in no record.** A crash after a provider answered and before Pi's commit
  leaves a paid call without an entry (recorder-effect).
- **Pi can end a run around the review.** A review task that faults, and the restart limit, end the run with an
  answer and no verdict: `NotReviewed` (`no_verdict`, `request_failed`). An abort whose verdict the review task
  cannot store reads the same, so such a cancel is `NotReviewed`, not `Cancelled`: this package keeps no cancel
  mark of its own any more (review-effect).
- **A message queued behind a review replaces its correction**, the automatic one or a person's (review-effect).
- **A held or deferred thread blocks its conversation**, and nothing retries by itself: the product calls
  `Threads.release` or `Threads.resume` (review-effect).
- **The guard's record has gaps.** A result Pi settles without asking the hooks, and one whose `details` a later
  extension replaces, carry none, so `refusedToolCalls` can be low (guard-effect).
- **The guard cannot stop a provider request.** A model set with `configure`, outside the guard, is not checked
  against the classification; the router's ceilings are what stops a request (guard-effect).
- **On Rivet, a statement the storage refuses in the middle of a Pi commit fails that commit**, and the harness
  with it until the actor sleeps and wakes. A stop does not drain: a request in flight is cut off and sent again
  (durable-rivet-effect).
- **A thread that is held, deferred or parked is not forked**, and a swarm started on it waits without a deadline:
  `cancel` ends the wait (durable-rivet-effect, swarm-effect).
- **Copies do not share what is left of a cap.** A copied conversation counts what it inherited against its cap, so
  no copy spends a cap again; but each of 50 forks of a conversation at 90% of its cap may settle the last 10%. A
  cap bounds one conversation in one storage: what bounds the whole is the product's lease (budget-effect).
- **A thread's money asks the forks that still exist.** The account of a destroyed fork is kept in the thread's
  actor; a live or a pinned fork is asked with every read of the thread's outcome, which wakes it, and one that
  cannot be asked counts as zero until it can (`Accounts.forks` here).
- **A fork's copies of its source's swarm records still answer.** `probeSwarm` and `swarmSpent` of a fork say what
  the source's swarm was when the fork was made; only the thread's money leaves them out (here).
- **A subagent run copied in flight ends in the copy with `copied`**, and the copy's model reads that as an error
  result if it asks: the work is the original's (subagent-effect).
- **A fork that cannot give its account is not destroyed.** After ten refusals the swarm leaves it, listed, for
  `destroyFork` later (swarm-effect; `Accounts.forks` here).
- **A wake that is due is replaced by the keeper of the wake it causes**, before Rivet runs its action: the actor
  wakes at the time, and the testing entry's lifecycle shows the wake and no `fired` (durable-rivet-effect).
- **A process that dies between a provider's failure and the end of its settlement** leaves that attempt settled
  by nobody: the router keeps nothing across a restart (router-effect).
- **The router keeps nothing across a restart**: request ids, the limiter's backoff. The constraint source answers
  from the storage, so it does (router-effect).

### Closed since the first pass

| # | The gap was | Now | Evidence |
|---|---|---|---|
| 1 | The family rule does not see the model that reviewed | Closed by `review-effect`: the rule is applied again to the route the response names; and here (15) | `review.test.ts`, "without that check, pays a reviewer …" |
| 2 | A lease fenced at the review ends the thread unreviewed | Closed by `review-effect` (`Deferred`, `Review.retry`) and here: `BudgetStopped` with `review`, and `resume` retries | `review.test.ts`, "stops the thread with the lease's reason …"; kill and resume, "while a review is deferred" |
| 3 | The review is invisible to the sink | Closed by `review-effect` (`Verdict.call`) and `recorder-effect` (`Records.Entry`); the model call record is 23 | `review.test.ts`, "gets the verdict as the record of its entry …" |
| 4 | A failed route attempt is never settled | Closed by `router-effect` (`sessionId`, `requestId`), `budget-effect` (`Spend`) and `Fallbacks.layer`; and in order (16) | `budget.test.ts`, "falls back to the next route …" |
| 5 | A thread's classification does not reach the router | Closed by `router-effect` (`ConstraintSource`, labels), `guard-effect` (`Conversations.granted`) and here: the session index, `Work.routing` | `budget.test.ts`, "what a thread says of its routes" |
| 6 | The subagents' setup cannot take the guard from its context | Closed by `guard-effect` (`Guard.fromPolicy`, `Guard.registry`): the `Deferred` is gone | `composition.test.ts`, "builds a child setup that takes the guard from its context …" |
| 7 | A swarm's forks spend without a cap and without an owner | Closed by `swarm-effect` (`ForkSetup`, `ran`), `budget-effect` (`setCapIn`) and `ForkSetup.layer`, `Swarms.spent`; on Rivet by `Accounts.forks` | `swarm.test.ts`, "fans typed results in …", "stops a fork at its cap …"; `rivet-suite.ts`, the same two |
| 8 | The guard's refusals are not durable | Closed by `guard-effect` (`Refused.of`): the count reads the record, and the guess is gone | `guard.test.ts`, both thread tests; `approvals.test.ts`, the denial |
| 9 | A cancel during a review looks like an answered run | Closed by `review-effect` (`review_aborted`): the cancel mark is gone. One window is left, under the limits above | `review.test.ts`, "is cancelled in the middle of a review …" |
| 10 | A grant wider than a declaration widens a child | Closed by `guard-effect` (`mode: "narrow"`), used for children and forks | `subagent.test.ts`, "never offers a child more than its declaration …" |
| 11 | `Review.release` returns before the hold has ended | Closed by `review-effect` (`Released`, `waitForHoldEnd`): the watch is gone | `review.test.ts`, "holds the thread after two blocking verdicts …" |
| 12 | A destroyed fork says nothing of its size | An integer on Rivet since the first pass; in the thread's storage, 24 | `swarm.test.ts`, "fans typed results in …" |
| 13 | Prices are written twice | Closed by `router-effect` (`priceRows`): the tests' price table is its output | `test/world.ts` (`PRICES`), and every cost assertion |
| 14 | The harness options are an Effect, and a Rivet actor takes a value; `Actor.make` read what `layer` provides off `services` | Closed by `durable-rivet-effect`: `harness` is taken as an Effect, and `NoInfer` on what `services` requires | `rivet-shape.test.ts`, both tests |
| 15 | A reviewer that falls back into the author's family is paid and reviews nothing, for good | Closed here: `Reviewers.check` refuses the start of such a thread, naming the routes. The review plugin alone still does it | `review.test.ts`, "is not started with a reviewer of its author's family …", "is not started when a route its reviewer's alias falls back to …"; `rivet-suite.ts`, "does not start a thread whose reviewer …" |
| 16 | A route attempt another route took over is settled beside its request, and only from memory | Closed by `router-effect` (`AttemptSettlement`, awaited, fail closed) and `Fallbacks.layer`, which implements it with `Spend.record`: the lease is told inside the request, and a refused charge ends the request on its own reservation. A process that dies in between still loses the attempt (the limits above) | `budget.test.ts`, "tells the lease of the failed attempt inside its request …", "tries no other route when the lease refuses the failed attempt …" |
| 17 | The actor form of the composition is not built: swarms on actor forks, `SwarmRunner` and `ForkRuntime` are not served | Closed here: `ThreadActor`, `Accounts.forks`, `Remote`, on a real engine | `rivet-suite.ts`, all of it |
| 18 | A background subagent that is live when its thread's actor is forked runs in both actors | Closed by `subagent-effect` (`onStorageFork`, the mark `subagent.copy`, the reason `copied`) and here: step 3 of `ThreadActor.hygiene`. Not made to happen on an engine (above) | `subagent-effect`, `test/sqlite-suites.ts`, "a copied storage", three tests on both drivers |
| 19 | A fork's copy of a share repeats its source's money, and cannot be reset | Closed by `budget-effect` (`onStorageFork`, `Share.inherited`, `ShareDocument`) and here: step 4. A cap counts what was inherited; a sum over actors counts `settled` alone | `rivet-suite.ts`, "runs a swarm of a thread on actor forks …": the pinned fork answers the thread's outcome with `settledMicros` 0, beside its source's total; `budget-effect`, `test/sqlite-suites.ts`, "a copied storage" |
| 20 | A thread's money depends on where its swarms' forks live | Closed here: the thread's document keeps its swarm ids, `Counts` adds the accounts of forks that are actors, and step 5 keeps a fork from counting its source's | `swarm.test.ts`, "fans typed results in …", and `rivet-suite.ts`, "runs a swarm of a thread on actor forks …" and the 50 forks: the thread's own total and each job's once, equal to what the lease was told |
| 21 | A swarm is found by its thread | Closed here: a swarm id begins with its thread's key (`SwarmId`), checked at `run` in the client and in the actor, and every swarm and fork operation of `Remote` takes the id alone; the form with the thread stands. The agent change is 25 | `rivet-suite.ts`, "runs a swarm of a thread on actor forks …", "cancels a swarm …"; `swarm-id.test.ts` |
| 22 | A caller learns of a thread's end by asking | Closed here: the port `OutcomeSink`, called by the process that works the thread with `Started` and every outcome reached, at least once, in order, under an id of the submission and the entry, after the records. The delivery is a Pi task (`OutcomeCourier`), so the Rivet host holds an actor awake for it and wakes it for an attempt that failed. What is left is gaps 2 and 3 | `outcomes.test.ts`, all of it; `kill-resume.ts`, every case and "an outcome its sink refused is told when the storage is opened again …"; `rivet-suite.ts`, "works a thread …", "delivers an outcome its sink refused once after a forced sleep …"; `storage-fork.test.ts`, "are its source's to tell …" |
| 23 | The reviewer's request is a field of an entry, not a model call record | Closed here (`ReviewCalls.layer`) with one optional field of `recorder-effect` (`ModelCall.derived`): a `ModelCall` after the verdict's record, under an id no record of the recorder has. What a verdict does not hold is gap 1 | `review-calls.test.ts`; `review.test.ts`, "gets the verdict as the record of its entry …", "stops the thread with the lease's reason when the budget refuses the reviewer …"; `thread.test.ts`, "reserves and settles once per provider request …" |
| 24 | A destroyed fork in the thread's storage does not say what it wrote | Closed by `swarm-effect`: the in-storage driver answers the bytes of the UTF-8 JSON of the entries the fork appended after its fork point, and keeps the number. What it is not is gap 4 | `swarm.test.ts`, "fans typed results in …"; `swarm-effect`, `conversation-forks.test.ts`, `host.test.ts` |
| 25 | An agent change for a swarm's forks does not cross to an actor | Closed here (`ForkAgent`, `Remote.Plan.agent`, `runSwarm`) with `swarm-effect`'s `named`: the model, the thinking level, the instructions, the turns, and tools and extensions by name. What is left is gap 5; its names are 26 | `rivet-suite.ts`, "runs a swarm's forks with the agent change of its plan …"; `fork-agent.test.ts` |
| 26 | The names of an agent change that crosses to an actor are not checked there | Closed here: `runSwarm` holds them against the actor's registry (`ForkAgent.requireInstalled`) and answers `InvalidPlan` with the names nothing is installed under | `fork-agent.test.ts`, "an agent change held against the registry of the actor"; `rivet-suite.ts`, "runs a swarm's forks with the agent change of its plan …" |
| 27 | The agent change that crosses to an actor carries neither `cwd` nor `compaction` | Closed here: `ForkAgent` is all of `Agent.Change`, and `ForkAgent.Wire` checks `cwd` and `compaction` as Pi's `configure` would (token counts integers 0 or more), in the client and in the actor's `runSwarm`; each fork's actor stores them | `fork-agent.test.ts`, "is the working directory and the compaction settings as they are", "does not cross with a token count of its compaction that Pi's configure would refuse"; `rivet-suite.ts`, "runs a swarm's forks with the agent change of its plan …" (the forks' stored agent) |
| 28 | A request that is sent again has no key a lease can tell it by | Closed by `budget-effect` (`BudgetRequest.requestKey`), `router-effect` (`RouteEvent.requestKey`) and here (`Fallbacks.layer` passes it with a failed attempt's charge): the SHA-256 of the session and the whole context, which Pi builds from committed entries without failed or cut-off answers. The provider half is gap 6 | `hosts-suite.ts`, "goes on in a second host process …": the killed request and its resend in the second process reserved under one key, the next request under another; `budget.test.ts`, "falls back to the next route …" (one key in the reservation, the route events and the charge); `budget-effect`, `sqlite-suites.ts`, "settles a request a close cut off … under its key …" |
| 29 | The reviewer's model call does not say its api, the parts of its cost, or whether a provider billed it | Closed by `review-effect` (`Verdict.call` keeps the response's `api`, `responseModel`, `responseId`, `timestamp`, `durationMs`, `cacheWrite1h`, `reasoning` and pi-ai's whole `usage.cost` as `usage.costs`) and here: `ReviewCalls.modelCall` fills them, its `time` is when the request started, and `derived.unknown` is empty. A verdict stored before still decodes, and its model call names what it lacks, as before | `review-calls.test.ts`, "is the reviewer's request in the shape of every other model call, with nothing a verdict does not hold", "names what a verdict stored before …"; `review.test.ts`, "gets the verdict as the record of its entry …"; `review-effect`, `model-review.test.ts`, "keeps of a response its api, the provider's ids, its times, and pi-ai's whole usage and cost" |
| 30 | An outcome a thread left before its courier looked is not told | Closed by `review-effect` (`Review.waitOf`: the hold or the deferral a verdict began, from the verdict alone; `Verdict.inputs`: the submissions the reviewed run answers; `Review.verdicts` from an entry) and here: the courier tells, submission by submission, every wait the transcript holds, each resting on its verdict, then how the submission ended, then the next one's start. No entry kind was added: a hold and a deferral begin with their verdict, in the commit that puts the review task to sleep. A wait whose verdict was stored before verdicts named their inputs is told as before, from where the thread stands | `outcomes.test.ts`, "is told each state a held thread goes through …", "is told each deferral of a review that was asked for again at once …", "is told of a stop the product took on before it was told …", each with a sink that takes nothing until the thread moved on; `kill-resume.ts`, the deferred case resumed at once; `review-effect`, `state.test.ts`, "waitOf" |

## What the loop does that this does not, and the reverse

The loop, not the composition: the record commands `RecordWorkStarted`, `ReportReadyForReview`,
`RecordBudgetPause`, `RecordThreadError`, `RecordCancelled` and `SkipThreadReview` themselves (the composition calls
the product's `OutcomeSink`, and the product sends them from it); `RecordThreadReview` and `RequestCorrectiveRun` as
commands of their own (here they are `Entry` records); sealed bodies; prompt ids and versions on a model call; a
`batch` constraint on routes.

The composition, not the loop: a thread that is not started with a reviewer of its author's family; approvals that park a call; subagents with their own grant and cap; swarms with
keyed forks, a cap on live forks, an allowance per fork, cancel, a probe with job keys, the spend of each job and
fork destruction; argument rules and classification ceilings on tools; a limiter with backoff and a record of every
route attempt; a charge for an attempt another route took over; a citation check; a hold a person releases by
accepting or correcting; a review that is asked for again when its request failed; a stopped thread continued
without replaying a turn; a cancel that aborts the request in flight; an outcome that is told again until its sink
took it, across a sleep and a restart; Pi's telemetry on Effect's tracer; search evidence kept with the tool result.

## What is stored

Beside what the plugins store, seven documents of this package and one task, in the harness storage:

| Kind | Scope | What |
|---|---|---|
| `thread.work` | session, per thread key | The thread's conversation, the request keys its work was admitted under, and the ids of the swarms started on it |
| `thread.outcomes` | session, per thread key | The delivery cursor of the thread's outcome events: the newest event the sink took, the event being delivered (stored before the sink is called), the courier that delivers, and what wakes it |
| `thread.session` | session, per provider session | The conversation the session belongs to |
| `thread.routing` | conversation; a fork copies its parent's | The regions and labels of the conversation's routes |
| `thread.swarm` | session, per swarm id | The allowance of the swarm's forks |
| `thread.spent` | session, per swarm id; with forks that are actors | Per job, what its fork had settled when it was last asked before its destruction |
| `thread.copy` | session; in a storage that was copied | The newest task the copy inherited: swarms up to it are its source's, and a courier up to it ends without delivering |

The task is `thread.outcomes`, the courier: one per submission of a thread, a background task of the thread's
conversation, live until that submission settled and its events are delivered. Its signal is
`thread.outcomes.nudge`. The entry kinds a thread's conversation holds are the plugins' (`review.verdict`,
`review.release`) and Pi's.

## Tests

Scripted models only: no network and no key. From this directory:

```sh
node ../../node_modules/vitest/dist/cli.js --run
bun test --conditions=source
```

- **In one process** (107 tests): the thread, the guard, the budget and the router, approvals, the review, subagents,
  swarms on the in-storage driver, the outcome sink (which events, their ids and their order, the record sink before
  it, a sink that fails, a schedule that ends, the sink that keeps nothing), the reviewer's model call, the events
  and the agent change as data, kill and resume on a SQLite file with both drivers, the swarm ids, the
  composition's own step on a copied storage, a thread actor's definition with product actions and a Layer of the
  product on the open harness, and what their types refuse (`thread-actor.test.ts`), and the client on a stand-in engine: which actor each operation asks with and
  without `actorKey`, and a product action called for a thread (`remote.test.ts`).
- **On host processes that die** (`test/hosts-suite.ts`, 9 tests, registered by `hosts.node.test.ts` and
  `hosts.bun.test.ts`): child processes that host the thread actor on a local engine the test started, killed, stopped
  and frozen by their pid ([above](#a-host-process-that-dies-and-several-of-them)). About 200 seconds on Node and 185
  on Bun, most of it waits for the recovery wake and for the engine to give up a frozen host.
- **On a local Rivet engine** (`test/rivet-suite.ts`, 15 tests, registered by `rivet.node.test.ts` and
  `rivet.bun.test.ts`): the engine binary of rivetkit's platform package, started by the host's `/node` or `/bun`
  entry on a free port set with its data in a temporary directory. Skipped, with a message, when the binary is not
  installed. It covers: a thread from start to its reviewed outcome with one key twice, told to the outcome sink by
  its actor after its records; the three kinds of error; the reviewer check across the boundary; a call parked for
  approval through two sleeps; a forced sleep in a model request; an outcome its sink refused once, delivered after
  a forced sleep by the wake of its courier's next attempt; a fenced lease and a resume; a cancel with the probe
  before, during and after; a swarm on actor forks with typed results, forks set up in their own actors, records
  and money per job and in the thread's own amount, a pinned fork that repeats none of its source's money and none
  of its outcome events and is destroyed later by its swarm id alone; a swarm whose plan changes the agent of its
  forks, on the model and with the tools it names; a fork stopped at its cap; a cancelled swarm; an actor that holds two
  threads under the product's `actorKey`, created by a product action before either starts, with the product's
  own Layer built on its open harness at each wake, and a swarm of one of them found by its id and its fork destroyed through the same function; the host's idle rule for a working, a
  parked and an idle thread; and 50 jobs on actor forks of a thread of 30 entries under a cap of 8.

Measured on the local engine, with scripted models and a poll every 100 milliseconds: the suite took 37 to 41 seconds
on Node (six runs) and 38 to 40 on Bun (four runs), about 15 of them the wait for the recovery wake of the sleep
test and 3 the wait for the next attempt of the refused outcome. The 50-fork swarm took 5.4 to 6.7 seconds, and 6.3
to 8.1 with priming, on Node (three runs); 5.8 to 6.6 and 6.9 to 8.1 on Bun (four runs): what the swarm package
measured for its bare driver, so the composition, a fork's account and its flush add little to the engine's cost per
fork. The test bounds the whole at 20 seconds.

## License

MIT
