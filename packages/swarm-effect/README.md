# @effectified/pi-swarm

A swarm of [Pi Durable](../durable) agents, in Effect 4.1, on [`@effectified/pi-durable`](../durable-effect).

One conversation reads an expensive context once (it is primed). A swarm then forks it once per job, never more than
a cap at a time; each fork does one small job and answers with a typed result; the results are fanned in, in job
order; and every fork nobody pinned is destroyed.

- **Keyed forks.** A fork is found again by its job key, so a retried job never makes a second copy.
- **A cap on live forks.** One more job starts whenever one settles.
- **A durable coordinator.** It is a Pi task. A crash or a close stops it, and the next harness on the same storage
  continues the same swarm: no second fork, no finished job run again, collected results kept.
- **Typed fan-in.** Each answer is decoded against an Effect `Schema`. A fork whose answer does not decode is told
  what was wrong and asked again, a bounded number of times.
- **A driver port.** Where forks live is a service. This package has two drivers: conversation forks inside one
  harness storage, and Rivet actor forks, each fork an actor of its own (`@effectified/pi-swarm/rivet`).
- **A setup port.** The product grants a fork its tools and caps its budget in the commit that creates the fork's
  conversation, and the swarm says which conversation, and which actor, each job ran in.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-swarm-0.1.0.tgz $R/effectified-pi-durable-0.1.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`).

## A swarm from start to result

It runs as it stands, because the model is scripted. Every example of this README is a test in
[`test/readme.test.ts`](test/readme.test.ts).

```ts
import { Effect, Layer, Schema } from "effect";
import { answer, type FauxResponseFactory, TestHarness } from "@effectified/pi-durable/testing";
import * as Swarm from "@effectified/pi-swarm";

// The work of one kind of swarm: what a job is given, what a fork must answer, and what a fork is asked.
const Covers = Swarm.make({
	name: "covers",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
});

// No provider and no key: a scripted model that answers each request by what it was asked.
const scripted: FauxResponseFactory = (context) => {
	const asked = context.messages.findLast((message) => message.role === "user")?.content;
	const topic = /cover (\w+)\?/.exec(String(asked))?.[1];
	return answer(topic === undefined ? "I have read it." : JSON.stringify({ topic, covered: topic !== "Zig" }));
};

const program = Effect.gen(function* () {
	// Prime: one conversation reads the expensive context, once.
	const root = yield* TestHarness.root;
	yield* root.prompt("Read this document: ...", { requestId: "prime" });
	// Fork per job under the cap, fan the typed results in, clean up.
	yield* Swarm.start(Covers, {
		id: "covers-1", // the idempotency key: starting it twice is one swarm
		source: root.id,
		jobs: [
			{ key: "rust", input: { topic: "Rust" } },
			{ key: "go", input: { topic: "Go" } },
			{ key: "zig", input: { topic: "Zig" } },
		],
		cap: 2,
		onFailure: "collect",
	});
	return yield* Swarm.result(Covers, "covers-1");
});

// The in-storage driver needs the open harness, and the registry needs the driver: `layer` first, `attach` last.
const live = Swarm.ConversationForks.attach.pipe(
	Layer.provideMerge(
		TestHarness.layer({
			extensions: [Swarm.extension([Covers])],
			responses: Array.from({ length: 10 }, () => scripted),
		}),
	),
	Layer.provideMerge(Swarm.ConversationForks.layer),
	// No guard and no budget here. The registry does not build until a fork setup is named: see "The fork setup port".
	Layer.provide(Swarm.ForkSetup.none),
);

