# @effectified/pi-durable-rivet

A Pi Durable harness inside a [Rivet](https://rivet.dev) actor, driven from Effect code through
[`@effectified/pi-durable`](../durable-effect), for `effect` 4.1 and `rivetkit` 3.1:

- **One actor is one harness storage.** Pi's SQLite storage runs on the actor's own SQLite, beside the tables a
  product keeps there.
- **The harness lives as long as a wake of the actor.** It opens when the actor wakes and closes when it sleeps or
  is destroyed. Work a sleep or a crash cut off continues at the next wake.
- **Actions are Effects.** A product's actions run on the harness; input, output and failure cross the action
  boundary as data, encoded and decoded by Effect `Schema`s.
- **Wake-ups are actor schedules.** The actor stays awake while Pi has work that can run, sleeps when it has none,
  and a scheduled wake action brings it back for a sleeping task or a parked call at its time.
- **Forks start clean.** `Client.fork` copies an actor with nothing in flight into a new one that sees the transcript
  and continues alone. Before its first call the fork cancels every inherited schedule and runs the product's fork
  hygiene.

It is written on `rivetkit` itself, not on `@rivetkit/effect`: that package cannot register `onFork` or call `fork`.
No promise appears in this package's signatures; Rivet's promise-shaped hooks are inside.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.2.0
npm install --allow-remote=all $R/effectified-pi-durable-rivet-0.2.0.tgz $R/effectified-pi-durable-0.2.0.tgz $R/effectified-pi-ai-0.2.0.tgz effect rivetkit
```

`effect` (`~4.1.5`) and `rivetkit` (`~3.1.1`) are peer dependencies, so the application has one copy of each.

## Example

An actor with one action that prompts the root conversation, hosted on a local engine, called and forked. It runs as
it stands, because the model is scripted; the same code is the test [`test/readme.ts`](test/readme.ts).

```ts
import { Effect, Layer, Schema } from "effect";
import { Registry } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness } from "@effectified/pi-durable/testing";
import { Action, Actor, Client } from "@effectified/pi-durable-rivet";
import * as LocalEngine from "@effectified/pi-durable-rivet/node"; // on Bun: "@effectified/pi-durable-rivet/bun"

// What the harness runs on beside its storage: a registry and the models. Built at each wake of the actor.
const layer = Layer.merge(
	Registry.layer([]),
	// No provider and no key: the model says how many questions the conversation holds.
	Layer.effectDiscard(
		ScriptedModels.use((models) =>
			models.setResponses(
				Array.from({ length: 100 }, () => (context) => {
					const asked = context.messages.filter((message) => message.role === "user").length;
					return answer(`That was question ${asked}.`);
				}),
			),
		),
	).pipe(Layer.provideMerge(ScriptedModels.layer())),
).pipe(Layer.orDie);

const Agent = Actor.make("agent", {
	layer,
	actions: {
		// Prompts the root conversation and gives the model's answer.
		ask: Action.make({
			input: Schema.Struct({ text: Schema.String, requestId: Schema.String }),
			output: Schema.String,
			handler: ({ text, requestId }) =>
				Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt(text, { requestId });
					const last = (yield* root.context()).messages.at(-1);
					return last?.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "";
				}).pipe(Effect.orDie),
		}),
	},
});

const program = Effect.gen(function* () {
	// One actor is one harness storage, found by its key.
	const agent = yield* Client.getOrCreate(Agent, ["demo"]);
	const first = yield* Client.call(agent, "ask", { text: "Hello.", requestId: "hello" });
	// A fork is made of an idle harness: the new actor sees the transcript and continues alone.
	yield* Client.waitForIdle(agent);
	const fork = yield* Client.fork(agent, { key: ["demo", "what-if"], input: { reason: "what if" } });
	const second = yield* Client.call(fork, "ask", { text: "And then?", requestId: "then" });
	const again = yield* Client.call(agent, "ask", { text: "Still there?", requestId: "still" });
	const lineage = yield* Client.lineage(fork);
	yield* Client.destroy(fork);
	return { first, second, again, forkedFrom: lineage.chain.map((link) => link.key) };
});

// Locally: an engine of this process's own, on a free port, hosting the actor in this process.
const main = Effect.scoped(
	Effect.gen(function* () {
		const engine = yield* LocalEngine.serve({ actors: [Agent] });
		return yield* Effect.provide(program, Client.layer({ endpoint: engine.endpoint }));
	}),
);

