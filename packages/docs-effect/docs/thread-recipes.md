# Thread Recipes

Changes a product makes to its composition, step by step. Each assumes the wiring of [Build an Agent Thread](threads.md#wiring-it): one
`live` Layer, built once per process.

## Add a tool

1. Write it with `Tool.make` ([Tool](../../durable-effect/README.md#tool); [Write Tools, Hooks, and Plugins](extending.md) has the
   rules: replay, keys, what the model reads).
2. Put it in an `Extension` in `config.extensions`. Provide what its handler needs in the ports `Layer`: a missing
   service is a compile error.
3. Name it in each thread's `grant.tools`. A conversation without a grant may call nothing, and a tool outside the
   grant is not offered to the model at all.
4. Check the guard's policy ([The policy](../../guard-effect/README.md#the-policy)): a name `policy.denied`
   matches fails the build of the composition (`DeniedTool`), and a `toolCeilings` entry blocks the tool for a
   thread classified above it.

## Add a tool that needs a person's approval

Do "Add a tool", then:

1. Name it in `config.approvals.tools`, or give `config.approvals.rule` (an Effect over the call; a service it
   needs is a port). Set `expiresAfter`.
2. Provide `Approvals.Inbox`. `publish` gets each request at least once, the same `id` every time: store it by `id`.
   A request has `id`, `conversation`, `task`, `callId`, `tool`, `arguments`, `digest`, `askedAt`, `expiresAt`
   ([The request](../../approvals-effect/README.md#the-request)).
3. Find the thread of a request: `request.conversation` is the id of the conversation of
   `Threads.conversation(thread)`. `Approvals.pending` lists every open request of the harness, the same after a
   restart.
4. Once the product has authenticated the person, decide through the same `live` the threads run on (a second build
   would open a second harness on the storage). From the approvals quick start:

```ts
// Later, once your host has authenticated the person who decides:
const delivery = yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada"));
```

5. `decide` answers `delivered`, `already_decided`, `superseded`, `gone` or `unknown`. Treat all but `delivered` as
   final ([The decision](../../approvals-effect/README.md#the-decision)). `Approvals.deny(request, by, note)`
   makes a denial; the model reads `note` in an error result.

Meanwhile `Threads.work` waits: the run is not over while a call is parked, and no outcome event is sent (the inbox
tells the product). The approved call runs once, with exactly the arguments of the request. A denial is not a guard
refusal and is not in `refusedToolCalls`. `Threads.decide` is another thing: it releases a held answer of the review.

The composition installs approvals after the guard and the product's tools, so nobody is asked about a call the guard
refuses. Limits: [Limits](../../approvals-effect/README.md#limits).

## React to a thread's end, once

1. Provide an `OutcomeSink` whose `deliver` makes the product's change and records `event.id` in one transaction of
   the product's store, and does nothing for an id it has seen.
2. React to the state (`event.outcome._tag`), not to an event's arrival: a held answer corrected and held again is a
   second `Held` under an id of its own.
3. `Reviewed` carries the `verdict`; `verdict.answer` is the entry id of the answer. Its text is the `Message` record
   `<conversation>:<entry>:0:message` in the `RecordSink`, which has it before the event comes.
4. Keep `live` open while threads run. An event the sink has not taken when the process closes is offered again when
   the storage opens next.

[Outcomes are delivered](../../thread-effect/README.md#outcomes-are-delivered),
[Verdicts](../../review-effect/README.md#verdicts).

## Continue a stopped thread

`BudgetStopped.refusal` says what refused:

- `LeaseFenced` (the product's lease, with its `reason`): make the lease accept again. Nothing in the packages
  renews it.
- `ShareExhausted` (the thread's cap): call `Threads.admit` again for the thread with a larger `cap`. A later
  `admit` applies only `cap`.

Then `Threads.resume(thread)` continues and gives the new outcome, or `Threads.takeOn(thread, key)` continues under a
request key and returns at once (`continued`, `retried` for a deferred review, `unchanged`). A continuation is told
to the sink as `Started` (attempt 1 and up), then what it reaches; a retried review adds no `Started`. What the thread spent is `counts.settledMicros` of a fresh
`Threads.outcome(thread)`: the event's counts are those of its first read.
[A fenced lease: stop and continue](../../budget-effect/README.md#a-fenced-lease-stop-and-continue).

## Give a thread subagents

Declare each with `Subagent.make` (`agent.model` and `agent.tools` are required), list them in
`config.subagents.subagents`, give each a cap in `config.subagents.caps` (a declaration without one starts no
child), and put the tool names in the thread's `grant.tools` (`Subagents.TOOLS.foreground` is `subagent`,
`background` is `subagent_start`, `status` is `subagent_status`). A child is granted at most its declared tools, with
its parent's classification and routing, and is not reviewed
([Declaring subagents](../../subagent-effect/README.md#declaring-subagents)).

## Run a swarm on a thread

Define it with `Swarm.make` and list it in `config.swarms`. Once the thread has worked (it is primed), call
`Swarms.run(swarm, plan)` with `plan.thread`, `plan.id` (the idempotency key), `jobs`, `cap`, `onFailure`, and
`plan.fork`, the allowance of every fork (`tools` at most, `cap` in micro units). A fork never gets a tool its thread
lacks. Read the result with `Swarms.result` and spend per job with `Swarms.spent`. `plan.pins` keeps a job's fork
after the swarm ends, for the product to go on with; `Swarms.destroyFork` releases it
([A swarm from start to result](../../swarm-effect/README.md#a-swarm-from-start-to-result),
[Definition and plan](../../swarm-effect/README.md#definition-and-plan)).

## Replace a hand-written agent loop

The mapping, row by row, with what differs:
[From the consumer's loop to the packages](../../thread-effect/README.md#from-the-consumers-loop-to-the-packages).
It names the files of the first consumer, which only that product has; the "Replaced by" and "What differs" columns
hold for any loop.