Effect.runPromise(Effect.provide(program, live)).then((outcome) => console.log(outcome.jobs));
// [ { _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } },
//   { _tag: "Success", key: "go", value: { topic: "Go", covered: true } },
//   { _tag: "Success", key: "zig", value: { topic: "Zig", covered: false } } ]
```

With real providers and a storage that survives a restart, the same wiring from the parts:

```ts
const live = Swarm.ConversationForks.attach.pipe(
	Layer.provideMerge(Harness.layer()),
	Layer.provide(Registry.layer([Swarm.extension([Covers])])),
	Layer.provideMerge(Swarm.ConversationForks.layer),
	Layer.provide(Swarm.ForkSetup.none), // or the product's own setup
	Layer.provide(Storage.sql()), // over an Effect SQLite client
	Layer.provide(Models.layer([anthropicProvider()])),
);
```

`Swarm.extension` has no tool and no hook, so its place among the extensions of `Registry.layer([...])` does not
matter. It makes the registry require a `ForkDriver` and the product's `ForkSetup`.

## Definition and plan

A swarm has a part that is code and a part that is data.

- **The definition** (`Swarm.make`) is code: the job input `Schema`, the result `Schema`, the job prompt builder and
  the number of corrections. The coordinator must find it again after a restart, in a new process, so it is
  installed in the registry by its `name`, as a task's phases are.
- **The plan** (`Swarm.Plan`) is data: it is what `start` stores, encoded, as the coordinator's input.

| Plan field | |
|---|---|
| `id` | The swarm id. It is the caller's idempotency key: a swarm id names one swarm of a harness storage |
| `source` | The primed conversation. The coordinator is a background task of it |
| `at` | The newest entry of the source the forks see. Default: its newest entry at the moment it is idle |
| `jobs` | `{ key, input }` each. Keys are unique in the swarm; results come back in this order |
| `cap` | How many forks may work at once: an integer, 1 or more |
| `onFailure` | `fail`: the first failed job fails the swarm, open jobs are cancelled. `collect`: every job runs |
| `pins` | The keys of the jobs whose forks are kept when the swarm ends. Default: none |
| `agent` | An `Agent.Change` applied to every fork: a cheaper model, fewer tools |

```ts
// A cheaper model of the same `Models`, such as { provider: "anthropic", modelId: "claude-haiku-5-5" }.
yield* Swarm.start(Covers, {
	id: "covers-cheap",
	source: root.id,
	jobs: [{ key: "rust", input: { topic: "Rust" } }],
	cap: 1,
	onFailure: "fail",
	// Every fork answers with the other model and is offered no tool. The source keeps what it has.
	agent: { model: cheap, modelTools: [] },
});
```

Tools and extensions of `agent` are stored and handed to the driver by name, as Pi stores them: the facade's
`Agent.ByName`, which `named(change)` (`Agent.byName`) gives, for a host that sends a plan to another process before
it starts the swarm there. `start` checks it as Pi's `configure` would in every fork: a change it would refuse, such
as `maxTurns: 0`, is `InvalidPlan`, and nothing is stored.

## Host operations

Every one is an Effect on the harness of the source conversation.

| | |
|---|---|
| `start(swarm, plan)` | Stores the coordinator in one commit and succeeds once it is stored. Idempotent by `plan.id`: a second start creates nothing and answers the first one's task, `created: false`. `InvalidPlan` for a plan that cannot run, `SwarmIdTaken` for an id a swarm of another definition holds |
| `status(swarmId)` | The probe: whether the coordinator still runs, its phase (`idle`, `run`, `cleanup`, `ended`), and every planned job, in order, with its status and, once its fork accepted its first request, where it runs (`ran`). Committed reads only: it starts nothing, and works right after a reopen |
| `cancel(swarmId)` | Pi's abort of the coordinator. Succeeds once the abort is durably marked: `cancelling`, or `ended` for a swarm that had ended. Idempotent |
| `result(swarm, swarmId)` | Waits for the coordinator's end, then gives the swarm's result, typed |
| `destroyFork(swarmId, jobKey)` | Destroys one fork through the driver: what a janitor does with a pinned fork later. Idempotent; answers the bytes the fork wrote when the driver knows them |
| `events(swarmId)` | A `Stream` of job events for a host that shows progress |

An id nothing was started under fails each of them with `SwarmNotFound` (`events` has no element).

```ts
// A reconciliation job after a crash: is the coordinator there, and what did it plan?
const probe = yield* Swarm.status("covers-1");
const alive = probe.running;
const jobKeys = probe.jobs.map((job) => job.key);
const open = probe.jobs.filter((job) => job.status !== "succeeded" && job.status !== "failed");
```

```ts
// Cancel: nothing new starts, live forks are cancelled, unpinned forks are destroyed, collected results are kept.
yield* Swarm.cancel("covers-1"); // "cancelling"
const outcome = yield* Swarm.result(Covers, "covers-1");
// outcome.ending === "cancelled"; a job that had not settled is a Failure with reason "cancelled"
```

```ts
// A pinned fork is kept, as a conversation the product goes on with, until a janitor releases it.
const kept = yield* Swarm.ForkDriver.use((driver) => driver.list("covers-pinned"));
const released = yield* Swarm.destroyFork("covers-pinned", "rust"); // { bytesWritten: Option<number> }
```

```ts
// Progress: one element when a job's fork was asked for, one when it settled or failed.
yield* Stream.runForEach(Swarm.events("covers-1"), (event) => Effect.log(event._tag, event.key));
```

`events` is a watch of the statuses the coordinator stores, not a log. It starts with the events that lead to the
statuses of now, so a host that attaches late misses no job; Pi folds the commits a slow consumer misses, so two
events of a job may arrive together, always in their order. A job that failed before the host attached is one
`Failed`. The stream ends once every job has settled.

## The result

`result` gives an `Outcome<A>`: `ending` (`completed`, `failed`, `cancelled`), `jobs`, and `forks`.

- `jobs` has one element per job, in the order of the plan: `{ _tag: "Success", key, value }` with the typed value,
  or `{ _tag: "Failure", key, reason, message }`. A failed or cancelled swarm has a result too.
- `forks` says what became of every fork: `destroyed` with `bytesWritten` as its driver measured them, `pinned`, or
  `left` when the driver could not destroy it; and `ran`, where the fork's job ran.

**Where a job ran.** `ran` is `Option<{ conversationId, actorId }>`: the conversation the job ran in, by its id in
the harness storage the fork lives in, and the actor that holds that storage, null for a fork inside the storage of
the swarm itself. It is the coordinator's own durable state, written when the fork accepts the job's first request,
so `status` has it while the job runs and `result` afterwards. A host uses it to attribute a fork's spend and
records to its swarm: with the in-storage driver every record of that conversation is the job's; with the Rivet
driver every record of that actor's conversation is. None for a job whose fork never accepted a request, and for a
driver that does not say.

| Failure reason | |
|---|---|
| `unanswered` | The fork settled without an answer (aborted, a model error, a turn limit); the message is its reason |
| `invalid-result` | The fork's answers did not decode, corrections included; the message is the last issue report |
| `invalid-input` | The stored input does not decode against the definition's input schema |
| `driver-unavailable` | The driver said "retry later" 10 times in a row, not counting the times it said that the source is busy |
| `too-deep` | The source is a fork of forks as deep as the engine allows (16 on Rivet 3.1.1), so no job of it can have a fork |
| `gone` | The fork or the source is gone, the source has no entry to fork at, or the product's fork setup refused the fork (the message is its reason) |
| `cancelled` | The swarm was cancelled, or failed under `onFailure: "fail"`, before the job settled |

The result is the coordinator task's own result, so a host that has the task id reads it from the task as well:

```ts
const settled = yield* Harness.waitForTaskOf(Covers.task, started.taskId);
if (settled.state.outcome.status === "completed") {
	const outcome = yield* Swarm.typed(Covers.work, settled.state.outcome.result);
}
```

A swarm that completed ends its task `completed`; one that failed ends it `failed`, and a cancelled one `aborted`,
both with the result. `result` fails with `SwarmFaulted` when the task ended without one: Pi faulted it (a bug in a
phase, the restart limit), or it was copied with its storage (see [A copied storage](#a-copied-storage)).

### How a fork produces a typed result

A fork answers in text. The coordinator appends to the product's prompt: answer with one JSON value, and the JSON
Schema of `result`. It then looks for the JSON value in the answer (the whole text, else the last fenced block that
parses, else from the first brace or bracket to the last) and decodes it against `result`, through the schema's JSON
form. An answer that holds no JSON or does not decode is sent back to the same fork with Effect's report of every
issue, at most `corrections` times (default 2). Then the job fails as `invalid-result`.

```ts
const Strict = Swarm.make({
	name: "strict",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
	corrections: 0, // the first answer decides
});
```

This needs no tool and no other plugin, and only text crosses the driver port. It is not constrained decoding: a
model that never writes valid JSON fails its job.

## The coordinator

`Swarm.make` gives each definition one Pi task, `swarm.coordinator.<name>`. `start` creates it in the source
conversation as a background task. It has three phases.

1. **`idle`.** It waits for the source to be idle, then fixes the entry all forks are made at.
2. **`run`.** Fan-out and fan-in. One step reads the jobs that are due, starts jobs while fewer than the cap are
   live, and stores every job's status in one commit.
3. **`cleanup`.** It lists the swarm's forks through the driver, destroys those no pin keeps, and ends with the
   result.

**Idle** is Pi's: the conversation has no live task that is not background, counting the tasks of the conversations
those tasks own; a waiting or sleeping task is live. The coordinator is a background task, so it does not keep its
own source busy, and `Harness.waitForIdle` does not wait for a swarm: wait for `result`. A source that never gets
idle keeps the swarm in `idle`, with no fork made, for as long as it is busy: there is no deadline. `status` shows
it, and `cancel` ends it.

**A source that gets busy during the fan-out** is waited out in the same way, by a driver that forks only a source
with nothing in flight, as the Rivet driver does: its `fork` answers "retry later" marked `sourceBusy`, the job
keeps its place under the cap as `starting`, and the coordinator asks again at a doubling interval up to 30 seconds,
for as long as the source is busy. That answer is not counted towards the 10 after which a job fails as
`driver-unavailable`: a busy source never fails a job. `status` shows the job `starting` in the phase `run`, and
`cancel` ends the wait.

**It holds no process while it waits.**

- For a busy source it holds its process for a quarter of a second, then sleeps and looks again, at a doubling
  interval up to 30 seconds.
- For running jobs it sleeps on the signal their driver named. The in-storage driver names Pi's own
  `pi.submission-settled`, which Pi delivers in the commit that settles a fork's submission. Nothing is polled.
- For a driver that delivers no signal it sleeps until the next time to ask, at the driver's own interval.
- For a "retry later" it sleeps the time the driver said, else a delay that doubles from 200 ms up to 30 seconds.

**On reopen.** Pi keeps a sleeping task asleep and runs a phase that was cut off again from its top. Every driver
call of a phase is idempotent by a key the plan fixes (the job key for a fork, `<swarm id>/<job key>/<n>` for the
`n`th request of a job), so a phase that runs twice forks nothing twice and asks nothing twice. A fork whose
creating call was cut off before the coordinator stored it is found again by its key. What Pi itself repeats stays:
a model request that a close cut off is sent again on reopen, so a job that was live at the close is asked twice.

**Cancel** is Pi's abort of the task. Pi allows an abort handler no sleep, so in a cancel a driver that says "retry
later" is asked four times in a row, and a fork that still cannot be destroyed is `left` in the result, for
`destroyFork` later.

## The fork setup port

`Swarm.ForkSetup.ForkSetup` is what the product decides about every fork. It is **required**: `Registry.layer` with
the swarm extension has `ForkSetup` in its requirements, so a harness without one does not compile. The reason is
the subagent package's for its `ChildSetup`: the other plugins meet a conversation they were told nothing about in
different ways, a guard refusing its every call and a budget letting it spend without a cap and without an owner. An
optional port with a default that does nothing would make the second silent. A product that has neither plugin says
so with `Swarm.ForkSetup.none`.

| | Runs | A failure |
|---|---|---|
| `created(tx, fork)` | Inside the commit that creates the conversation the job runs in, after the swarm's agent change was applied | Fails the commit: the conversation does not exist, and the job fails as `gone` with `reason` |
| `beforeStart(fork)` | After that commit, before the fork is given a request of its job. It may run again: after a crash, and before each correction | The job fails as `gone` with `reason`, without a provider request; its fork is destroyed with the others |

`fork` is `{ swarmId, jobKey, sourceConversationId, conversationId }`, every id one of the harness storage the
setup runs in. Both fail with `ForkSetupFailed`, whose `reason` becomes the failed job's message.

Where it runs is the driver's:

- **In-storage.** In the harness of the swarm, inside the commit that forks the source conversation and claims the
  job key. `sourceConversationId` is the primed conversation.
- **Rivet.** Inside the fork actor, in the commit that creates the job's conversation there, so the actor's own
  `layer` provides the setup and it runs on the fork's harness, lease and all. `sourceConversationId` is the copy of
  the primed conversation, under the id it has in the source actor.
- **A driver of your own** gets the coordinator's setup in `ForkRequest.setup` and calls it when its fork is a
  conversation of the coordinator's harness. One whose forks are in no Pi harness cannot call it.

A product with the guard and the budget plugins, as product code: a fork inherits no grant, so `created` gives it
its allow-list; the budget plugin sets a cap in a commit of its own, so that goes into `beforeStart`.

```ts
import { Conversations, Guard } from "@effectified/pi-guard";
import { Shares } from "@effectified/pi-budget";