Effect.runPromise(main).then(console.log);
// { first: "That was question 1.", second: "That was question 2.", again: "That was question 2.",
//   forkedFrom: [["demo"]] }
```

With a real provider, replace the scripted Layer by `Models.layer([anthropicProvider()])` from
`@effectified/pi-ai` and name one of its models in the root's agent. Against a Rivet deployment, the process that
hosts the actors runs `Host.serve({ actors: [Agent], endpoint })`, and callers use `Client.layer({ endpoint })`.

## The actor

`Actor.make(name, config)` gives a definition: `name`, the typed `actions`, and `rivet`, the rivetkit actor
definition.

| Option | |
|---|---|
| `layer` | What the harness runs on beside its storage: `Registry` (tools, hooks, tasks, plugin extensions), `Models`, and whatever their handlers and the actions need. It may require `ActorInfo`, `ActorSql`, `ActorDatabase` and `ActorEngine` |
| `services` | Optional. Services built on the open harness, such as a recorder's pump. It may require `Harness` and everything `layer` provides. Not built while fork hygiene runs |
| `harness` | Options of `Harness.layer`: `settings`, `telemetry`, `identity`, `env`, `conversationCreated`. Given as they are, or as an Effect that gives them (below). The host sets `hostWakes` and resumes at each wake |
| `prefix` | Namespaces Pi's tables, and this host's one table, in the actor database. Default `pi_` |
| `actions` | The product's actions, by name. `pi` and `destroy` are the host's own names |
| `forkHygiene` | Effects run inside a fork before its first call (below) |
| `options` | Rivet's actor options, passed on unchanged: `sleepTimeout` (30 s), `actionTimeout` (60 s), `sleepGracePeriod` |

At each wake of the actor, `layer`, Pi's storage, the harness and `services` are built in one scope, in that order,
and pending work resumes. When the actor sleeps or is destroyed, running action handlers are interrupted, the scope
is closed, harness included, then what is left of the database's operations is interrupted, and only then does
Rivet's hook return. A harness that cannot open leaves the actor up: every call answers with that defect and tries to
open again.

Inside the actor, four services describe it:

- `ActorInfo`: `actorId`, `name`, `key`, `namespace`, `forkChain` and `forkInput`.
- `ActorSql`: the actor's SQLite as an Effect `SqlClient`, on the queue Pi's storage uses. A product that keeps
  tables of its own uses this one, so its transactions queue with Pi's, and names them outside `prefix` (see
  [Storage](#storage)).
- `ActorDatabase`: the same database on the same queue as Chord's `SqliteDatabase`, whose methods return promises:
  the adapter Pi's storage runs on. Kept for Pi and for code written against it; new code uses `ActorSql`.
- `ActorEngine`: the actor's way to the engine it runs on, which `Self.client` builds a `RivetClient` from (see
  [Inside an actor](#inside-an-actor)).

### Harness options that need a service

A product's harness options can need a service that its `layer` provides: Pi's telemetry adapter is one. So
`harness` is also taken as an Effect on what `layer` provides (and on `ActorInfo`, `ActorSql`, `ActorDatabase`,
`ActorEngine`, `Registry` and `Models`). It runs at each wake, once `layer` is built, and its failure is a harness
that did not open, like a failing Layer. An Effect that needs a service nothing provides does not type check.

```ts
const Agent = Actor.make("agent", {
	layer, // provides Telemetry among the rest
	harness: Effect.map(Telemetry, (telemetry) => ({ telemetry: telemetry.adapter, settings })),
	actions,
});
```

## Actions

```ts
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const approve = Action.make({
	input: Schema.Struct({ id: Schema.String }),
	output: Schema.Struct({ at: Schema.Date }),
	error: Refused,
	handler: ({ id }) => Approvals.use((approvals) => approvals.approve(id)), // Effect<{ at }, Refused, Approvals>
});
```

`input`, `output` and `error` cross the boundary as JSON, so they need no service to encode or decode. Without
`error` the handler cannot fail. A handler runs with the harness, the registry, the models, `ActorInfo`,
`ActorSql`, `ActorDatabase` and what `layer` and `services` provide; an action that needs anything else does not
type check.

An action answers data, whatever happens: its value, its own failure, or a defect with its message. The message of a
defect crosses to the caller and is never logged by this package.

Rivet ends an action after the actor's `actionTimeout`, 60 seconds unless `options` sets it. An action that starts
long work submits it (`conversation.submit`) and returns; the caller waits with `Client.waitForIdle`.

## Inside an actor

Actor code works with actors too: a swarm forks the actor it runs in, a task calls a sibling. Two things are in its
way: its own `Actor.Definition` is not a value inside the actor (the definition is made of the code that runs
there), and it has no endpoint to build a client from. `Self` gives both.

```ts
import { Client, Self } from "@effectified/pi-durable-rivet";

