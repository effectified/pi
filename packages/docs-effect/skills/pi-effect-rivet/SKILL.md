---
name: pi-effect-rivet
description: Hosts agent threads or a bare Pi Durable harness in Rivet actors with @gunta/pi-thread-effect/rivet (ThreadActor.make, Remote, product actions, SwarmId) and @gunta/pi-durable-rivet-effect (Actor.make, Action.make, Client, Host.serve, Self, ActorSql, ActorInfo). Covers the fixed actions and the client's three error kinds, a local engine from the /node or /bun entry (LocalEngine.serve with a temporary or a kept directory, several engines, Host.holdBackExit), host processes that are killed and come back, wake-ups and what is promised about them, actor forks and fork hygiene (onStorageFork, forkHygiene, NotIdle, ForkTooDeep), the actor's database (ActorSql, and ActorDatabase as the deprecated promise form), what runs locally and what needs a Rivet deployment, and the limits. Use it when putting threads or a harness into actors, calling them from a product, running a local engine on Node or Bun, surviving a process kill, or forking an actor.
---

# Threads and harnesses in Rivet actors

Two levels, one host:

- **A thread per actor**: `@gunta/pi-thread-effect/rivet`. `ThreadActor.make` is the composition of the skill
  `pi-effect-thread` inside an actor; `Remote` is the client a product binds its ports to. Use this for threads.
- **A harness per actor**: `@gunta/pi-durable-rivet-effect`. `Actor.make` puts any registry and models of yours into
  an actor, with actions of your own. Use this for something that is not the thread composition.

Read `pi-effect-thread` first for what a thread is; this skill adds what changes in an actor.

## A thread per actor