const refused = (fork: Swarm.ForkSetup.Forked) => (cause: unknown) =>
	new Swarm.ForkSetupFailed({ reason: `The job ${fork.jobKey} has no allowance.`, cause });

const Setup = Layer.effect(
	Swarm.ForkSetup.ForkSetup,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		const shares = yield* Shares;
		return {
			// Stored with the fork's conversation or not at all: no fork ever exists without its grant.
			created: (tx, fork) =>
				Conversations.grantIn(tx, fork.conversationId, { tools: ["lookup"] }).pipe(
					Effect.provideService(Guard.Guard, guard),
					Effect.mapError(refused(fork)),
				),
			// The cap is in place before the fork's first provider request. Setting it again is harmless.
			beforeStart: (fork) =>
				shares.setCap(fork.conversationId, 50_000n).pipe(Effect.asVoid, Effect.mapError(refused(fork))),
		};
	}),
);
```

This package imports neither plugin: its tests run a setup of the same shape that writes a document through the
creating commit. With a share of its own, a fork's spend is its conversation's, and `ran` says which swarm and job
that conversation belongs to.

## The driver port

`@effectified/pi-swarm/driver` holds the port alone: `ForkDriver`, its data and its two errors. It imports only
`effect` and the type `Agent.Change`. The data (`Fork`, `Notice`, `JobStatus`) are schemas, so a driver can send
them across a process boundary. Ids are plain numbers and strings.

```ts
interface ForkDriverService {
	readonly fork: (request: ForkRequest) => Effect.Effect<Fork, ForkRetryLater | ForkGone>;
	readonly run: (request: RunRequest) => Effect.Effect<Notice, ForkRetryLater | ForkGone>;
	readonly job: (fork: Fork, requestId: string) => Effect.Effect<JobStatus, ForkRetryLater | ForkGone>;
	readonly cancel: (fork: Fork) => Effect.Effect<void, ForkRetryLater>;
	readonly destroy: (fork: Fork) => Effect.Effect<Destroyed, ForkRetryLater>;
	readonly list: (swarmId: string) => Effect.Effect<ReadonlyArray<Fork>, ForkRetryLater>;
}

