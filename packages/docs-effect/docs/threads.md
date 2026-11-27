# Build an Agent Thread

`@effectified/pi-thread` is the pi-effect plugins composed in the order their READMEs require. A product gives it
data and ports, and gets `Threads` and `Swarms`: a thread is worked to its end from one call, and its outcome is
delivered to the product. Read [How pi-effect Works](how-it-works.md) first if the packages are new to you.

For threads hosted in Rivet actors, read [Host Threads in Rivet Actors](rivet.md) after this. For writing a tool or
a hook, read [Write Tools, Hooks, and Plugins](extending.md). For tests, [Test Without a Network](testing.md).

## Wiring it

`Composition.open(config)` is one `Layer` that provides `Threads`, `Swarms`, the open `Harness` and the plugins'
services. It requires a `HarnessStorage`, `PiTelemetry` and the product's ports. From the README (`App`, `policy`,
`routes` and the rest are the product's):

```ts
import { Effect, Layer } from "effect";
import { fromPiModelRef } from "@effectified/pi-ai";
import { Prices } from "@effectified/pi-budget";
import { Storage, ToolName } from "@effectified/pi-durable";
import { priceRows } from "@effectified/pi-router";
import { Composition, ThreadKey, Threads } from "@effectified/pi-thread";

const live = Composition.open({
	extensions: [App, SearchTools.extension()], // the product's tools
	guard: { policy, rules },
	approvals: { tools: [ToolName.make("transfer")], expiresAfter: "1 day" },
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
		thread: ThreadKey.make("thread-42"), // the product's key, and the idempotency key
		task: "What is record 42 called?",
		model: fromPiModelRef({ provider: "router", modelId: "author" }),
		grant: { tools: [ToolName.make("lookup")], classification: "internal" },
		cap: 1_000_000n, // micro units of the lease this thread may settle
		routing: { regions: ["eu"], requires: ["zero-data-retention"] }, // optional
		review: true, // optional; false ends an answered thread `Answered`, unreviewed
	}),
).pipe(Effect.provide(live));
```

Steps, in this order:

1. **Data.** A `Composition.Config`: `extensions` (the product's tools), `guard` (`policy`, `rules`), `approvals`,
   `models` (`providers`, `routes`, optional `router`), `review` (`policy`, `checks`), `subagents` (`subagents`,
   `maxDepth`, `maxLive`, `caps`), `swarms`. Optional: `forks`, `recorder`, `outcomes` (the retry of the outcome
   sink), `settings` (Pi's run policy).
2. **Storage.** `Storage.sql()` of `@effectified/pi-durable` over an Effect SQLite client
   ([Storage](../../durable-effect/README.md#storage)). Memory storage cannot be reopened: a product keeps a file.
3. **Ports.** One `Layer` with every port below, and every service the product's tools, rules and checks need.
4. **Prices.** Written once, in the route table. `priceRows(routes)` gives the budget's rows, as the last line of
   `live` above does.
5. **Call** the services: `Threads.Threads.use((threads) => threads.work(...))`, or `yield* Threads.Threads`.

**Build it once per process.** Each build of `live` opens a harness on the storage, and one process drives one
harness storage. Provide it once around the program that serves the product (or make `ManagedRuntime.make(live)`
once), and run `work`, `Approvals.pending`, `Approvals.decide` and the rest through it, not one `Effect.provide(live)`
per call. Keep it open while threads run: records and outcome events are delivered by the open harness, and what was
not delivered at a close goes out at the next open.

The composition's parts (`Composition.layer`, `Composition.harness`, `Composition.services`) are what a Rivet actor
takes; in one process `open` builds all three: [The composition](../../thread-effect/README.md#the-composition).

## The ports and what they are called with

| Port (package) | Called | Must |
|---|---|---|
| `Lease` (budget) | `reserve(estimate, request)` before every provider request, the reviewer's and the subagents' included; `settle(token, { usage, cost, outcome })` once per token | Fail `reserve` with `LeaseFenced` and the product's `reason` to stop the thread ([The lease](../../budget-effect/README.md#the-lease)). Expire reservations a crash left open ([Guarantees and their limits](../../budget-effect/README.md#guarantees-and-their-limits)) |
| `Estimator` (budget) | For each request, with the alias it asks for | `Estimator.fixed(micros)` or a rule of the product ([Prices and the estimate](../../budget-effect/README.md#prices-and-the-estimate)) |
| `Prices` (budget) | Before a request (the alias's row) and at settlement (the serving route's row) | Be `Prices.layer` of `priceRows(routes)`: a missing row refuses the request with `PriceMissing` |
| `RecordSink` (recorder) | `deliver(records)`: batches, in entry order per conversation, at least once | Store by `record.id`, keyed also by the storage ([The sink](../../recorder-effect/README.md#the-sink)) |
| `OutcomeSink` (this package) | `deliver(event)`: `Started`, then each outcome reached, at least once, in order per thread | Store by `event.id`. `OutcomeSink.none` for a product that asks instead |
| `Approvals.Inbox` (approvals) | `publish(request)` for every call parked for a person, at least once | Show it to a person, deduplicated by `request.id` |
| `PiTelemetry` (telemetry) | Pi's spans and metrics | `PiTelemetry.layer`, built over the product's tracer ([Exporting with OTLP](../../telemetry-effect/README.md#exporting-with-otlp)) |
| What the product's tools, rules and checks need | By their handlers | A `Review.Citations.Verifier` for a citation check, a `SearchProvider` for the search tools |

The README's port table is under [Install](../../thread-effect/README.md#install); what each part of the
composition requires and provides is under [The composition](../../thread-effect/README.md#the-composition).

## Calling a thread

The input is `Threads.Work`: `thread` (the product's key, also the idempotency key), `task`, `model` (with the
composition's router, an alias such as `{ provider: "router", modelId: "author" }`), `grant` (`tools`, exactly what
the thread may call, and `classification`), `cap` (micro units, a `bigint`), and optional `review` (default true),
`routing` (`regions`, `requires`), `instructions`, `maxTurns`.

| Operation | Returns |
|---|---|
| `admit(work, key?)`, `takeOn(thread, key?)`, `decide(thread, decision)` | Once the work is durably admitted. For a host that cannot hold a call open |
| `work(work)` | `admit`, then `ended`: the `Outcome`. Also how a process reattaches after a restart |
| `resume(thread)`, `release(thread, decision)` | `takeOn` or `decide`, then the outcome that follows |
| `cancel(thread)` | Aborts the run, a model request in flight included |
| `probe`, `outcome`, `ended`, `conversation` | Whether work is open; the outcome now; the outcome once there is one; the conversation |

`work` returns at a held answer and at a deferred review: it does not wait for a person's release or for a renewed
lease. It does wait while a tool call is parked for approval, since the run is not over. `decide` and `release`
take a person's `Accept` or `Correct` for a held answer of the review; a decision about a parked tool call is
`Approvals.decide`. Each operation: [The services](../../thread-effect/README.md#the-services).

**The outcome** is a `Schema` union read from storage, the same in any process that opens it:

| `_tag` | Means | The product then |
|---|---|---|
| `Reviewed` | The answer passed review (or a person accepted it) | Uses the answer: `verdict.answer` is its entry id, its text the `Message` record of that entry |
| `Answered` | The thread asked for no review | Uses the answer as unreviewed |
| `NotReviewed` | The run ended but no review stands (`reason`) | Decides what an unreviewed answer is worth |
| `Held` | Corrections ran out; a person must decide | Shows the verdict; calls `decide` or `release` with `Accept` or `Correct` |
| `ReviewDeferred` | The reviewer's request failed | Calls `resume` once the reviewer can be reached |
| `BudgetStopped` | The lease or the cap refused a request (`refusal`, maybe `review`) | For `LeaseFenced`, makes its lease accept again; for `ShareExhausted`, `admit`s the thread again with a larger `cap`; then `resume` |
| `Errored` | Pi ended the run (`reason`, `detail`; `turn_limit` for `maxTurns`) | Reads the reason; `resume` continues it |
| `Cancelled` | Aborted | Nothing |

Each carries `counts`: `turns`, `toolCalls`, `refusedToolCalls`, `settledMicros`. Treat only `Reviewed` as a
reviewed answer: Pi's `done` says the run ended, not that the answer stands.

## Outcomes are delivered

The process that works a thread tells the product. The product does not poll.

```ts
import { Effect, Layer } from "effect";
import { type OutcomeEvent, OutcomeSink, OutcomeSinkError } from "@effectified/pi-thread";

const Outcomes = Layer.succeed(OutcomeSink, {
	// One event. Success means it is stored; the same event may come again, so key it by `event.id`.
	deliver: (event: OutcomeEvent) =>
		store.put(event.id, event).pipe(Effect.mapError((cause) => OutcomeSinkError.make({ cause }))),
});
```

- `Started` once per submission, then `Reached` with each outcome. Ids: `<thread>:<submission>:started` and
  `<thread>:<submission>:<entry>:<state>`. A held answer later released gives `Held`, then `Reviewed`, on one
  submission.
- At least once, in order per thread, after the records: the recorder is flushed before each event, so a product
  reacting to `Reviewed` finds the transcript in its `RecordSink`. A failing record sink therefore holds outcomes back.
- A failing outcome sink never holds the thread up. It is retried on `config.outcomes.retry` (default: forever, from
  100 ms, doubling to 30 s) as a durable sleep, across closes and restarts.
- A call parked for approval is no outcome event: the `Approvals.Inbox` tells it.
- `outcome.counts` of a redelivered event are those of the first read.
- To act once on an outcome, make the product's change and its record of `event.id` one transaction, and react to
  the state, not to an event's arrival: a second hold after a correction is a `Held` with an id of its own.

What holds and what does not: [Outcomes are delivered](../../thread-effect/README.md#outcomes-are-delivered).

## Records

Every message, model call and tool call the harness committed, every verdict and release of the review, and the
reviewer's request as a `ModelCall` record with `derived` set, reach the `RecordSink`. Records carry content in clear:
sealing is the sink's. Ids are `<conversation>:<entry>:<message>:<part>`, unique per storage
([Records](../../recorder-effect/README.md#records),
[The reviewer's request](../../thread-effect/README.md#the-reviewers-request-as-a-model-call)).

## Money

- **Prices are written once**, in the route table, with a row per route and per alias from `priceRows`
  ([Prices for a budget](../../router-effect/README.md#prices-for-a-budget)).
- **One `Lease` serves the whole harness.** It is told `request.conversation` and `request.session` when known: a
  product with money per tenant maps the conversation to its tenant (`Threads.conversation(thread)` gives a thread's),
  or hosts one thread per actor and builds the lease there ([Host Threads in Rivet Actors](rivet.md)). Estimates are the product's: a
  response that costs more than its reservation is settled at its real cost.
- **A thread has a cap from its first request**, written in the commit that creates it. It bounds the thread's own
  conversation, the reviewer's requests included. Each subagent's cap (`config.subagents.caps`) and each fork's
  allowance come on top. A later `admit` of the same thread applies only `cap`, so it can raise it.
- **`settledMicros`** adds the thread's share, its subagents' shares and its swarms' forks. A crash between a
  settlement and the commit of a share's total leaves it short by that request; the lease has it.
- **An attempt another route takes over** is charged to the lease before that route is tried (the composition wires
  `Fallbacks.layer`). A lease that refuses it ends the request.
- **A stopped thread does not continue by itself**: see "Continue a stopped thread" in the recipes.

## Review

- On by default (`work.review`). `false` leaves the review extension out of the thread's conversation: `Answered`.
- A thread whose reviewer alias has a route of the author alias's family is not started: `admit` fails with
  `ReviewerSharesFamily`, naming the pairs. The review `Policy.families` needs a row for each alias and each route
  ([Policy](../../review-effect/README.md#policy)).
- Subagent children and swarm forks are never reviewed.
- A held or deferred thread keeps its conversation busy; new input queues behind it.

## Recipes

Step by step, in [recipes.md](thread-recipes.md):

- **Add a tool**: an extension in `config.extensions`, its services in the ports, its name in `grant.tools`, the
  guard's policy checked.
- **Add a tool that needs a person's approval**: `config.approvals`, the `Approvals.Inbox`, finding a request's
  thread, `Approvals.decide` on the same `live`, what `work` does meanwhile.
- **React to a thread's end, once**: the `OutcomeSink` in one transaction with `event.id`; where the answer's text is.
- **Continue a stopped thread**: `LeaseFenced` or `ShareExhausted`, then `resume` or `takeOn`; the total spent.
- **Give a thread subagents**, **run a swarm on a thread**, **replace a hand-written agent loop**.

## The order, and why it must not change

The composition fixes it; a product that builds the parts itself keeps it.

- **Extensions:** the guard (first, its `beforeTool` decides before anyone), the product's tools, `approvals` (after
  everything that blocks or rewrites a call), `review` (the only `onYield` hook: Pi takes the first answer),
  `subagent`, `swarm`, `thread`, and the recorder's advisory hook last. A product extension with an `onYield` hook
  takes answers away from the review; one that rewrites arguments after approvals runs a tool with arguments nobody
  approved.
- **Models, inside out:** the providers; the router on them, with the composition's `ConstraintSource`; the budget
  on the same plain `Models`; the harness on the budgeted one. So one harness request is one reservation, and no
  request reaches a provider unreserved.
- **Before the harness opens:** setup ports and shares; **on it:** shares attached, then the recorder, then
  `Threads`, `Swarms` and the outcome delivery.

The full order with every reason: [The order, and why](../../thread-effect/README.md#the-order-and-why).

## Idempotency

- `thread` is the idempotency key: a second `admit` or `work`, in any process and under any key, finds the thread,
  applies only `cap`, and admits nothing.
- Each submission has a request key: the one the product gives, or `<thread>#<n>`. A continuation under a key the
  thread holds continues nothing.
- `Swarms.run` is idempotent by `plan.id`; `cancel` by itself.
- What a product's tool does outside must survive a second run (`replay: "safe"`) or be marked `replay: "unsafe"`.

## What is stored

Seven documents beside the plugins' (`thread.work`, `thread.outcomes`, `thread.session`, `thread.routing`,
`thread.swarm`, `thread.spent`, `thread.copy`) and one task per submission, the courier `thread.outcomes`
([What is stored](../../thread-effect/README.md#what-is-stored)). Records and outcomes are working state; the
product's own store stays its record.

## Limits a product inherits

The ones that most often decide a design:

- A crash between `reserve` and `settle` leaves a reservation the lease must expire. A request a close cut off is
  sent and reserved again, under the same `requestKey`.
- A response Pi never committed is in no record.
- A held or deferred thread blocks its conversation, and nothing retries by itself.
- A message queued behind a review replaces its correction.
- The guard cannot stop a provider request; the router's ceilings do.
- The router keeps nothing across a restart.

All of them, with the package each belongs to:
[Limits the packages document](../../thread-effect/README.md#limits-the-packages-document-which-a-product-inherits).
What still does not fit a hand-written loop: [Gaps](../../thread-effect/README.md#gaps).