const layer = Layer.mergeAll(registry, models, Self.client); // RivetClient, from the actor's own context

const forkMyself = Effect.gen(function* () {
	const me = yield* Self.handle({}); // this actor
	const copy = yield* Client.fork(me, { key: [...me.key, "what-if"] });
	const sibling = yield* Self.find({ ask }, ["other"]); // an actor of this definition, typed by `ask`
});
```

| | |
|---|---|
| `Self.client` | `Layer<RivetClient, never, ActorEngine>`: Rivet's own client of the engine the actor runs on. rivetkit makes it from the registry that hosts the actor (the `c.client()` of its actor context), with its endpoint, namespace and token. Put it into `layer`; no endpoint is passed in |
| `Self.definition(actions)` | `Effect<Client.Target<string, A>, never, ActorInfo>`: the actor's registered name with `actions`, which is all `Client` needs of a definition |
| `Self.handle(actions)` | `Effect<Client.Handle<...>, never, ActorInfo>`: the actor this Effect runs in |
| `Self.find(actions, key)`, `Self.getOrCreate(actions, key)` | `Client.find` and `Client.getOrCreate` for an actor of the same definition |

`actions` is the part of the actor's actions the caller wants typed: the ones a plugin exports, the product's own,
or `{}` for a handle that is only forked, asked for its status or destroyed. `Client`'s functions take a
`Client.Target` (a name and actions), of which `Actor.Definition` is one.

## The caller

`Client.layer(options)` provides `RivetClient`; `options` are rivetkit's `createClient` options (`endpoint`,
`token`, `namespace`). A `Handle` names one actor by its id: a call reaches that actor or fails with `ActorGone`, and
never creates a new one under the same key.

| | |
|---|---|
| `Client.getOrCreate(definition, key)` | The actor under the key, created empty when there is none |
| `Client.find(definition, key)` | The actor under the key, as an `Option`; creates nothing |
| `Client.call(handle, action, input)` | One action, typed by its schemas |
| `Client.status(handle)`, `isIdle(handle)` | Live tasks, how many of them are background tasks of the product, and unsettled submissions; idle is no task and no submission |
| `Client.waitForIdle(handle, { schedule })` | Succeeds once the harness is idle |
| `Client.fork(source, { key, input, retry })` | A new actor on a copy of the source's storage |
| `Client.lineage(handle)` | The forks behind the actor, and the input its own fork was made with |
| `Client.destroy(handle)` | Destroys the actor: `{ existed, databaseBytes }` |

**Idle** means no live task and no unsettled submission. A parked call and a sleeping task are live work, so a
harness that waits for an approval is not idle, and is not forked. A fork asks for less than idle: see
[Forks](#forks).

**Waiting.** Rivet has no wait inside an actor that does not hold it awake, so `waitForIdle` asks, and asks again on
`schedule` (from 100 ms, doubling, up to 5 s, without end). While Pi has nothing that can run and its earliest sleep
is ahead, the next question waits for that time, so the questions do not keep a parked actor awake. A schedule that
ends fails the wait with `NotIdle`.

**Errors.** A closed union of tagged errors:

| | |
|---|---|
| `ActionFailed` | The action failed with its own error: `error`, decoded with its schema and typed by `call` |
| `ActorDefect` | The call failed inside the actor otherwise: a defect of the handler, a harness that did not open, a value its schema rejects, Rivet's action timeout. `message` says which |
| `ActorGone` | The actor does not exist or was destroyed |
| `NotIdle` | A fork of a harness with work in flight, or a wait that gave up: `tasks` (every live task), `submissions` |
| `ForkTooDeep` | The actor can never be forked: as many forks lie behind it as the engine allows, 16 in rivetkit 3.1.1. `reason` is the engine's own sentence |
| `ForkKeyHeld` | The key asked for a fork is held by an actor that is not a fork of the source |
| `EngineUnavailable` | The engine could not be reached or refused: `code` (Rivet's `group.code`, or `transport`, `start`, `port`, `environment`), `retryable`, `retryAfterMillis` |

**Interruption.** Interrupting a caller aborts its request. It cannot stop an action Rivet already delivered: the
handler runs to its end inside the actor, and so does the Pi work it started. Stop that with an action of your own
that calls `Conversation.abort`. A fork the engine accepted is made; the same key finds it.

**An engine that cannot be reached.** rivetkit's client looks the engine up before its first request and tries
again without end, so a call waits and does not fail: bound it with `Effect.timeout`. With
`disableMetadataLookup: true` a request fails at once with a retryable `EngineUnavailable`.

**A refusal with a retry hint.** Rivet's storage refuses a request while an actor's volume changes hands, in a fork
or around a sleep: `depot.overloaded` with the reason `volume_transition` and `retry_after_ms: 100` ("The storage
host refused the command (volume_transition); retry after 100 ms."). It was caught on a local engine as the answer
to a fork, about once in a hundred forks under load. Such a refusal says that the request was not served, so every
request of this module is sent again after the hinted time, at most five more times; then the refusal goes to the
caller as `EngineUnavailable` with `retryAfterMillis`. That covers `getOrCreate`, `find`, `fork` and every action
call, `status`, `lineage` and `destroy` included. One refusal is not sent again: a hinted refusal of the actor's own
(`actor.*`) to an action call, which may come after the handler began.

## Wake-ups

The harness runs with Pi's `hostWakes`: Pi arms no timer for sleeping tasks and tells the host when it next needs a
running process (`Harness.wakes`). The host follows it:

- **Pi is active** (a task can run or runs): the actor is held awake with Rivet's `keepAwake`, so it does not sleep
  under a running model request, and a recovery wake is kept at most 15 seconds ahead. Holding the actor awake lasts
  only as long as its process: the recovery wake is what resumes a run after a crash.
- **Only sleeps are left** (a parked call, `Task.sleepUntil`): one wake action is scheduled at the earliest one, and
  the actor may sleep once it is written. At that time Rivet wakes the actor, the harness opens and resumes.
- **Nothing is left**: no wake is kept, and the actor sleeps after its `sleepTimeout`.

One wake action is scheduled at a time. A replacement is written before the old one is cancelled, so for that
moment there are two and work is never without one. Before each action runs, a recovery wake is made sure of, so a
crash right after a call that started work cannot strand it. A wake that fires early, late, twice, or in a fork is
harmless: it resumes, which is idempotent, and the keeper schedules again from what Pi says.

A wake whose time has come is acted on by whoever sees it first: Rivet running its action, or the next call to the
actor, which resumes the due work before it does anything else. Rivet runs an action some time after its time: on
a local engine beside other engines, a call 19 to 234 milliseconds after a wake's time came before its action,
seven times in a row. Until 2026-11-25 such a call found the wake past, replaced it by the recovery wake and
cancelled it before it ran, so a thread taken up after its host was killed, and asked every 250 milliseconds where
it stood, never resumed. `test/wake-keeper.test.ts`, "resumes work whose wake is past at the next call", holds it.

Wake times come from Pi's clock, which is Effect's `Clock` inside the actor (see `@effectified/pi-durable`).

## Forks

```ts
const fork = yield* Client.fork(source, { key: ["job", "7"], input: { job: 7 } });
```

- **Only with nothing in flight.** `fork` asks the source first and fails with `NotIdle` while the harness has an
  unsettled submission, or a live task that is not a background task of the product. So no input, no model request
  and no tool call is ever copied in flight: Pi's generations and tool calls are never background, and Pi's own
  background task, an automatic compaction, is counted as work in flight because it holds a model request.
- **A background task of the product does not refuse a fork.** A conversation-owned task created with `background`,
  such as a swarm's coordinator, may be live, running or asleep: `Status.background` counts these. That is what lets
  a task fork the actor it runs in. The copy holds the task live, at the state it last stored, and a phase that was
  running starts again from its top in the fork: the product's fork hygiene must end it or make it the fork's own
  before the first call (below). A child task of a background task, and work in a conversation it owns, are not
  background and refuse the fork.
- **Sixteen deep.** A fork may be forked, and its fork again: the engine of rivetkit 3.1.1 makes 16 forks in a line
  (each in about 45 milliseconds on a local engine) and refuses the next at once with `actor.fork_too_deep` ("The
  actor's database is already 16 forks deep.", `max_depth: 16`). `Client.fork` then fails with `ForkTooDeep`, no actor
  is made, and the deepest one works on. The depth is that of the copy: how often one actor is forked is another
  matter.
- **Two requests.** The question and the fork are not one step: nothing must start work in the source between them,
  or the copy inherits it and both actors run it.
- **Idempotent by key.** A key that already names a fork of this source gives that fork, whatever the source does
  now, so a retried job never makes a second copy. A key another actor holds fails with `ForkKeyHeld`.
- **Retried.** rivetkit sends a fork the engine refused before doing anything (`actor.fork_unavailable`) again, five
  times; `retry` adds a schedule on top (five more, from 200 ms, doubling). A fork the storage refused with a retry
  hint (`depot.overloaded`, while the source's volume changes hands) is sent again as every request is: see
  [The caller](#the-caller).

Inside the new actor, Rivet runs `onFork` before `onWake` and before any call. This host does, in order:

1. Cancels every schedule the copy inherited, one-shot and recurring.
2. Stops if the record of step 4 exists for this fork.
3. Opens the harness on the copied storage **without resuming it** (no task runs, nothing is scheduled), with the
   product's `layer` and without `services`, runs each `forkHygiene` Effect in order, and closes the harness.
4. Records in the table `<prefix>rivet_fork` that hygiene ran, for which fork (source actor and fork time), with the
   fork's `input`.

On native SQLite, Rivet commits everything `onFork` wrote with its own record that the fork ran, so a crash in the
middle leaves nothing and the next start runs it all again. On remote SQLite (wasm runtimes) the writes land at once
and a crash repeats the steps on top of them: each hygiene Effect must be idempotent. A hygiene Effect that fails
fails the actor's start, and Rivet runs `onFork` again at the next one. So does an abort of the actor (Rivet's
`abortSignal`), which interrupts the steps and the database operations they started.

A fork's lineage is `Fork.lineage` inside the actor and `Client.lineage(handle)` outside: the chain of sources,
oldest first, and the `input` of its own fork.

### Fork hygiene for a product that uses plugins

A host may not import a plugin, so what the plugins need done to a copied storage reaches the host as data:

```ts
import { onStorageFork } from "@effectified/pi-recorder";