interface ForkRequest {
	readonly swarmId: string;
	readonly jobKey: string; // with swarmId, the key of the fork
	readonly coordinatorTaskId: number; // the coordinator's task, in the harness of the source
	readonly sourceConversationId: number; // the primed conversation, in that harness
	readonly at: number; // the newest entry of the source the fork may see
	readonly agent: Option.Option<Agent.Change>; // names only: plain JSON
	readonly setup: ForkSetupService; // the product's fork setup: a service, not data
}

interface RunRequest {
	readonly fork: Fork; // { swarmId, jobKey, forkId }
	readonly requestId: string; // unique in the fork
	readonly prompt: string;
	readonly notify: { readonly taskId: number; readonly key: string };
}

type Notice =
	| { _tag: "Signal"; signal: string; place?: Place }
	| { _tag: "Poll"; afterMillis: number; place?: Place };
interface Place {
	readonly conversationId: number; // in the harness storage the fork lives in
	readonly actorId: string | null; // the actor that holds that storage; null inside the swarm's own
}
type JobStatus =
	| { _tag: "Unknown" }
	| { _tag: "Running" }
	| { _tag: "Answered"; text: string }
	| { _tag: "Unanswered"; reason: string };
interface Destroyed {
	readonly bytesWritten: Option.Option<number>;
}
```

| Operation | Contract |
|---|---|
| `fork` | Find or create the fork of `(swarmId, jobKey)`: never a second copy. A creation that answers "duplicate key" is a success with the fork that holds the key. `ForkRetryLater` when the source cannot be forked now, with `sourceBusy: true` when that is because the source has work in flight; `ForkGone` with `what: "source"` when it never can, with `what: "depth"` when the source is as deep as forks go, with `what: "fork"` when the key's fork was destroyed or the product's setup refused it |
| `run` | Hand the fork its job and return once the fork has durably accepted it, never at the answer. Idempotent by `requestId`: a second call starts nothing and answers as the first. The answer says how the coordinator learns of the settlement (below), and may say where the job runs (`place`) |
| `job` | Where the request stands, and the final answer's text once it settled. It never waits. `Unknown` for a request the fork does not hold |
| `cancel` | Stop the fork's work and return once nothing of it runs; an unsettled job then reads `Unanswered`. A fork that is gone or idle is cancelled already |
| `destroy` | Destroy the fork for good: its work stopped, never listed, run or found by key again. A fork that is gone is destroyed: success, with the bytes when the driver still knows them |
| `list` | Every fork of the swarm that exists and is not destroyed, also one whose `fork` call never returned to the coordinator |

### What a driver must guarantee

- **Every operation is idempotent.** The coordinator calls from a phase Pi may run twice, with the same arguments.
- **Two failures only.** `ForkRetryLater` when the same call may work later, `ForkGone` when it never will. A
  driver maps everything else (a timeout, a lost connection) to one of the two; a defect faults the coordinator.
  `afterMillis` is honoured as given.
- **`sourceBusy` only for a busy source.** A `fork` that answers `ForkRetryLater` with `sourceBusy: true` says that
  the driver is well and the source has work in flight. The coordinator waits that out without an end and without
  counting it, so a driver must not mark a failure of its own that way.
- **The fork setup.** A driver whose fork is a conversation of the coordinator's harness calls
  `request.setup.created(tx, fork)` inside the commit that creates that conversation, and
  `request.setup.beforeStart(fork)` once it is stored and before the first request. One whose forks live in
  another harness calls the `ForkSetup` of that harness there. A refusal is `ForkGone` with `what: "fork"`.
- **`place`.** When `run` knows the conversation the job runs in, it says so; the coordinator keeps the first one a
  job's requests named.
- **`run` returns at acceptance.** After it returned, `job` never reads `Unknown` for that request: the coordinator
  fails a job that does.
- **`Notice`.** `{ _tag: "Signal", signal }` promises that a Pi signal of that name is delivered to the task
  `notify.taskId` under `notify.key` once the job settled, at least once, also across a crash of the driver's own
  host; the value does not matter. A host that has the coordinator's harness delivers it with
  `Harness.signal(taskId, yourSignal, key, value)`. A driver that cannot promise it answers
  `{ _tag: "Poll", afterMillis }`, and the coordinator asks `job` at that interval.
- **`list` is complete.** Clean-up destroys what it lists, which is how a fork is destroyed whose creation the
  coordinator never saw succeed.

### What the coordinator guarantees a driver

- At most `cap` jobs are accepted and unsettled at once.
- `at` is the same for every fork of a swarm.
- Request ids are `<swarm id>/<job key>/<n>`: `0` is the job, `1` and up are corrections, each sent to the same
  fork after its last answer was read.
- Notify keys are unique in the coordinator's task, one per request.
- A signal that arrives before its job settled is used up (Pi allows one wait per key): the coordinator then asks
  `job` once a second. A sleep that ends by its time uses up the keys it listed, so their jobs are asked the same way.
- After 10 "retry later" answers in a row a job fails as `driver-unavailable`, and a clean-up leaves what is pending.
  A `fork` answer marked `sourceBusy` is not one of the 10.
- `cancel` and `destroy` are also called from Pi's abort handler, in a row, without a durable sleep between.

### For a driver whose fork is a whole storage

An actor fork copies the storage of the primed actor as it is, with a harness of its own in another process.

- **Idle.** The coordinator is a live background task of the source's harness during every fork, and it runs while
  it asks for one. A host that forks "only an idle harness" must not count it. The Rivet host's rule: a fork is
  refused for an unsettled submission and for a live task that is not a background task of the product, so no input,
  model request or tool call is copied in flight, and the coordinator does not refuse its own fork. Answer
  `ForkRetryLater` with `sourceBusy: true` while the source is busy.
- **The setup.** The fork's conversation is created in the fork's own harness: run the product's `ForkSetup` of
  that harness in its creating commit, and say in `place` which conversation and which actor it is.
- **`at`.** The copy is the storage as it is now, which may be past `at`: continue the job from `at` in the fork,
  for example in a conversation fork at `at` inside the fork's harness.
- **The copy holds the coordinator.** See the next section: the fork's host runs `onStorageFork` first.
- **Signals.** `notify.taskId` is a task of the source's harness. The fork tells its source, and the source's host
  delivers the signal there.

### A copied storage

A copy of a harness storage holds a copy of every coordinator task. Left alone, the copy would run the swarm a
second time against the same driver, and its cancel would destroy the forks of the storage it was copied from.

```ts
// In the host of the copy, on a harness opened with `resume: false`, before anything else:
yield* Swarm.onStorageFork;
yield* Harness.resume;
```

`onStorageFork` marks the copy and aborts the coordinators it inherited. A marked coordinator ends `aborted` with
the reason `copied` and asks the driver nothing. A swarm started on the copy afterwards runs as usual.

## The in-storage driver

`Swarm.ConversationForks` forks the source conversation inside the harness the coordinator runs in.

- `ConversationForks.layer` provides the `ForkDriver`, before the harness is open: the registry needs the driver,
  and the harness needs the registry. `ConversationForks.attach` gives the driver the open harness. Until it ran,
  every operation of the driver waits.
- A fork is `conversation.fork({ at, ownership, agent, init })`. `init` claims the job key and runs the product's
  `ForkSetup.created` in the commit that creates the fork, so the key, the fork and what the product gave it exist
  together or not at all. The claim is one field of a session document per swarm, `swarm.forks`: the lookup by key,
  the list, and the mark of a destroyed fork. `beforeStart` runs before `fork` answers, also for a fork that was
  found, since a call that was cut off after its commit is made again.
- A job runs in the fork's conversation itself: `ran` is `{ conversationId, actorId: null }`.
- The coordinator's task owns its forks. Pi's abort of the task reaches their work, and work started later in a
  pinned fork is not counted by `Harness.waitForIdle` of the harness: wait on the fork itself.
- `run` is `submit` with the request id and Pi's `notify`; `job` reads the submission by its request id and the text
  of its answer entry; `cancel` is `Conversation.abort`.

**Destroy.** Pi Durable 1.6.0 cannot delete or retire a conversation: its transaction creates and forks
conversations and nothing else, and its storage contract has no write that removes a record. So `destroy` does what
there is: it aborts the fork's work, background work included, measures what the fork wrote, and marks the fork
destroyed in `swarm.forks` with that number, after which the driver never finds, runs or lists it again.

`bytesWritten` is what can be measured honestly: the size in bytes of the UTF-8 JSON of the entries the fork's
conversation appended after its fork point, each entry as Pi's record of it (id, kind, data, model messages), summed,
read after the abort and before the mark. A second `destroy` answers the stored number. What it is not:

- **Not the storage the fork took.** Documents, indexes, tasks, submissions and the storage's own framing are not
  counted, and an entry's stored form need not be its JSON.
- **Not freed.** The fork's entries stay in the storage. The gap that remains: storage of destroyed forks is not
  reclaimed until Pi can delete a conversation.
- **Not the Rivet driver's unit.** That one answers the growth of a database in whole pages (below).

None for a fork the swarm never had, and for one whose conversation the storage has lost.

## The Rivet driver

`@effectified/pi-swarm/rivet` makes each fork of a swarm a fork of the Rivet actor that holds the primed harness: a
copy-on-write copy of the actor's storage, with a harness of its own, in another actor. It is written on
[`@effectified/pi-durable-rivet`](../durable-rivet-effect), an optional peer dependency that only this subpath
imports.

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-swarm-0.1.0.tgz $R/effectified-pi-durable-rivet-0.1.0.tgz rivetkit
```

