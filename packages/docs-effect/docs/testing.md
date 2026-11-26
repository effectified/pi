# Test Without a Network

Every test here runs on scripted models: no network, no key, no cost. The same test file runs under Vitest on Node
and under `bun test`. What to reach for:

| Testing | Use |
|---|---|
| A model request, a provider, an `effect/ai` program | `ScriptedModels`, `ScriptedLanguageModel` of `@effectified/pi-ai/testing` ([Testing](../../ai-effect/README.md#testing)) |
| A tool, hook, gate, task or plugin on a harness | `TestHarness.layer` of `@effectified/pi-durable/testing` |
| A plugin that builds the registry or wraps the models (guard, budget, router) | `TestHarness.layerWith({ registry, models })` |
| A close and a reopen, or a crash | `TestHarness.sqlStorage` on a SQLite file |
| A Rivet actor | `@effectified/pi-durable-rivet/testing` with a local engine |
| Running the test's Effect | `runTest` (test clock) or `runLive` (real clock) of `@effectified/pi-ai/testing` |

## Running a test's Effect

- **`runTest(effect)`** runs an Effect in a scope that closes with the test, on `TestClock` and `TestConsole`, and
  returns a promise of its value that rejects with its failure: `it(name, () => runTest(effect))`. It imports no
  test runner, so it works on both lanes. Time
  stands still until the test moves it with `TestClock.adjust(duration)`: a sleep, a timeout, a parked call's
  deadline and a retry backoff that read `Clock` pass then, with no real waiting. A test that forgets to move the
  clock hangs until the runner's time limit. Wrap a part that must see real time in `TestClock.withLive`.
- **`runLive(effect)`** is the same scope on the real clock: for a test of real processes, files or an engine.
- **Why not `@effect/vitest`:** it needs Vitest 5, Pi pins Vitest 4, and it does not load under `bun test`.
- **No test waits on the real clock** for something it could be told. Start a forked fiber with
  `Effect.forkChild(effect, { startImmediately: true })`, or wait on a `Latch` or a `Deferred`; never a short sleep.
  Tests of real processes and engines run on the real clock and wait on what they observe.
- **`conditions()`** waits for a fake of your own without the clock: the fake calls `changed()` after each change of
  its state, and the test waits with `when(() => fake.calls.length === 2)`. It never reads the clock.

The harness's clock is Effect's `Clock`, read when `Harness.layer` is built, so `TestClock` drives Pi's sleeps and
deadlines too ([Time](../../durable-effect/README.md#time)).

## A harness on scripted models

From the README: the root conversation on the scripted model, with an extension and two scripted turns.

```ts
import { Effect } from "effect";
import { answer, ScriptedModels, TestHarness, toolCall } from "@effectified/pi-durable/testing";

const test = Effect.gen(function* () {
	const root = yield* TestHarness.root; // the root conversation, on the scripted model
	const settled = yield* root.prompt("What is record 42 called?");
	return { settled, requests: yield* ScriptedModels.use((models) => models.callCount) };
}).pipe(
	Effect.provide(
		TestHarness.layer({
			extensions: [App],
			responses: [toolCall("lookup", { id: "42" }), answer("It is called Answer.")],
		}),
	),
	Effect.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
);
```

- `TestHarness.layer({ extensions, responses, storage, harness, provider })` provides the harness, its registry,
  memory storage, `Models` and `ScriptedModels`. `TestHarness.root` is the root conversation on the scripted model;
  `TestHarness.agent` names that model, for `Harness.rootWith` or `createConversation`.
- Turns: `answer(text)`, `toolCall(name, args)`, and a function of the request (`FauxResponseFactory`) that answers
  by what it was asked. `held(turn)` holds a turn back: `requested` succeeds once the model was asked, `release` lets
  it answer, so a test acts while a run is busy.
- `ScriptedModels.use((models) => models.setResponses([...]))` queues more; `models.callCount` counts the requests
  that reached the provider. `@effectified/pi-durable/testing` re-exports `ScriptedModels` and pi-ai's `faux*`
  helpers, so one import serves a harness test.
- **A plugin that builds the registry or wraps the models** passes its Layers: `TestHarness.layerWith({ registry,
  models, responses, storage })`. `registry` is any Layer that provides `Registry` (a guard's); `models` any Layer
  that provides `Models` and requires the scripted one (a budget, a router). A Layer that needs the open harness
  goes over the result: `attach.pipe(Layer.provideMerge(TestHarness.layerWith(options)))`.
- **Two model families** (an author and a reviewer): register a second scripted provider with pi-ai's
  `fauxProvider({ provider, models })` and `models.setProvider(...)`, as the review quick start does
  ([Quick start](../../review-effect/README.md#quick-start)).

[Testing](../../durable-effect/README.md#testing),
[With a registry and models of your own](../../durable-effect/README.md#with-a-registry-and-models-of-your-own).

## Fakes of the product's ports

A port is a `Context.Service`: a test provides it with `Layer.succeed` over state in the test. The READMEs' examples
are the models: a queue for `Approvals.Inbox` ([Quick start](../../approvals-effect/README.md#quick-start)), a
`Map` keyed by `record.id` for `RecordSink` ([Quick start](../../recorder-effect/README.md#quick-start)), a wallet in
memory for `Lease` ([The lease](../../budget-effect/README.md#the-lease)), `Estimator.fixed(micros)`
([Prices and the estimate](../../budget-effect/README.md#prices-and-the-estimate)), and a store keyed by `event.id`
for `OutcomeSink` ([Outcomes are delivered](../../thread-effect/README.md#outcomes-are-delivered)).

- Make the fake's state outside every harness `Layer` (module level, or once per test), so that it outlives a close
  and a reopen, and an actor's wake.
- A fake that is told something at least once keys by the id it is given, as a real one must; assert that the
  stored set has no id with two contents, not that nothing came twice.
- A fake that fails once and then succeeds tests a retry. Drive the retry's schedule with `TestClock.adjust`.
- A fake reached from another process (a host process test) is a small HTTP service of the test.

## Restarts: close and reopen

Memory storage cannot be reopened. A restart test uses a SQLite file: each build of a harness `Layer` on it is a new
process on the same data. From the README ([A restart](../../durable-effect/README.md#a-restart)); a test of
extensions passes them too, `TestHarness.layer({ extensions, responses, storage })`:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"; // or "@effect/sql-sqlite-bun"

const storage = TestHarness.sqlStorage(SqliteClient.layer({ filename }));
const pending = held(answer("Never given."));
const first = TestHarness.layerWith({ storage, responses: [pending.response] });
const second = TestHarness.layerWith({ storage, responses: [answer("Done after the restart.")] });

const restart = Effect.gen(function* () {
	// The first process: its harness closes while the model still owes the answer.
	const id = yield* Effect.gen(function* () {
		const root = yield* TestHarness.root;
		const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "pending" });
		yield* pending.requested;
		return submission.id;
	}).pipe(Effect.provide(first));
	// The second process: opening the same file resumes the run, and its own model answers it.
	return yield* Effect.gen(function* () {
		const submission = Option.getOrThrow(yield* Harness.submission(id));
		const settled = yield* submission.wait;
		const root = yield* Harness.root;
		const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
		return { settled, kinds: entries.map((entry) => entry.kind) };
	}).pipe(Effect.provide(second));
});
```

- `SqliteClient` is `@effect/sql-sqlite-node` on Node and `@effect/sql-sqlite-bun` on Bun. Write the suite once, as
  a function that takes the client Layer, and register it from two files: `*.node.test.ts` with
  `describe.skipIf("Bun" in globalThis)`, and `*.bun.test.ts`, which the Vitest config excludes
  (`exclude: [...configDefaults.exclude, "test/**/*.bun.test.ts"]`), since importing `bun:sqlite` fails on Node.
- Use `runLive` around a restart test: the file, the two harnesses and their scopes are real. Make the file in a
  fresh temporary directory (`mkdtempSync(join(tmpdir(), "..."))` of `node:fs`, `node:os` and `node:path`, which Bun
  provides too) and remove it afterwards.
- **A close is not a crash.** Closing a harness's scope interrupts handlers and leaves what was not committed
  pending, and counts no restart. Pi counts a restart (toward `settings.restartLimit`) only for a task that was
  running when a process died. To test a crash, wait until the state to crash in is stored (for a parked call, its
  task reads `sleeping` in `Harness.getTask(taskId)` or `Harness.scanTasks({ status: "sleeping" })`), copy the
  database file with its `-wal` and `-shm` files while the first harness still runs, and open the copy in the
  second. The READMEs have no example of this.

### A hook or a tool that must be asked again

Pi asks a hook again after a crash or a close that came before its answer was committed, asks a parked call's
`beforeTool` again at every wake and after every reopen, and runs a `replay: "safe"` tool again after a close. So a
parked gate is asked once when it parks, once more at each open, and once more when its signal wakes it. A test:

1. Give the hook (or tool) a fake outside service, made outside the harness Layers, that records each ask
   (`api.taskId` and `call.id`, which `Harness.signal` needs) and keys each effect, and a `Deferred` or
   `conditions()` the test waits on.
2. First harness on the file: submit with a `requestId`, wait until the hook was asked (and, for a gate, until its
   task reads `sleeping`), then end the scope, or copy the file for a crash.
3. Second harness on the same file, with its own responses: wait until the hook was asked again, then, for a gate,
   deliver with `Harness.signal(taskId, signal, key, value)` (it answers `delivered`) and wait on the submission
   (`Harness.submission(id)`, then `wait`).
4. Assert the asks per open, that the tool ran once, that the outside effect happened once by its key, and that a
   memo with a candidate kept the first value. Register the suite on both drivers.

**Approvals across a restart** is the same test with `Approvals.extension` and a queue for the inbox, made outside
both Layers: the inbox is told the request again after the reopen, under the same `id`. Decide in the second harness
on that republished request; `Approvals.decide` then answers `delivered`.
What Pi promises: [Hook](../../durable-effect/README.md#hook), [The request](../../approvals-effect/README.md#the-request).

## Testing a thread composition

Build `Composition.open(config)` of `@effectified/pi-thread` with scripted providers in `config.models.providers`
(one per model family the route table names), `Storage.sql()` over a SQLite file, and the fakes above for every port.
Assert on `Threads.work`'s `Outcome`, the records in the fake `RecordSink`, the events in the fake `OutcomeSink`
(same ids across a restart) and the fake lease's reservations (each settled once). The composition's own kill and
resume cases are the reference for what to expect at each close point:
[Kill and resume](../../thread-effect/README.md#kill-and-resume).

## Engine tests of Rivet actors

`@effectified/pi-durable-rivet/testing` has no platform code: the engine comes from the `/node` or `/bun` entry.

```ts
import * as LocalEngine from "@effectified/pi-durable-rivet/node";
import * as Testing from "@effectified/pi-durable-rivet/testing";

const TestAgent = Testing.observed(Agent); // host this one instead of Agent

const hosted = yield* Testing.hosted(LocalEngine.serve, { actors: [TestAgent] }); // in the test's scope
const run = <A, E>(effect: Effect.Effect<A, E, Client.RivetClient>) =>
	Effect.runPromise(Effect.provideContext(effect, hosted.context));

yield* Testing.sleep(agent); // Rivet's forced sleep
yield* Testing.seen(agent, "sleep"); // waits without waking the actor
```

- `Testing.observed(definition)` records the lifecycle in the test's process; host it instead of the definition.
  `Testing.lifecycle`, `Testing.seen(handle, event, times)` (dies after 30 s), `Testing.schedules`,
  `Testing.scheduleWake` and `Testing.sleep` (Rivet's forced sleep) observe and drive it.
- Skip the suite when the engine binary is missing: `LocalEngine.available` is an Effect of a boolean
  (`Effect.runSync` it), then `describe.skipIf(!available)`.
- The actor's `layer` is built again at every wake: a fixed list of scripted responses starts over after a sleep.
  Script by the request instead (a function that answers by the context it is given, as the host's example does),
  and keep fakes and counters outside `layer`.
- A bare actor has only the actions you give it: add one that calls `Approvals.decide`, or the operation under test.
- Before forcing a sleep on a parked call, wait until the park is stored. For a park with a deadline (an approval
  has one, its expiry) the host then schedules a `pi.wake` at it, which `Testing.schedules(handle)` lists.
- Start one engine per test file (`Testing.hosted` in a scope made before the tests, closed after them, with a
  generous hook timeout) and run each test with `Effect.provideContext(effect, hosted.context)` on the real clock.
- Register the suite from `*.node.test.ts` with the `/node` entry, guarded by `!("Bun" in globalThis)` (the Node entry
  refuses to start an engine on Bun), and from `*.bun.test.ts` with the `/bun` entry.
- A test of a killed host runs the hosts as child processes on one local engine that outlives them
  (`Host.serve({ actors, endpoint })` in the child, a pool of their own), and kills them by pid. Expect the recovery
  wake about 15 seconds later: such a suite takes minutes, not seconds.

[Testing](../../durable-rivet-effect/README.md#testing). The thread actor's engine suite, as a list of what is
worth testing: [Tests](../../thread-effect/README.md#tests).

## Node and Bun

- Library code imports no `node:` or `bun:` module outside its platform files. Tests may use `node:fs`, `node:os`
  and `node:path`, which Bun provides; what needs one runtime only (`bun:sqlite`, `@effect/sql-sqlite-node`, the
  host's `/node` or `/bun` entry) goes in a file named for it (`*.node.test.ts`, `*.bun.test.ts`), skipped on the other.
- Test files import `describe`, `expect` and `it` from `vitest`; Bun's runner takes that import too.
- On Bun use the host's `/bun` entry and `@effect/sql-sqlite-bun`. The pi-effect repository runs its own suites with
  `bun test --conditions=source` to read workspace sources; a product on the built packages runs `bun test`.

## What no test here proves

- **A real provider.** Every suite runs on scripted models; the packages have not run against a real model
  provider. Provider errors, rate limits, usage reports and costs are what the scripts say. A product's first run
  against a provider is its own test.
- **A real Exa call**, several machines, an engine of several nodes, an engine that dies, a network that parts a host
  from the engine ([Not proven on a local engine](../../thread-effect/README.md#not-proven-on-a-local-engine)).
- **A crash in the narrow windows** the READMEs list: between a provider's answer and Pi's commit, between `reserve`
  and `settle`, between the end of a thread's work and the wake of its courier.