const Agent = Actor.make("agent", {
	layer, // registry, models, the plugins' ports
	services: recorderPump, // built after hygiene, never during it
	forkHygiene: [onStorageFork, dropBudgetShares],
	actions,
});
```

| Plugin | What the copy holds | Hygiene |
|---|---|---|
| recorder | Every conversation's `recorder.cursor`, and with it entries the source has not delivered yet | `onStorageFork`: moves every cursor to the copied head, so the fork delivers only what it commits itself. Do not drop the cursors. The pump belongs in `services` |
| budget | The `budget.share` documents of capped conversations | `onStorageFork(copyName)` of `@effectified/pi-budget`, with the fork's actor id as the name: what each share had settled becomes `inherited`, so a cap still counts it and a sum over storages does not count it twice. The lease is a port of the product: give the fork its own in `layer`, from `ActorInfo` |
| approvals | Nothing pending: a parked call is live work, and a busy harness is not forked | None |
| guard | The grants of its conversations, copied as they are | None; narrow a grant in an Effect of the product if the fork must hold less |
| subagent | `subagent.child` documents, with the conversations they name, and every run task that was live | `onStorageFork` of `@effectified/pi-subagent`: ends every run the copy inherited live, with the reason `copied`, so no child works in both actors |
| swarm | Every coordinator task, one of them live when a swarm forked the actor; the Rivet driver's record of forks | `forkHygiene` of `@effectified/pi-swarm/rivet`: ends the copied coordinators and empties the record. Required in every actor that runs swarms on Rivet |

What a fork inherits and nothing drops: the whole Pi storage (every conversation, entry, document, usage ledger and
settled task record), the product's own tables in the actor database, and the rows of `<prefix>rivet_fork` of the
forks before it. What it does not inherit: schedules, and anything in the source's memory.

## Storage

Inside an actor its SQLite is `ActorSql`, an Effect `SqlClient` of the SQLite dialect. A product or a plugin keeps
its own tables there, outside `prefix`:

```ts
import { ActorSql } from "@effectified/pi-durable-rivet";
import { Effect, Schema } from "effect";
import * as SqlSchema from "effect/sql/SqlSchema";