It runs as it stands, because the model is scripted; the same code is the test
[`test/rivet-readme.ts`](test/rivet-readme.ts).

```ts
import { Effect, Layer, Schedule, Schema } from "effect";
import { Registry } from "@effectified/pi-durable";
import { answer, type FauxResponseFactory, ScriptedModels, TestHarness } from "@effectified/pi-durable/testing";
import { Action, Actor, Client, Self } from "@effectified/pi-durable-rivet";
import * as LocalEngine from "@effectified/pi-durable-rivet/node"; // on Bun: "@effectified/pi-durable-rivet/bun"
import * as Swarm from "@effectified/pi-swarm";
import * as Rivet from "@effectified/pi-swarm/rivet";

// The work of one kind of swarm, and a scripted model, as in the quick start.
const Covers = Swarm.make({
	name: "covers",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
});
const scripted: FauxResponseFactory = (context) => {
	const asked = context.messages.findLast((message) => message.role === "user")?.content;
	const topic = /cover (\w+)\?/.exec(String(asked))?.[1];
	return answer(topic === undefined ? "I have read it." : JSON.stringify({ topic, covered: topic !== "Zig" }));
};

// What the actor's harness runs on. The registry needs the driver and the product's fork setup; the driver needs the
// engine's client, which the host makes from the actor's own context.
const layer = Layer.mergeAll(
	Registry.layer([Swarm.extension([Covers])]),
	Layer.effectDiscard(
		ScriptedModels.use((models) => models.setResponses(Array.from({ length: 20 }, () => scripted))),
	).pipe(Layer.provideMerge(ScriptedModels.layer())),
).pipe(
	Layer.provideMerge(Rivet.layer()),
	Layer.provide(Self.client),
	// No guard and no budget here. Every fork is an actor of this definition and runs the setup itself.
	Layer.provideMerge(Swarm.ForkSetup.none),
	Layer.orDie,
);

// One definition is the source of a swarm and each of its forks.
const Agent = Actor.make("agent", {
	layer,
	forkHygiene: [Rivet.forkHygiene],
	actions: {
		...Rivet.actions,
		// Primes the root conversation and starts a swarm on it. It answers once the swarm is stored.
		start: Action.make({
			input: Schema.Struct({ id: Schema.String, topics: Schema.Array(Schema.String) }),
			output: Schema.Null,
			handler: ({ id, topics }) =>
				Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt("Read this document: ...", { requestId: "prime" });
					const jobs = topics.map((topic) => ({ key: topic, input: { topic } }));
					yield* Swarm.start(Covers, { id, source: root.id, jobs, cap: 2, onFailure: "collect" });
					return null;
				}).pipe(Effect.orDie),
		}),
		// Whether the swarm still runs. Its coordinator sleeps between two questions to its forks.
		running: Action.make({
			input: Schema.String,
			output: Schema.Boolean,
			handler: (id) => Effect.orDie(Effect.map(Swarm.status(id), (status) => status.running)),
		}),
		// The topics the document covers, from the result of a swarm that has ended.
		covered: Action.make({
			input: Schema.String,
			output: Schema.Array(Schema.String),
			handler: (id) =>
				Effect.orDie(
					Effect.map(Swarm.result(Covers, id), (outcome) =>
						outcome.jobs.flatMap((job) => (job._tag === "Success" && job.value.covered ? [job.value.topic] : [])),
					),
				),
		}),
	},
});

const program = Effect.gen(function* () {
	const agent = yield* Client.getOrCreate(Agent, ["document-7"]);
	yield* Client.call(agent, "start", { id: "covers-1", topics: ["Rust", "Go", "Zig"] });
	// The swarm runs in the actor. An action does not wait for it: Rivet ends an action after its timeout.
	yield* Effect.repeat(Client.call(agent, "running", "covers-1"), {
		while: (running) => running,
		schedule: Schedule.spaced("200 millis"),
	});
	return yield* Client.call(agent, "covered", "covers-1");
});

// Locally: an engine of this process's own, on a free port, hosting the actor and its forks in this process.
const main = Effect.scoped(
	Effect.gen(function* () {
		const local = yield* LocalEngine.serve({ actors: [Agent] });
		return yield* Effect.provide(program, Client.layer({ endpoint: local.endpoint }));
	}),
);

Effect.runPromise(main).then(console.log); // [ "Rust", "Go" ]
```