From the thread README, "The Rivet form" (`config`, `productPorts`, `openRecordStream`, `endpoint`, `work` and
`jobKey` are the product's):

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

- **One definition is the thread and every fork of it.** The actor's key is the thread's key (or, with `actorKey`,
  a function of it). Swarm forks are actor forks under `[<thread>, "swarm", <swarm id>, <job key>]`.
- **`composition`** is the `Composition.Config` of one process without `forks`: forks are actor forks here.
- **`ports`** is one `Layer` with the product's ports and what its tools need. It may require `ActorInfo`,
  `ActorSql`, `ActorDatabase` and `ActorEngine` (`Actor.Provided`), so it can give each actor, and each fork, its
  own lease and record stream (`ActorInfo.actorId`).
- **The ports are built at each wake before any action runs**, the first wake of a new actor included. A port that
  reads the product's rows reads them when it is called, not when it is built, and treats a missing row as "not
  given yet": a port that fails while it is built is a harness that did not open, and every call, the action that
  would write the row included, answers with that defect.
- **`services`** is a `Layer` of the product's own built on the open harness, after the composition's services.
- **`forkHygiene`** is the product's steps on a copied storage, after the composition's (below).
- **`actions`** are the product's own beside the fixed ones, run with the harness, the composition's services,
  the ports and `Actor.Provided`. The usual first one gives an actor its work before `start`, since an actor is
  created by its key alone. The README's example writes with the deprecated `ActorDatabase`; new code writes the row
  with `ActorSql` (see "The actor's database" below):

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

The options table: [The thread actor](../../../thread-effect/README.md#the-thread-actor). Product actions:
[Product actions](../../../thread-effect/README.md#product-actions).

### Actions and the client

Every fixed action returns within Rivet's action timeout (60 seconds) and is safe to send again. None waits for a
thread or a swarm: `start` is `Threads.admit`, `resume` is `Threads.takeOn`, `release` is `Threads.decide`, and
`cancel`, `probe`, `outcome`, `pending`, `decide`, `runSwarm` and the swarm operations are their one-process forms.
The actor tells the product's `OutcomeSink` when the thread ends; `remote.threads.ended(thread, schedule)` is for a
caller that wants to wait, and fails with `StillWorking` when its schedule ends.

`Remote.layer(definition, { timeout, actorKey })` provides `Remote` on the `RivetClient` of the context
(`Client.layer({ endpoint })`); its operations are methods of the service (`remote.threads.start`). An action's
input crosses as JSON; the READMEs state no size limit for it.
`Remote.product(definition, options)`, an Effect on the `RivetClient`, gives the product actions of a thread: `call`
(creates no actor) and `callOrCreate` (before `threads.start`). Every operation fails with one of three kinds:

| Error | Means | Do |
|---|---|---|
| `HostUnavailable` | The engine could not be reached, refused for now, or did not answer in `timeout` (30 s) | Send the same call again |
| `ThreadNotFound` | No actor under the thread's key | Start the thread |
| `OperationFailed` (and `ReviewerSharesFamily` of `start`) | The operation ran and failed; `reason` is the tag | Read the reason |

A swarm's id names its thread: `SwarmId.of(thread, name)`, a name without a slash. Another id fails with
`SwarmIdNotOfThread` before anything is sent. The agent change of a swarm's forks crosses by name
(`ForkAgent.Wire`); a name nothing is installed under in the actor fails `runSwarm` with `OperationFailed` of the
reason `InvalidPlan`, and nothing is stored.

Nothing checks who calls an action or a fork action: authenticate in the host.
Every operation: [The client service](../../../thread-effect/README.md#the-client-service).

## A harness per actor

`Actor.make(name, { layer, services, harness, prefix, actions, forkHygiene, options })` gives a definition.
`layer` provides `Registry` and `Models` and what handlers need, and may require `ActorInfo`, `ActorSql`,
`ActorDatabase` and `ActorEngine`. `harness` takes Pi's harness options, or an Effect that gives them on what
`layer` provides. `Action.make({ input, output, error, handler })` crosses the boundary as JSON through its
schemas; without `error` the handler cannot fail.

- At each wake `layer`, Pi's storage, the harness and `services` are built in one scope, in that order, and
  pending work resumes. At sleep or destroy, handlers are interrupted and the scope closes. So state held in a
  service of `layer` (a scripted model's queue, a cache) is gone at the next wake; what must last is in the storage.
- A bare actor has only the actions it is given: a product with approvals adds one that calls `Approvals.decide`
  (and one that lists `Approvals.pending`), as the thread actor's `decide` and `pending` do.
- An action that starts long work submits it and returns; the caller waits with `Client.waitForIdle`.
- Interrupting a caller cannot stop an action Rivet delivered. Stop work with an action that calls
  `Conversation.abort`.
- Inside an actor, `Self.client` (a `RivetClient` from the actor's own context, no endpoint), `Self.handle`,
  `Self.find` and `Self.getOrCreate` reach this actor and its siblings.
- `Client` errors are a closed union: `ActionFailed`, `ActorDefect`, `ActorGone`, `NotIdle`, `ForkTooDeep`,
  `ForkKeyHeld`, `EngineUnavailable`. rivetkit's client waits without end for an engine it cannot reach: bound a
  call with `Effect.timeout`, or set `disableMetadataLookup: true`.

The full example runs as it stands on a local engine: [Example](../../../durable-rivet-effect/README.md#example).
Then [The actor](../../../durable-rivet-effect/README.md#the-actor), [Actions](../../../durable-rivet-effect/README.md#actions),
[Inside an actor](../../../durable-rivet-effect/README.md#inside-an-actor), [The caller](../../../durable-rivet-effect/README.md#the-caller).

## A local engine

`serve` of `@gunta/pi-durable-rivet-effect/node`, or of `@gunta/pi-durable-rivet-effect/bun` on Bun, starts
rivetkit's engine binary beside the process and hosts the given actors in this process. It is scoped.

| Call | Gives |
|---|---|
| `serve({ actors })` | A free set of loopback ports and a temporary directory, removed with the scope. For tests and demos |
| `serve({ actors, directory, port })` | The engine's data kept in `directory` (it makes `.rivetkit` there) and left when the scope closes: the next run starts the same engine with its actors' state. `port` optional |
| `available` | An Effect: whether the engine binary is installed (`@rivetkit/engine-cli-<platform>-<arch>`) |
| `running(directory)`, `stop(directory)` | The engine's process ids; stop it from outside |

- **On Bun use `/bun`.** The `/node` entry refuses to start an engine on Bun: rivetkit reads its storage path from
  the process environment, which an assignment does not change on Bun, and would keep data in `~/.rivetkit`.
- **One engine per directory.** An engine another process left there is stopped first. The user's home is refused.
- **Several engines in one process** each have their own directory and ports; they start one at a time.
- **`yield* Host.holdBackExit`** before the first `serve`, in a process that hosts several engines or other work:
  rivetkit otherwise exits the process when an engine it started dies after it was ready.
- **A killed host leaves no engine**: a watcher process stops it. It needs `/bin/sh`, `ps`, `grep` and `awk`.
- `serve` fails with `EngineUnavailable` and a `code` (`port`, `lost`, `environment`, ...) that says what failed.
- `Host.serve({ actors, endpoint })` registers actors with an engine that runs already: a deployment, or the local
  engine of another process. Give several host processes and their clients a pool of their own
  (`node: { poolName }` of `Host.serve`, `poolName` of `Client.layer`).

Every case: [What runs locally, and what needs a deployment](../../../durable-rivet-effect/README.md#what-runs-locally-and-what-needs-a-deployment).

### Surviving a kill

A `kill -9` of the process that ran `serve` stops its engine too (the watcher). Two shapes keep threads going:

- **One process, a kept directory.** `serve({ actors, directory })`. The actors' storage is in the directory, and the
  restarted process starts the same engine on it. The READMEs promise the state; the composition's kill tests did
  not restart an engine on a kept directory, and nothing says whether a wake scheduled before the engine stopped
  fires after it starts again. So the product calls its threads after a restart (below).
- **An engine that outlives its hosts.** One process runs `serve` and stays up; the processes that are killed run
  `Host.serve({ actors, endpoint, node: { poolName } })` on its `endpoint`, and callers use `Client.layer` with the
  same `poolName`. This is the shape the composition's host-process tests ran: a killed host's actor comes up in
  another host about 15 seconds later, with no call, by the recovery wake.

Either way:

1. Keep the product's thread keys in its own store: there is no listing of actors (`Client.find` is by key).
2. After a restart, call each unfinished thread (`remote.threads.probe` or `remote.threads.outcome` of the `Remote`
   service). A call wakes the actor, which opens the harness and resumes Pi's stored work before it answers.
3. Expect repeats: the request the kill cut off is sent again under the same session and `requestKey`; a
   `replay: "safe"` tool runs again, a `replay: "unsafe"` one does not (the model reads `interrupted`); records and
   outcome events are delivered again under the same ids.
4. Expect what is open or lost: the killed request's reservation stays open (the lease must expire it); a response
   Pi never committed is in no record; a failed route attempt not yet settled is settled by nobody.

Evidence: [A host process that dies, and several of them](../../../thread-effect/README.md#a-host-process-that-dies-and-several-of-them),
[Limits the packages document](../../../thread-effect/README.md#limits-the-packages-document-which-a-product-inherits).

## Wake-ups

The host runs the harness with Pi's host wakes and follows them:

- **Pi has work that can run:** the actor is held awake, and a recovery wake is kept at most 15 seconds ahead. That
  wake is what resumes a run after a crash.
- **Only sleeps are left** (a parked call, a sleeping task, a held answer): one wake action at the earliest, then the
  actor may sleep.
- **Nothing is left:** no wake; the actor sleeps after its `sleepTimeout` (30 s).

A wake that fires early, late, twice or in a fork is harmless: resuming is idempotent. A due wake is acted on by
whoever sees it first, Rivet or the next call ([Wake-ups](../../../durable-rivet-effect/README.md#wake-ups)). A thread
actor does not sleep on an outcome event it has not delivered: the courier holds it awake, and after a failed attempt
a wake is scheduled for the next one ([The thread actor](../../../thread-effect/README.md#the-thread-actor)).

## Forks

`Client.fork(source, { key, input, retry })` copies an actor's whole storage into a new actor.

- **Only with nothing in flight**: no unsettled submission, no live task but a background task of the product.
  Else `NotIdle`. So a thread that works, is parked, held or deferred is never copied; a swarm on it waits.
- **The check and the fork are two requests.** Nothing may start work in the source between them.
- **Idempotent by key**; a key another actor holds is `ForkKeyHeld`. **Sixteen deep** at most: `ForkTooDeep`.
- **Before its first call** the fork cancels every inherited schedule, opens the harness without resuming it, runs
  each `forkHygiene` step in order, and records that it did. A step must be idempotent: after a crash it runs again.

A thread actor runs `ThreadActor.hygiene` (the recorder's cursors, the swarm's coordinators, live subagent runs,
budget shares moved to `inherited`, the composition's own), then the product's steps. A product step is an Effect
on `Harness`, `ActorInfo`, `ActorSql` and `ActorDatabase`, run with the product's `ports` and without `services`; it
must be idempotent, and a failure fails the fork's start. It fixes what the product keeps of its own: rows of its
tables that name the source (a lease, a stream position, a pending send), and the first record of the fork's stream.

- **A fork repeats its source's ids**: the thread key, record ids, outcome event ids. Key the product's sinks by
  the actor (`ActorInfo.actorId`) and the id.
- **In the thread composition, actor forks are swarm forks.** To keep a branch to go on with, pin its job
  (`plan.pins`) and release it later with `forks.destroy`. `Client.fork` of a thread actor by hand is not a thread
  operation the READMEs document: the copy's thread stands where its source's did, and `Remote` finds actors by
  thread keys and swarm ids, not by a fork key of your own.

A bare `Actor.make` with
plugins lists their steps itself: the recorder's `onStorageFork` first, `Rivet.forkHygiene` of
`@gunta/pi-swarm-effect/rivet` in every actor that runs swarms, and the `onStorageFork` of the subagent and budget
plugins (the budget's takes the fork's actor id).
Why each step and in that order: [What a fork inherits, and the fork hygiene](../../../thread-effect/README.md#what-a-fork-inherits-and-the-fork-hygiene).
The host's side: [Forks](../../../durable-rivet-effect/README.md#forks).

## The actor's database

`ActorSql` is the actor's SQLite as an Effect `SqlClient`, on the queue Pi's storage uses, so a product's
transactions queue with Pi's. Keep product tables outside Pi's `prefix` (default `pi_`).

```ts
import { ActorSql } from "@gunta/pi-durable-rivet-effect";
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

- `withTransaction` is Rivet's transaction: it commits when the Effect succeeds and rolls back when it fails or is
  interrupted. A nested one is a savepoint. Effect's `Migrator` runs on it with a migration table of the product's.
- A statement the storage refuses with a retry hint is sent again outside a transaction, never inside one: there the
  transaction is rolled back and the refusal reaches the caller.
- `ActorDatabase` is the same database as Chord's promise-based `SqliteDatabase`. It is deprecated: kept for Pi's
  storage and code written against it. New code uses `ActorSql`.

[Storage](../../../durable-rivet-effect/README.md#storage).

## Local or a deployment

Runs on a local engine: sleep, schedules, forks, destroy, several host processes on one machine, a host killed and
replaced. Needs a Rivet deployment: hosts on several machines, actors that survive the machine, an engine of several
nodes, engine upgrades. Not proven anywhere yet: an engine that dies, a network that parts a host from the engine
([Not proven on a local engine](../../../thread-effect/README.md#not-proven-on-a-local-engine)).

## Limits

- **A stop does not drain.** A model request running when the actor stops is cut off and sent again at the next wake.
- **A storage error fails the harness** (`SessionFailed`) until the actor sleeps and wakes.
- **A frozen host is not fenced the instant its actor moves.** A tool in the middle of an outside effect is not
  stopped by the host: the product's service must refuse a repeat, by the lease or an idempotency key.
- **A background task of the product is copied live** into a fork; without hygiene for it, it runs in both actors.
- **rivetkit installs SIGINT and SIGTERM handlers** and may call `process.exit`; the local engine entries guard
  their own starts, `Host.holdBackExit` guards the rest.
- **`destroy` answers the database's size**, not bytes written: Rivet reports none per actor.

All of them: [Guarantees and their limits](../../../durable-rivet-effect/README.md#guarantees-and-their-limits).
For engine tests of actors, read `pi-effect-testing`.