const Note = Schema.Struct({ id: Schema.Number, text: Schema.String });

const notes = Effect.gen(function* () {
	const sql = yield* ActorSql;
	yield* sql`CREATE TABLE IF NOT EXISTS product_notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)`;
	yield* sql.withTransaction(sql`INSERT INTO product_notes ${sql.insert({ id: 1, text: "kept" })}`);
	return yield* SqlSchema.findAll({ Request: Schema.Void, Result: Note, execute: () => sql`SELECT * FROM product_notes` })(
		undefined,
	);
});
```

Effect's `Migrator` runs on it with the client provided as `SqlClient` (`Effect.provideService(SqlClient.SqlClient,
sql)`), with a migration table named for the product: `@effectified/pi-swarm/rivet` keeps its record that way.

Pi's storage (`storage({ prefix })`, a `HarnessStorage` Layer) runs on `ActorDatabase`, the adapter below, on the
same queue. It also passes Pi's storage conformance suite through `Storage.sql` of `@effectified/pi-durable` over
`ActorSql`, on a real actor database; but the 50-fork swarm of `packages/thread-effect` took 12% longer that way
(7.2 s against 6.4 s for the swarm, the means of four interleaved runs each, slower in three of the four), so the
host keeps Pi on the adapter.

What rivetkit 3.1.1 gives on native SQLite, checked on a real actor (`effect/spikes/02-actor-sql.ts` of the
repository, on Node and on Bun, and this package's engine suite):

- **Rivet's transaction** (`transaction(callback)`) is isolated: a statement outside it neither joins it nor sees what
  it has not committed, and one issued after it began waits until it has ended. It commits when its callback
  resolves, rolls back and rejects with the callback's own error, and fails a handle used afterwards. It expires
  after 60 seconds and is rolled back, a backstop against a deadlock. A `SAVEPOINT` inside it works; a `BEGIN` does
  not.
- **`BEGIN` through a statement** works too, with `SAVEPOINT`, `RELEASE`, `ROLLBACK` and `COMMIT`, and such a
  transaction holds across awaits and across the actor's actions: every statement of every action joins it. While it
  is open rivetkit holds back `transaction()` and its own state writes (up to 60 seconds, then fails them), and a stop
  waits out its grace period before it rolls the transaction back.
- **A transaction run as a promise is not interrupted with its fiber**: its callback runs to its end and commits.

So `ActorSql`'s transactions are Rivet's own, driven by Effect's transaction rules, as `@effect/sql-sqlite-do` drives
the storage transaction of Durable Objects: `withTransaction` holds Rivet's callback open until its Effect has ended,
commits when the Effect succeeds, and rolls back when it fails or is interrupted. A nested `withTransaction` is a
savepoint. A transaction interrupted before Rivet called its callback rolls back as soon as Rivet calls it, and
keeps its turn of the queue until then. `SqlClient.BeginTransaction` is ignored: no statement begins Rivet's
transaction.

**One queue.** `ActorDatabase`, Chord's `SqliteDatabase` whose methods return promises, is the same database on the
same queue: the host builds both with one `Semaphore` at each wake, so a statement or a transaction of either waits
for those asked for before it, and nothing comes between the statements of a transaction. It is kept for Pi's
storage and for code written against Chord's interface; new code uses `ActorSql`.
`SqliteDatabase.make(raw, run?, queue?)` builds the adapter over the raw database of `rivetkit/db`: its operations
are started by `run`, the run function of a `FiberSet` (`FiberSet.makeRuntimePromise`), or by default
`Effect.runPromise`, and they wait on `queue`, by default a queue of its own.

**The wake's fibers.** Every request of either to Rivet is a fiber of the wake's `Work`: on the wake's clock, and
what is left of them once the harness has closed is interrupted with the wake. An interrupted request ends at once
while it waits for its turn or for a hint; one that Rivet is running is waited for first, and may have been applied.
Two gaps: Rivet hides a failed rollback; and a BLOB column reads back as an array of numbers (Pi's storage stores
none). Rows are objects with the columns in order, so `values` gives one value for two columns of one name.

**A statement the storage refuses with a retry hint.** rivetkit turns a refusal of its storage into an error with
`retry_after_ms` in its metadata ("SQLite storage refused the request before running it"). Nothing of a refused
request was applied, so it is asked again after the hinted time, at most five more times, where a second run is
safe, and holds its turn of the queue meanwhile:

| Refused | Asked again |
|---|---|
| A statement outside a transaction (`ActorSql`; `exec`, `run`, `get`, `all` of `ActorDatabase`) | Yes |
| `runCounted` of `ActorDatabase` on the database | Yes, as a whole: its transaction is the adapter's own, and Rivet rolled it back |
| A transaction, before Rivet called its callback | Yes: nothing of it ran |
| A statement inside a transaction, or a commit | No. The transaction's body is the caller's code, and nothing says it may run twice: the transaction is rolled back, and the refusal reaches the caller. With `ActorSql` every later statement of that transaction fails with the same refusal, and it is rolled back even if its Effect goes on and succeeds: SQLite does not say whether an error of its storage rolled the transaction back already |

So a refusal in the middle of one of Pi's commits still fails that commit, and with it the harness until the actor
sleeps and wakes (`SessionFailed`, below). None was observed inside an actor: the one refusal that was caught came
to a client's fork, and the spike met none in about 2,000 rounds of writes of every kind (a statement, a `BEGIN`
transaction, a Rivet transaction) while the actor was forked 24 times.

## What runs locally, and what needs a deployment

- **Locally.** `LocalEngine.serve({ actors })` from `@effectified/pi-durable-rivet/node` (or `/bun`) starts the
  engine binary of rivetkit's platform package (`@rivetkit/engine-cli-<platform>-<arch>`) beside the process, on a
  free set of loopback ports, with its data in a temporary directory, and removes all of it with the scope.
  `LocalEngine.available` says whether the binary is installed. Sleep, schedules, forks and destroy all work there.
- **An engine a product keeps.** `LocalEngine.serve({ actors, directory, port })` keeps the engine's data in
  `directory` (it makes `.rivetkit` there) and leaves it when the scope closes, so the next run of the product
  starts the same engine with its actors' state. `port` is optional; without it each run draws a free set. One
  engine runs on a directory: an engine another process left or still runs there is stopped first. The user's home
  is refused, since that is where rivetkit keeps the engine every project shares. `serve` answers
  `{ endpoint, directory }`; `LocalEngine.running(directory)` gives the engine's process ids and
  `LocalEngine.stop(directory)` stops it from outside, for a test or a clean-up. Both fail with `EngineUnavailable` of
  the code `environment` when the process list cannot be read (`ps`, which they run, is missing).
- **Several engines in one process.** Each `serve` has its own directory and ports. The directory reaches an engine
  through the process's environment, so one engine starts at a time; starts that are asked for together wait for
  one another.
- **A host that is killed leaves no engine.** A small shell process beside the host waits for the host's end,
  however it comes, and stops the engine then. rivetkit does that itself on Linux only. A host that takes a
  directory over from another process is not stopped when that process ends.
- **Three ports.** The engine of rivetkit 3.1.1 listens on the port it is given (its guard, where clients and the
  registry connect), on the next one (its API peer) and on the tenth after it (its metrics). `serve` draws a port
  between 20000 and 32000, below the ranges systems hand out to outgoing connections, and checks that all three are
  free. An engine that still finds one taken says so and exits, and `serve` starts again on another set, three times
  in all, then fails with `EngineUnavailable` of the code `port`.
- **An engine that something else stops.** rivetkit does not watch the engine it started: when another program on
  the machine stops it during the start (a `pkill rivet-engine` of another project's script does), rivetkit asks the
  dead engine for its health for a minute. `serve` sees that the engine's process ended, fails that start within
  seconds with the code `lost`, and starts again, three times in all. An engine stopped after it was ready is not
  recovered: calls fail with a retryable `EngineUnavailable`, and rivetkit ends the process, unless
  `Host.holdBackExit` was run (below).
- **Another engine on the port.** rivetkit uses any engine that answers on the port in place of starting its own.
  `serve` checks, by the file the started engine writes in its directory, that the engine that answers is its own,
  and fails with the code `port` otherwise. A `port` that was given is checked before the start too.
- **Files and processes the machine refuses.** The engine's directory, its files and its processes are reached
  through Effect's `FileSystem`, `Path` and `ChildProcessSpawner`, in Node's implementations of
  `@effect/platform-node-shared`, which the `/node` and `/bun` entries provide. A directory that cannot be made, a
  file that is there and cannot be read (the engine's runtime file, its logs), or a process list that cannot be read
  fails the start at once with the code `environment`, and the message says which and why: it is not taken for
  another engine on the port.
- **A start that fails leaves nothing.** A failed or interrupted start shuts its registry down, stops the engine
  process it started, removes its temporary directory, and holds back the exit of the process that rivetkit makes
  for it (below). A later `serve` in the same process works.
- **On Bun, use the `/bun` entry.** rivetkit's native core reads `RIVETKIT_STORAGE_PATH` from the process
  environment, which an assignment to `process.env` does not change on Bun. Without the variable the engine keeps
  the data of every project in `~/.rivetkit`. The `/node` entry refuses to start an engine on Bun for that reason.
  The variable keeps the directory of the last start: rivetkit reads it at every step of a start, also of one that
  was given up and still runs.
- **A process that decides its own end.** `yield* Host.holdBackExit` before the first `serve` makes every exit
  rivetkit asks for do nothing, for the life of the process; every other `process.exit` works as before. It is for
  a process that hosts several engines, or other work beside its actors, which must not end because one engine
  died. `Host.serve` also takes `use`, rivetkit actor definitions of the product's own, registered beside `actors`.
- **A deployment.** `Host.serve({ actors, endpoint })` registers the actors with an engine that runs already.
  Needing one: hosts on several machines, actors that survive the machine, and engine upgrades (the only source of
  `actor.fork_unavailable`). Several host processes on one machine serve a local engine as well: a child process that
  calls `Host.serve` with the local engine's `endpoint`, which is how `packages/thread-effect/test/hosts-suite.ts` kills them.
  Give those hosts and their clients a pool of their own (`node: { poolName }` of `Host.serve`, `poolName` of
  `Client.layer`), as that suite does, so that the pool holds only hosts that serve the same actors.

## Testing

`@effectified/pi-durable-rivet/testing` has what an engine test of a product needs beside its own actions. It has
no platform code: the engine comes from `/node` or `/bun`.

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

| | |
|---|---|
| `observed(definition)` | The same actor with its lifecycle recorded in the test's process and three test actions under the host's `pi` name. Typed as the definition it was given |
| `sleep(handle)` | Rivet's forced sleep (`c.sleep()`): the harness closes in `onSleep`. The next call or a scheduled wake wakes the actor |
| `lifecycle(handle)` | What the actor's hooks did, in order: `wake`, `sleep`, `destroy`, `fired` (a scheduled wake action ran) |
| `seen(handle, event, times?)` | Succeeds once the hooks recorded the event that often; dies after 30 seconds |
| `schedules(handle)` | Everything Rivet has scheduled for the actor: `{ action, runAt }`. The host's wake actions are those of `pi.wake` |
| `scheduleWake(handle, afterMillis)` | One more wake action, as an earlier wake of the actor could have left one |
| `hosted(serve, options)` | A local engine and a client of it, for the scope: `{ endpoint, context }` |

The lifecycle is recorded in memory, so it is seen by a test that hosts its actors in its own process, which is
what `LocalEngine.serve` does.

## Guarantees and their limits

What holds:

- A call returns after the harness is open on the actor's storage, and no handler outlives the actor's `onSleep`
  or `onDestroy`.
- Work Pi stored is resumed at the next wake: a model request a stop cut off is sent again, a `replay: "safe"` tool
  runs again, a `replay: "unsafe"` tool gets Pi's `interrupted` result.
- While Pi has work that can run, the actor is awake or a wake is scheduled within 15 seconds.
- A fork's first call sees a storage on which every inherited schedule is gone and every hygiene Effect has run.
- Nothing is logged but the class of an error that kept the harness from opening, and what
  `@effectified/pi-durable` logs of Pi's reports: kinds, ids and names, never content.

What does not:

- A stop does not drain. A model request running when Rivet stops the actor (a deploy, a forced sleep) is cut off
  and sent again at the next wake.
- A harness that failed after a storage error (`SessionFailed`) stays failed until the actor sleeps and wakes.
- The check of a fork and the fork are not one step (above).
- A background task of the product is copied live. Nothing in this host ends it: a product with such a task and
  without hygiene for it runs the task in both actors.
- A schedule write Rivet refuses is tried again every 15 seconds while the actor is held awake; a crash in that
  time strands the sleep until the next call.
- `destroy` answers the size of the actor's SQLite database, page count times page size, read before it destroys.
  Rivet 3.1.1 reports no bytes written per actor.
- rivetkit installs SIGINT and SIGTERM handlers when a registry starts, unless `shutdown.disableSignalHandlers` is
  set, and exits the process when its connection to the engine fails after the start.
- rivetkit also exits the process (`process.exit(1)`) for a start with `startEngine` that gets no healthy engine:
  at once for a binary that is no engine, and after 64 health checks, about a minute, for an engine that died or
  never listened, also when the start failed as an Effect long before and its registry was shut down. And its
  shutdown leaves the engine process of such a start running until those checks run out. The local engine entries
  deal with both for their own starts: they stop the process themselves, found by the configuration file of its
  directory on its command line, and replace `process.exit` while a start is under way or its exit is still due
  (up to two minutes after a failure) by a function that drops a call made from rivetkit's own files and passes
  every other call on. `Host.serve` with `startEngine` alone does neither. `Host.holdBackExit` drops every exit of
  rivetkit's for good, the one for an engine lost after it was ready too.
- The watcher that stops the engine of a killed host needs `/bin/sh`, `ps`, `grep` and `awk`. Without them the engine
  of a killed host runs on until the next start on its directory stops it. A host killed in the moment its engine
  became ready is stopped with every engine of its directory, one another process started there since too.
- A local engine process that was stopped stays in the process table, as a zombie, until rivetkit's native core
  waits for it, which is when its health checks run out, or the process ends.

## License

MIT