### What a product puts into its actor

The same actor definition is the source of a swarm and each of its forks, so all four go into one `Actor.make`:

| Where | What | Why |
|---|---|---|
| `layer` | `Rivet.layer(options)`, under `Registry.layer([Swarm.extension([...])])` and over the host's `Self.client` | The registry's coordinators need the `ForkDriver`. The driver needs the host's `RivetClient`, `ActorInfo` and `ActorSql`. `Self.client` is Rivet's client of the engine the actor runs on, so no endpoint is passed in; `Client.layer({ endpoint })` works too |
| `layer` | The product's `ForkSetup` (or `Swarm.ForkSetup.none`), provided so that the actions see it (`Layer.provideMerge`) | The registry requires it, and a fork actor runs it for its own job conversation, in `swarmRun` |
| `actions` | `...Rivet.actions` | What the driver calls in a fork: `swarmRun`, `swarmJob`, `swarmCancel`. The product's own actions have other names |
| `forkHygiene` | `Rivet.forkHygiene`, anywhere in the list | Makes a copied storage harmless before the fork's first call (below) |

The host operations (`start`, `status`, `cancel`, `result`, `destroyFork`, `events`) are unchanged: a product calls
them in actions of its own, inside the source actor. `result` waits for the swarm's end, and Rivet ends an action
after the actor's `actionTimeout`: ask `status` until `running` is false, then read `result`.

| Export | |
|---|---|
| `layer(options?: { pollMillis?: number })` | `Layer<ForkDriver, never, Client.RivetClient \| ActorInfo \| ActorSql>` |
| `actions` | `{ swarmRun, swarmJob, swarmCancel }`, each an `Action` of the host; `Actions` is their type. `swarmRun` needs `ForkSetup` and answers `{ conversationId }`, the job conversation |
| `forkHygiene` | `Fork.Hygiene<never>`: it uses the actor's `ActorInfo` and `ActorSql`, which every hygiene step has |
| `jobConversation` | `Effect<Option<Conversation>, Doc.Failure, Harness>`: in a fork, the conversation its job ran in |
| `forkKey(sourceKey, swarmId, jobKey)` | `Array<string>`: the key of the actor that is a job's fork |
| `Assignment` | The `Schema` of a fork's input (`Fork.lineage`): `swarmId`, `jobKey`, `sourceConversationId`, `at`, `agent` |
| `JobRefused` | The error of `swarmRun`: `what` (`source` or `fork`) and `reason` |

### How the driver keeps the port's contract

- **`fork`.** The fork of a job is the actor under `forkKey(the source's key, swarm id, job key)`. Before the engine
  is asked, the intent is recorded in the source actor's own SQLite (`ActorSql`): the driver is built before
  the harness is open and needs none of its commits, and a row per job stays small however many jobs a swarm has.
  The record's tables are made by Effect's `Migrator`, with a table of its own (`swarm_rivet_migrations`), when the
  driver is built at each wake and before the fork hygiene claims the record; its rows are decoded with `SqlSchema`,
  so a row of another shape fails as a `SwarmRecordFailure` whose `cause` is the decode's error, and the hygiene's
  claim is one `withTransaction`, rolled back when it fails or is interrupted. Then
  `Client.fork`, which is idempotent by key: a key the source's fork holds is that fork. A recorded fork is answered
  from the record, without a request. `ForkRetryLater` with `sourceBusy` while the source has an input, a model
  request or a tool call in flight (the host's `NotIdle`), which the coordinator waits out for as long as it lasts;
  plain `ForkRetryLater` for an engine that cannot be reached; `ForkGone` for a destroyed fork, a key another actor
  holds, and a refusal the engine gave no retry hint for. The driver has no cast and no definition of its own: its
  handles are the host's `Self.handle(actions)`.
- **The context as of `at`.** An actor fork copies the storage as it is, which may be past `at`: the source may
  have gone on between the swarm's entry and the fork. So a job does not run in the copied source conversation: its
  first request makes the *job conversation*, a conversation fork of the copied source at `at`, with the swarm's
  `agent` change, inside the fork actor. Every fork of a swarm therefore starts from the same entry, the agent change
  touches only the job, and the copied source conversation stays as it was. The job conversation is claimed in the
  commit that creates it, so a retried request makes no second one. `swarmRun` answers once Pi admitted the request.
- **The fork setup runs in the fork actor.** The commit that creates the job conversation also runs the product's
  `ForkSetup.created`, of the fork actor's own `layer`, and `beforeStart` runs before each request is submitted. The
  `setup` of the fork request, which is the source actor's, is left. A refusal fails the job as `gone`.
- **`place`.** `run` answers the job conversation's id in the fork actor's storage, and the fork actor's id: the
  swarm's `ran` for the job.
- **`Notice` is always `Poll`.** The coordinator asks each fork every `pollMillis` (default 1000) and sleeps
  between two questions. Nothing calls back, so no callback can be lost and hang a swarm, and a fork needs neither
  the source's address nor a durable outbox. The source actor is not held awake: the coordinator's sleep is a
  durable sleep until a time, the Rivet host schedules one wake action at that time, and the actor may sleep and is
  woken by it. The cost is the interval: a job's settlement is seen up to `pollMillis` late, and the source is woken
  once per interval and running job. A signal back to the source would be prompt, but the port lets a driver answer
  `Signal` or `Poll`, not a signal with a deadline: see "Not in this package".
- **`destroy`** is `Client.destroy`. Rivet reports no bytes written per actor, so `bytesWritten` is the growth of
  the fork's database: the size of the fork's SQLite database when it was destroyed (page count times page size, as
  the host reads it) less the size of the source's database read just before the fork was first asked for. It is
  whole pages, never below zero, and it counts what the fork hygiene, the job conversation and the job wrote. It
  does not count pages SQLite reused, and it would count pages the source wrote between that reading and the
  engine's copy. None when either size is unknown: a fork that was gone already, or one this actor has no record of.
- **`list`** reads the record: every fork that was asked for and not destroyed. One whose fork call never returned
  has no actor id yet: it is looked up by its key, and listed when the engine has it and it is a fork of this actor.
- **A destroyed fork** stays in the record as destroyed, with its bytes: its key never gives a fork again.
- **Timeouts.** rivetkit waits without end for an engine it cannot reach, so every operation is bounded: after 30
  seconds it is "retry later".

### Fork hygiene

A fork copies the whole storage: the coordinator that asked for it, live, in the middle of its swarm, the driver's
record of the source's forks, and, in a fork of a fork, the source's job conversation. `Rivet.forkHygiene` runs in
the fork before its first call:

1. `Swarm.onStorageFork`: every copied coordinator ends `aborted` with the reason `copied` and asks the driver
   nothing. It neither runs the source's swarm again nor cancels it.
2. The driver's record is emptied and marked as this actor's own.
3. The copied job conversation is forgotten.

A fork without it would run its source's swarm a second time and destroy its source's forks. So a fork whose record
is not marked as its own refuses: its `swarmRun` fails the job as `gone`, and its driver gives its copied
coordinator no fork and lists nothing, each with a message that names the missing hygiene.

**A fork of a fork works.** A job's fork, pinned, is an actor like its source: a swarm started in it, on its job
conversation (`Rivet.jobConversation`) or any other, forks that actor again. The engine limits how deep forks go; a
refusal there fails the job as `gone`. A swarm id the source used cannot be used in a fork: the copy holds the
source's swarm under it, ended as copied, and `start` answers `created: false`.

**A pinned fork** is found by `forkKey`, or by the actor id in `Outcome.forks` and `ForkDriver.list`; its
`Fork.lineage` input is its `Assignment`. It is destroyed by `destroyFork` in the source.

### Limits

- The source must have nothing in flight when a fork is asked for. Input that arrives during fan-out makes the
  open jobs wait for as long as the source is busy, looked at again at a doubling interval up to 30 seconds: there
  is no deadline, as there is none for the idle wait before the first fork. The jobs read `starting`, and `cancel`
  ends the wait. (An earlier version counted the busy source among the driver's failures and failed a job as
  `driver-unavailable` after 10 refusals, about 80 seconds.)
- A fork the engine makes after the driver gave up on its call and after clean-up listed the forks is left: the same
  swarm id and job key find it, and nothing destroys it.
- The fork actions check nothing about their caller: whoever reaches the engine can call them.
- On the local engine, with scripted models and a poll every 100 milliseconds, 50 jobs on forks of a 30-turn
  conversation under a cap of 8 took 4.8 to 5.4 seconds on Node and 5.1 to 5.3 on Bun, and 6.1 to 6.7 seconds with
  the 30 priming turns, on both (six runs each). PRD section 8 asks for 5 seconds of a 50-fork swarm with scripted
  models, which the in-storage driver gives in process (0.1 to 0.4 seconds). On Rivet a fork costs about 40 ms to
  make, 80 for its first request (the actor starts, runs the hygiene, forks the conversation) and 30 to destroy, in
  sequence about 8 seconds for 50; one process hosts the source, the 50 forks and their harnesses, so eight at a
  time gain little. The engine's cost per fork is the limit, not the coordinator: a round of eight forks takes longer
  than the 100 milliseconds between two questions, so the coordinator never waits for the interval. With the default
  interval of one second it would, once per round (not measured). The test bounds the whole at 20 seconds, three
  times what was measured.

### What the engine suite covers

[`test/rivet-suite.ts`](test/rivet-suite.ts) runs on a real engine, on Node and on Bun: a swarm from start to typed
results in job order with every fork on the primed transcript; one swarm for two starts; a fork found again by its
key, also one whose fork call never returned, and never after its destroy; the cap; unpinned forks destroyed, a
pinned one kept and destroyed by `destroyFork`; `status` and `events`; a cancel in the middle; a source actor put to
sleep in the middle; a source that is busy when a fork is asked for; the fork setup inside each fork actor, and
where each job ran; a copied coordinator that does nothing; a fork of a fork; a source 16 forks deep, whose jobs fail as `too-deep`; a fork without hygiene; and the
50-fork swarm. It uses the host's `/testing` entry for the forced sleep and the lifecycle, and `Self.client` for the
engine. [`test/rivet-job.test.ts`](test/rivet-job.test.ts) shows, in process, that a job runs on the context as of
`at` when the copy is past it, and what a refusing setup leaves. Not tested: an engine that refuses a fork or cannot
be reached, a timeout, a source that is busy for longer than seconds on an engine (the coordinator's wait without an
end is tested in process), a hygiene that runs twice, and an agent change in a fork.

## Guarantees and their limits

| Guarantee | Limit |
|---|---|
| One swarm per swarm id | Per harness storage. A second `start` with another plan changes nothing and says `created: false` |
| One fork per job key, across retries, crashes and reopens | Holds for a driver that keeps the port's contract |
| No fork without the product's setup | `created` is in the commit that creates the fork's conversation. `beforeStart` runs at least once before the job's first request, and again after a crash and before a correction. A driver with no harness of the fork's cannot run it |
| A busy source never fails a job | For a driver that marks its answer `sourceBusy`. The swarm waits without a deadline: `cancel` ends it |
| Never more than `cap` jobs live | A job waiting to be retried counts as live, since its fork may exist |
| A finished job is not run again | Pi sends a model request that a close cut off again, so a job that was live at a close is asked twice |
| Results in job order, typed | A stored result is decoded with the definition of now: a changed result schema fails `result` with `InvalidValue` |
| Unpinned forks are destroyed after fan-in | A fork the driver cannot destroy after 10 attempts is `left`, and still listed. In-storage, destroyed means aborted and marked, not deleted |
| The coordinator survives a crash and a close | Pi ends a task that a crash cut off 5 times in a row without progress (`restartLimit`) as `faulted`; `result` then fails with `SwarmFaulted`, and the forks are still listed |
| Cancel cleans up | In one invocation, without durable retries: see [The coordinator](#the-coordinator) |

Not in this package: a deadline for a swarm or a job, a budget, and retries of a job whose fork answered. A job that
never settles keeps its swarm running until `cancel`. Nor a `Notice` that is a signal with a deadline: a driver that
could call back, but cannot promise it, must poll.

## What is stored

Everything but the Rivet driver's record is in the harness storage, under kinds prefixed `swarm.`, so a copy of the
storage carries it.

| Kind | What |
|---|---|
| task `swarm.coordinator.<name>` | The coordinator: the plan as its input, every job's state as its checkpoint (with where it ran), the result as its result |
| document `swarm.swarm`, per swarm id | The coordinator's task id, and what `destroyFork` released |
| document `swarm.jobs`, per swarm id | Every job's status and where it runs, for `status` and `events` |
| document `swarm.forks`, per swarm id | The in-storage driver's forks by job key |
| document `swarm.copy` | The mark `onStorageFork` writes |
| document `swarm.rivet.job` | In a fork actor: the job conversation |
| table `swarm_rivet_fork`, in the actor's SQLite | The Rivet driver's forks: per swarm id and job key the actor, the source's database size, and whether it was destroyed, with its bytes |
| table `swarm_rivet_owner`, in the actor's SQLite | The actor whose record `swarm_rivet_fork` is: what the Rivet fork hygiene writes |

## License

MIT
