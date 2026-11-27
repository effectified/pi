# @effectified/pi-durable

Pi's durable agent harness ([`@earendil-works/pi-durable`](../durable)) in Effect terms, for `effect` 4.1:

- The harness as a scoped Layer; conversations and submissions as Effects and Streams.
- Tools and hooks whose handlers are Effects. What a handler needs is a requirement of the registry Layer, so a
  missing service is a compile error. The tools of an `effect/ai` `Toolkit` install as they are.
- Gates that block, rewrite or park a tool call, and signals typed by an Effect `Schema`.
- Durable tasks whose input, state and result are Effect `Schema`s and whose phases are Effects, with child tasks
  and tasks a hook asks for.
- Atomic commits whose body is an Effect, with documents and entries typed by an Effect `Schema`.
- Pi's built-in documents (`pi.live`, `pi.usage`, and the others) and its `SubmissionSettled` signal as documents and
  a signal of this package.
- Watches and stored commits as Streams, and the host seams: reports, wake-ups, usage, a parent context for every Pi
  call.
- Scans of conversations and tasks as Streams, and idle reads that do not wait.
- Typed errors, interruption in both directions, and time from Effect's `Clock`.
- A testing kit: a harness on scripted models, with no provider and no key, also on a registry and models of your own.

It adds no behaviour of its own: what Pi Durable does is what happens, and its
[README](../durable/README.md) and [specification](../durable/docs/spec.md) describe it. Built for Pi Durable 1.6.1,
which says of itself: "Experimental. The API changes without notice."

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.2.0
npm install --allow-remote=all $R/effectified-pi-durable-0.2.0.tgz $R/effectified-pi-ai-0.2.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Quick start

A tool that needs a service, a hook that gates tool calls, a prompt, and a fork. It runs as it stands, because the
model is scripted; the same code is the test [`test/readme.test.ts`](test/readme.test.ts).

```ts
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { Extension, Gate, Harness, Hook, Registry, Storage, Tool } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness, toolCall } from "@effectified/pi-durable/testing";

// A service of your program. Handlers reach it through the Layer you provide.
class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }> }
>()("app/Records") {}

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: ({ id }) => Records.use((records) => records.get(id)), // Effect<{ title }, never, Records>
});

const NoWrites = Hook.beforeTool((call) =>
	Effect.succeed(call.name.startsWith("write") ? Gate.block("read only") : Gate.allow),
);

const App = Extension.make({ name: "app", tools: [Lookup], hooks: [NoWrites] });

const program = Effect.gen(function* () {
	// No provider and no key: the model answers with these turns, in order.
	yield* ScriptedModels.use((models) =>
		models.setResponses([
			toolCall("lookup", { id: "42" }),
			answer("Record 42 is titled Answer."),
			answer("Record 42 is not titled Answer."),
		]),
	);
	// A conversation answers with the model its agent names.
	const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
	yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
	yield* root.waitForIdle;
	// Fork at the newest entry: the branch sees the summary and continues alone.
	const head = Option.getOrThrow(yield* root.head);
	const branch = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
	const settled = yield* branch.prompt("Now argue the opposite.", { requestId: "opposite-42" });
	yield* branch.waitForIdle;
	const entries = yield* Stream.runCollect(branch.entries({ order: "ascending" }));
	return { settled, kinds: entries.map((entry) => entry.kind) };
});

const live = Harness.layer().pipe(
	// Does not type check until `Records`, which the lookup tool needs, is provided below.
	Layer.provide(Registry.layer([App])),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
	Layer.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
);

Effect.runPromise(Effect.provide(program, live)).then(console.log);
```

With a real provider, replace `ScriptedModels.layer()` by `Models.layer([anthropicProvider()])` from
`@effectified/pi-ai`, name one of its models in `agent`, and drop `setResponses`. To keep conversations across
restarts, replace `Storage.memory` by `Storage.sql()` over an Effect SQLite client (below).

## Harness

`Harness.layer(options)` opens a harness on the `HarnessStorage`, `Models` and `Registry` of the context and closes
it, with its storage, when the scope closes. Work the last process left unfinished continues as soon as it is open
(Pi's `resume()`); `resume: false` leaves it until a call asks for progress, and `readOnly: true` opens a viewer that
refuses every write with `ReadOnlySession`.

| | |
|---|---|
| `Harness.root`, `rootWith({ agent, init })` | The root conversation, created on first use |
| `Harness.conversation(id)`, `createConversation(options)` | Another conversation: an `Option`, or a new one |
| `Harness.submission(id)`, `abortSubmission(id, conversationId?)` | Reacquire a submission, or withdraw a queued one (`AbortSubmissionResult`, Pi's own answer) |
| `Harness.getTask(id)`, `waitForTask(id)`, `abortTask(id)` | A task's record, its terminal record, an abort mark (`AbortTaskResult`, Pi's own answer) |
| `Harness.getTaskOf(task, id)`, `waitForTaskOf(task, id)` | The same, with the result decoded by the task's schema (see [Task](#task)) |
| `Harness.signal(taskId, signal, key, value)`, `signalState(taskId, signal, key)` | Deliver a signal to a live task, read a key's state from outside it (see [Signal](#signal)) |
| `Harness.waitForIdle`, `inspect`, `usage` | Wait for all work, see live work, sum tokens and cost |
| `Harness.isIdle`, `isConversationIdle(id)` | Whether a wait for idle would succeed at once (see [Scans and idle reads](#scans-and-idle-reads)) |
| `Harness.scanConversations(query?)`, `scanTasks(query?)`, `conversationRecord(id)` | Stored records without a commit of your own (see [Scans and idle reads](#scans-and-idle-reads)) |
| `Harness.commit(body, options?)` | One atomic commit (see [Commits](#commits)) |
| `Harness.snapshot(doc, …address)`, `snapshotAsOf(doc, …address, at)` | A document's committed value, an `Option` |
| `Harness.watchDoc(doc, …address)`, `taskGraph`, `commits` | Watches and stored commits as Streams (see [Watches](#watches)) |
| `Harness.reports`, `wakes`, `wake`, `resume`, `usageEvents(id)` | The host seams (see [Hosts](#hosts)) |

The service value (`yield* Harness.Harness`) is Pi's own harness, for what is not wrapped yet.

## Conversation

A `Conversation` is a plain object of Effects bound to its harness.

- `submit(draft)` admits an input, a write or a continue and succeeds at admission with a `Submission`.
  `prompt(input, options)` is `submit` of an input, then `wait`.
- `fork({ at, ownership, agent, init })` gives a conversation that sees this one's entries up to `at`. `head` is the
  newest entry, the one to fork at; it is an `Option`, none while the conversation is empty. `init` runs in the
  creating commit (see [Conversation init](#conversation-init)).
- `agent` resolves what the conversation runs with; `configure(change)` changes it (see [Agent](#agent)).
- `commit(body, options?)` is one atomic commit, and `admit(tx, draft)` admits a submission inside one
  (see [Commits](#commits)).
- `compact(instructions)`, `reset(handoff)`, `abort(options)`, `waitForIdle`, `context({ at })`.
- `entries(query)` is a `Stream` of the stored history, read page by page as it is pulled.
- `changes(window?)` is Pi's `watch` as a `Stream` (see [Watches](#watches)).
- `record` reads the conversation's stored record, which never changes; `parent` (the conversation and entry a fork
  started from) and `owner` (the task that owns it, and that task's conversation) are its two fields as `Option`s.
  Pi stores nothing else of a conversation's creation: no time, and no creator besides the owner.

`Conversation.Id`, `Entry.Id`, `Submission.Id` and `Task.Id` are the schemas of Pi's ids, for a document, a task
state or a wire that keeps one: an integer as stored (Pi mints them from 1; 0 names no record), the branded id as
decoded, with no cast (Pi brands ids in its types only, and TypeScript checks the brand is a number's). `Entry.after(id)` is the smallest entry id after `id`, the
bound of a read that starts after it (`minEntryId`).

## Conversation init

`Harness.createConversation({ ownership, agent, init })`, `Harness.rootWith({ agent, init })` and
`conversation.fork({ at, ownership, agent, init })` take Pi's `init`: `(tx, conversationId) => Effect`, run inside the
commit that creates the conversation, after the harness's `conversationCreated` and the `agent` change. What it
writes exists exactly when the conversation does. The conversation is a table write already, so table reads fail with
`ReadAfterWrite`; documents, entries and `tx.createTask` work. A failing `init` fails the creating commit: nothing is
stored, the conversation included, and the Effect fails with `init`'s own failure. `rootWith` runs it only when it
creates the root.

```ts
const Jobs = Doc.family({
	kind: "swarm.job",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ conversationId: Schema.NullOr(Conversation.Id) }),
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => false,
});

class AlreadyForked extends Schema.TaggedError<AlreadyForked, { readonly brand: unique symbol }>()("AlreadyForked", {
	conversationId: Conversation.Id,
}) {}

// One fork per job key: `init` claims the key in the commit that creates the fork.
const forkFor = (parent: Conversation.Conversation, at: EntryId, key: string) =>
	parent.fork({
		at,
		ownership: { kind: "ownerless" },
		init: (tx, conversationId) =>
			Effect.gen(function* () {
				const job = yield* tx.doc(Jobs, key, null);
				const claimed = (yield* job.get).conversationId;
				// A failing init fails the creating commit: a retried job stores no second fork.
				if (claimed !== null) return yield* AlreadyForked.make({ conversationId: claimed });
				yield* job.set({ conversationId });
			}),
	}); // Effect<Conversation, AlreadyForked | DurableError | SchemaDecodeError>

// After a crash the key finds the fork again: one committed read.
const findFork = (key: string) => Harness.snapshot(Jobs, key);
```

Pi has no index of conversations by a key of yours. A session-scoped document family keyed by your key, as above, is
the direct lookup. `tx.scanConversations` filters by owner only (`ownerTaskId`, `ownerConversationId`): a task that
owns its forks lists them that way and reads a document of each.

## Commits

`Harness.commit(body)`, `Conversation.commit(body)` and a tool's `api.commit(body)` run `body`, an Effect on a `Tx`,
inside one Pi commit. Everything the body writes is stored together, or nothing is.

```ts
const Todos = Doc.make({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ items: Schema.Array(Schema.String) }),
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});
const Note = Entry.make("app.note", Schema.Struct({ text: Schema.String, at: Schema.Date }));

class TooMany extends Schema.TaggedError<TooMany, { readonly brand: unique symbol }>()("TooMany", {
	max: Schema.Int,
}) {}

const addTodo = (item: string, at: Date) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		return yield* root.commit((tx) =>
			Effect.gen(function* () {
				const todos = yield* tx.doc(Todos, root.id);
				const { items } = yield* todos.get;
				// A failing body fails the commit with its own error, and nothing of it is stored.
				if (items.length >= 2) return yield* TooMany.make({ max: 2 });
				yield* todos.set({ items: [...items, item] });
				const note = yield* tx.append(Note, root.id, { data: { text: `added ${item}`, at } });
				return note.id;
			}),
		);
	}); // Effect<EntryId, TooMany | DurableError | SchemaDecodeError, Harness>
```

- **Outcome.** The Effect succeeds with the body's value once the commit is stored. A body that fails, with a failure
  or a defect, rolls the commit back and fails the Effect with the body's own cause. The body runs with the caller's
  services, so what it needs is a requirement of the commit.
- **Interruption.** A caller interrupted while the body runs interrupts the body, which stores nothing. Once the body
  has ended, Pi stores the commit whatever happens to the caller.
- **Pi's rules for a body.** Table reads (`conversation`, `entry`, `task`, `scanConversations`, `scanEntries`,
  `scanTasks`, `conversations`, `tasks`, `latestEntryId`, `submission`) come before the first table write
  (`appendEntry`, `append`, `createConversation`, `forkConversation`); afterwards they fail with `ReadAfterWrite`, and
  so do `signal` and an admission. Documents can be read and written at any point. Read only through `tx`: a read of the
  harness or a conversation inside the body waits for the line of commits the body holds, and never returns. No long
  work: every other commit waits for the body.
- **What a `Tx` has.** The reads above; `appendEntry`, `append` (a typed entry) and `entryOf`; `createConversation`
  and `forkConversation`; `createTask(task, input, options)` (see [Task](#task)); `configure(conversationId, change)`;
  `signal(taskId, signal, key, value)`; `doc` and `retireDoc`; and `pi`, Pi's own transaction, for raw submissions.
- **Admission.** `conversation.admit(tx, draft)` admits a submission in the caller's commit: a message and the
  host's own record of it are stored together. A refusal (`ConversationBusy`, `ConversationIdle`) fails before any
  write, so the body can catch it and commit the rest.
- **Options.** Pi's: `{ persistence: { kind: "deferred", withinMs } }` shows a change of existing
  `latest`/`initial` conversation documents at once and stores it later.

## Doc

`Doc.make(definition)` defines a document, Pi's typed JSON state stored beside the transcript, as `defineDoc` does:
`kind`, `version`, `scope` (`session`, `conversation` with `history` and `fork`, or `task`), `initial`,
`checkpointWhen`, and optionally `migrate`. The value is typed by `schema`: encoded to JSON when written, decoded
when read, with `SchemaDecodeError` for a value outside it. `Doc.family(definition)` defines one document per key,
each created from a seed.

- In a commit, `tx.doc(Todos, root.id)` opens the document, creating it from `initial` when it does not exist, and
  gives `get`, `set(value)`, `update(change)` and `draft`. `set` writes each top-level field that differs; `draft` is
  Pi's own draft of the stored JSON, for a small stored change such as one item pushed to a long list.
- Outside a commit, `snapshot(doc, …address)` and `snapshotAsOf(doc, …address, at)` (rewindable documents) read the
  committed value as an `Option`. A harness, a hook's `api` and a tool's `api` have both. They never create a
  document: treat an absent one as its default.
- The address follows the scope: nothing for a session document, the conversation's id, or the task's id; a family
  adds its key, and `tx.doc` its seed. The types check it.

## Built-in documents

Every conversation of a harness has Pi's five built-in conversation documents, and a tool call that makes nested calls
has Pi's nested-call family. `BuiltinDoc` gives each as a document of this
package, over Pi's own token and typed with Pi's own state type, for `Harness.snapshot`, `Harness.watchDoc`,
`tx.doc`, and the `snapshot` of a hook, a tool or a task. Its kind, version, history and state type are read from
Pi's token; its `history` is typed as Pi types the token, `"latest" | "rewindable"` for all but `BuiltinDoc.agent`.

| | Holds | Written by |
|---|---|---|
| `BuiltinDoc.live` (`pi.live`) | The run a conversation is busy with, the streamed answer, the tool calls of the round, running compactions, and why the newest run failed (`runFailure`) | Pi alone |
| `BuiltinDoc.provider` (`pi.provider`) | The session id Pi sends to providers for the conversation | Pi alone |
| `BuiltinDoc.usage` (`pi.usage`) | Tokens and cost of the conversation, per `provider/model` and per tool | Pi alone |
| `BuiltinDoc.inbox` (`pi.inbox`) | The submissions queued behind the current run | Pi alone |
| `BuiltinDoc.agent` (`pi.agent`) | What the conversation runs with, as stored names | Your code: `configure` |
| `BuiltinDoc.nestedCall` (`pi.tool.nested-call`) | A family in a calling tool task's scope, one member per nested call by its key: the nested task, and its result once it ended | Pi alone |

```ts
// Whether a conversation is busy with a run, and why its newest run ended without an answer.
const runOf = (conversationId: ConversationId) =>
	Effect.map(Harness.snapshot(BuiltinDoc.live, conversationId), (live) => {
		const state = Option.getOrUndefined(live);
		return { busy: state?.run !== undefined, failure: state?.runFailure?.reason };
	});

// In a commit the document is read at the point the commit holds, so a check and a write go together.
const noteWhenIdle = (conversation: Conversation.Conversation, text: string, at: Date) =>
	conversation.commit((tx) =>
		Effect.gen(function* () {
			const live = yield* (yield* tx.doc(BuiltinDoc.live, conversation.id)).get;
			if (live.run !== undefined) return false;
			yield* tx.append(Note, conversation.id, { data: { text, at } });
			return true;
		}),
	);
```

- **No validation.** A value is passed through as Pi stored it and typed as Pi's own type (`LiveState`, `UsageState`,
  and the others, from `@earendil-works/pi-durable`). No schema of this package is applied, so nothing Pi wrote is
  ever rejected, a field of a later Pi included.
- **Writes.** A product must not write `pi.live`, `pi.provider`, `pi.usage` or `pi.inbox`: Pi's built-in tasks own
  them. `set` and `update` of one of them opened in a commit fail with `SchemaDecodeError` and store nothing; its
  `draft` is Pi's own and unguarded, so leave it alone. A product may write `pi.agent`: `Conversation.configure` and
  `tx.configure` are Pi's own writer, which checks the change, and `set` on `BuiltinDoc.agent` writes the value
  unchecked.
- **Reading in a commit** gives the value at the point the commit holds, so a check and a write go together. A value
  read outside a commit may be ahead of storage: Pi shows a streamed partial answer at once and stores it a little
  later (its deferred commits).
- **`snapshotAsOf`** takes `BuiltinDoc.agent` only, the one that keeps its history: the agent a fork at an entry
  would start with.

## Entry

`Entry.make(kind, schema)` defines an entry kind of your own, as Pi's `defineEntry`, with its data typed by `schema`.
`tx.append(Note, conversationId, { data })` appends one; `tx.entryOf(Note, id)` and a hook's `api.entryOf(Note, id)`
read one back; and `Note.read(record)` types any stored record, for example of `Conversation.entries`: none for
another kind. `Entry.collect(Note)` is the `Sink` of a stream of records that keeps those of the kind, decoded and in
order: `Stream.run(root.entries({ order: "ascending" }), Entry.collect(Note))`.

## Submission

`status` reads the committed record; `wait` succeeds once it settled, `done` or `unanswered` (both are success: read
`status` and `reason`); `abort` withdraws it while it is queued, and says what it found (`Submission.AbortResult`,
Pi's own answer). A `requestId` makes a retried `submit` find the submission it already admitted.

`Submission.settled(status)` says whether a submission in that status is settled (`done`, `unanswered`) or open
(`queued`, `placed`): the one place that reads Pi's statuses so, typed by Pi's `SettledSubmissionRecord`, so a status
Pi adds fails to compile there until it is decided.

## Storage

| | |
|---|---|
| `Storage.memory` | Pi's `MemoryStorage`, fresh per build of the Layer |
| `Storage.sql({ prefix })` | Pi's SQLite storage on the `SqlClient` of the context: any Effect client with the SQLite dialect (`@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, wasm, Durable Objects). Building it applies Pi's migrations |
| `Storage.sqlite(database, { prefix })` | Pi's SQLite storage on a Chord `SqliteDatabase` (`@effectified/pi-chord/sqlite`), such as a Rivet actor's. Pi's storage closes the database with itself |
| `Storage.custom(storage)` | A Pi `Storage` of your own, or an Effect that opens one |

Pi's other storages are Layers of their own subpaths (see [Subpaths](#subpaths)): `indexedDb` in a browser, `jsonl`
on any environment's file system, `nodeJsonl` and `nodeSqlite` on the local disk, `durableObject` in a Cloudflare
Durable Object.

```ts
import { SqliteClient } from "@effect/sql-sqlite-node";

const storage = Storage.sql({ prefix: "pi_" }).pipe(Layer.provide(SqliteClient.layer({ filename: "./session.sqlite" })));
```

`Storage.sql` passes Pi's storage conformance suite on both drivers.

## Tool

`Tool.make(name, { description, parameters, success, replay, callers, handler })`. The tool's `name` is a `ToolName`,
the brand this package gives tool names, so an extension's name or another string is never taken for one: it is what
`Agent.Change.tools`, a nested call (`api.executeTool`) and `Tool.wrap` take. `Tool.make` and Pi's tools of `/tools`
brand their own; `ToolName.make("read")` brands a literal. Each call runs in a span, `Tool.execute`, with the tool's
name, the call's id, its task and its conversation. Pi validates a call against the
JSON Schema of `parameters`; the handler gets the decoded value and returns an `Effect`. The model reads a string
result as it is and anything else as JSON. A handler failure, and arguments the schema rejects, become an error result
the model reads, so the run goes on; a defect becomes Pi's own `tool_error` result. `replay: "safe"` lets Pi run the
handler again when a close or a crash cut it off; the default, `unsafe`, never runs it twice: Pi writes an
`interrupted` result instead.

The handler's second argument is Pi's api for the call, in Effect terms:

| | |
|---|---|
| `taskId`, `conversationId`, `callId` | The call's task, its conversation, the id the model gave it |
| `commit(body, options?)` | A commit of the call's task (see [Commits](#commits)) |
| `memo(name)`, `memo(name, candidate)` | A first-writer-wins value of the task: an idempotency key that survives a rerun |
| `readSignal(signal, key)`, `wake`, `checkpoint`, `now` | What a parked call reads when it runs again |
| `snapshot`, `snapshotAsOf` | Committed documents |
| `agent` | What the calling conversation runs with |
| `conversation(id)` | A handle (`submit`, `admit`, `abort`, `waitForIdle`) for a conversation, such as one it created |
| `executeTool(name, args, options?)`, `startTool(…)` | A nested call: waited for, or started to park on |
| `details(value)`, `diagnostic(remark)` | Running details for a UI, a remark for the model |
| `pi` | Pi's own api, for running output, child tasks and the environment |

A handler succeeds with its success value, or with a reply for more:

| | |
|---|---|
| `Tool.result(value, { details, usage, control, diagnostics, output })` | The success value, with what Pi stores beside it. The model never reads `details` |
| `Tool.error(text, { details, … })` | An error result the model reads, decided by the handler |
| `Tool.sleep({ signals, until, checkpoint })` | Park until a signal or a time; the handler then runs again |
| `Tool.wait({ on, policy, checkpoint })` | Park until tasks the call owns have ended |

```ts
// The model reads the titles; a host reads the raw response from the stored result.
const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.Struct({ titles: Schema.Array(Schema.String) }),
	handler: ({ query }) =>
		Effect.map(Web.use((web) => web.search(query)), (raw) =>
			Tool.result({ titles: raw.hits.map((hit) => hit.title) }, { details: raw }),
		),
});

// A subagent: a conversation owned by the call's task, created in its commit. A rerun finds the same child.
const Subagent = Tool.make("subagent", {
	description: "Delegate a self-contained task to a subagent and get its answer back.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	replay: "safe",
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// It starts as a copy of this conversation's agent; without the subagent tool itself.
					yield* tx.configure(created.id, { tools: { remove: [ToolName.make("subagent")] } });
					return created.id;
				}),
			);
			yield* api.details({ conversationId: child }); // lets a UI attach to the child
			const handle = Option.getOrThrow(yield* api.conversation(child));
			const submission = yield* handle.submit({ type: "input", content: task, requestId: `subagent:${api.taskId}` });
			const settled = yield* submission.wait;
			return settled.status === "done" ? "The subagent answered." : Tool.error(`No answer: ${settled.reason}`);
		}),
});
```

`structured: true` also gives programs that call the tool (a nested call, a code mode script) the success value as
JSON, Pi's `structuredOutput`. `cancel(params, api)` cleans up the outside work of a call aborted while parked.

The other options of Pi's `defineTool` are passed on unchanged: `executionMode` (`sequential` makes the whole round
run one call after another), `deferred` (not offered to the model until the conversation's `modelTools` names it),
`prepareArguments` (repairs the arguments the model sent, before Pi validates them), `outputLimits` (how much of the
output the model reads, and which end is kept) and pi-ai's `constrainedSampling`.

`Tool.fromToolkit(toolkit)` gives the tools of an `effect/ai` `Toolkit` as tools of this package, each made by
`Tool.make` from the toolkit's own tool and run by the handler the toolkit's Layer gives it (`toolkit.toLayer`), which
the registry Layer then requires. The model reads the encoded result; a failure a tool returns
(`failureMode: "return"`) is an error result, and one it fails with a `tool_error` result. Tools a provider runs, and
dynamic tools, are left out.

```ts
const GetWeather = AiTool.make("get_weather", {
	description: "The weather in a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number }),
});
const WeatherTools = Toolkit.make(GetWeather);

const weather = Registry.layer([Extension.make({ name: "weather", tools: Tool.fromToolkit(WeatherTools) })]).pipe(
	Layer.provide(WeatherTools.toLayer({ get_weather: ({ city }) => Effect.succeed({ temperature: city.length }) })),
);
```

A call creates and reads tasks through its api: `createTask(task, input, options)` in a commit of its own,
`getTask(id)` and `waitForTask(id)`. With `options.key` the task is created once for that key: a rerun of a
replay-safe handler, or a run after a park, gets the same task back. A child of the call is
`ownership: { kind: "task", taskId: api.taskId }`; park on it with `Tool.wait`.

## Agent

What a conversation runs with is Pi's stored agent. `configure`, `fork`, `createConversation`, `rootWith` and
`tx.configure` take an `Agent.Change`: Pi's `AgentChange`, with every tool given as a `Tool` of this package, as Pi's
own registration, or as its `ToolName`, and every extension as an `Extension`, as Pi's own object, or as its name. Pi
stores names. An extension is never taken for a tool: its name is no `ToolName`.

```ts
// Exactly these two tools, whatever else the selected extensions bring.
yield* root.configure({ tools: [Lookup, ToolName.make("read")] });
// Of those, the model is offered only `lookup`; a tool may still call `read`.
yield* root.configure({ modelTools: [Lookup] });
yield* root.configure({ tools: null }); // back to the host default
```

A name nothing is registered under is stored and offers nothing until an extension brings that tool.

`Agent.Change` is derived from Pi's `AgentChange` field for field, so a field Pi adds is one of `Change` at once.
`Agent.byName(change)` gives its JSON form, every tool and extension by its name, and `Agent.ByName` is the schema of
that form, to keep a change in stored state or send it to another process and decode it back into a change
`configure` takes (decoding brands the tool names); its thinking levels are pi-ai's own list, and its numbers those
Pi's `configure` accepts.
`Agent.ModelRef` is the schema of the model a change names (`@effectified/pi-ai`'s `ModelRef`, Pi's `ModelRef`).

## Extension and Registry

`Extension.make({ name, namespace, tools, hooks, tasks, sections, wraps })` types a named bundle; a plain object works
too. `Registry.layer(extensions)` installs them in a fresh Pi registry. The Layer requires the union of what every
tool handler, hook handler, task phase, section and wrapper needs (`Extension.Services`) and captures it when it is
built. By default every
conversation selects every installed extension, in order; a task is found by its name whichever conversations select
its extension. The service value is Pi's own registry, so Pi extensions can be installed in it as well.

In a Chord app the extensions may come from plugins instead: a Chord registry whose composition is a Pi registry
snapshot. `Registry.reader(value)` (Pi's `registryReader`) reads such a registry value (`Host.registry` of
`@effectified/pi-chord`) for the life of the scope, and `Harness.layerOn(reader, options)` opens the harness on it in
place of the `Registry` service. A new composition wakes the harness to reconsider blocked tasks.

### Prompt sections and wrappers

A section is a part of the system prompt an extension renders before each request of a conversation that selects it.
A wrapper changes a tool or a section of any extension, wherever the wrapping extension is selected.

```ts
// A section that renders from a service, and a wrapper that audits every call of `lookup`.
class Policy extends Context.Service<Policy, { readonly text: string }>()("app/Policy") {}

const rules = Section.make("rules", () => Policy.use(({ text }) => Effect.succeedSome(text)));

const audited = Tool.wrap(Lookup.name, (tool) => ({
	execute: (args, api) => Effect.tap(tool.execute(args, api), () => Effect.logInfo(`lookup ${api.callId}`)),
}));

const governed = Extension.make({ name: "governed", sections: [rules], wraps: [audited] });
```

| | |
|---|---|
| `Section.make(key, render, { tag? })` | `render` gets the request's input (its agent, environment, committed reads as Effects) and gives `Option` of the text, tagged `<key>` unless `tag` is false. A failing render is reported and the request keeps the text the section showed before |
| `Section.wrap(key, wrapper)` | The wrapper gets the section, its render as an Effect, and gives the render that replaces it |
| `Tool.wrap(name, wrapper)` | The wrapper gets Pi's tool and its execution as an Effect, and gives fields that replace the tool's and the execution. It passes `api` on and returns the wrapped execution's park as it is; a failure is Pi's `tool_error` result |

Wrappers are applied when the registry composes, so they must be pure; what they run runs at each call.

## Hook

One constructor per hook of Pi's built-in tasks. A handler gets Pi's arguments and an `api`, and returns an `Effect`;
where Pi's hook may answer or not, the Effect succeeds with an `Option`.

| Constructor | Asked | `Option.some` |
|---|---|---|
| `Hook.beforeRequest` | Before every model request attempt | Replaces the messages of that request |
| `Hook.beforeProviderRequest` | When pi-ai built the provider request body | Replaces the body |
| `Hook.afterResponse` | At every terminal provider message | (observer) |
| `Hook.onYield` | At a final answer; the first answer wins | Continues the run, or asks for deciding tasks |
| `Hook.afterTools` | When every tool of a round is done | Asks for tasks to run before the round ends |
| `Hook.afterRun` | After a run answered | Asks for tasks the run waits for |
| `Hook.beforeCompact` | Before a compaction summarizes | Declines it, or gives the summary |
| `Hook.beforeTool` | Before a tool call runs | (returns a `Gate`) |
| `Hook.afterTool` | Before a tool result is committed | Replaces the result |

- The `api` reads, it does not write: `taskId`, `conversationId`, `now`, `memo(name)` and `memo(name, candidate)`
  (first writer wins), `readSignal(signal, key)`, `entry(id)`, `entryOf(entry, id)`, `entries(query)`,
  `snapshot` and `snapshotAsOf` for documents, and `pi`, Pi's own api.
- A hook gets no commit. It answers, and the asking task commits the decision; a memo is a commit of its own. What a
  hook writes elsewhere is not atomic with the step and runs again when Pi asks again. Durable work after a step is a
  task returned from `afterTools`, `onYield` or `afterRun` (see [Hook tasks](#hook-tasks)): Pi creates those once, in
  a commit after the hook answered. What exists exactly when a step does is the step's own record, its entry.
- A hook that fails, with a failure or a defect, reaches Pi as a throwing hook does: Pi reports it
  (`extension_error`) and skips it, and the run goes on. `beforeTool` is the exception: its failure blocks the call
  with the error's message, so a gate fails closed.
- Pi asks a hook again after a crash or a close that came before its answer was committed, and asks `beforeTool`
  again on every wake of a parked call. Keep what a handler does outside idempotent.
- When Pi aborts the hook's invocation, the handler's fiber is interrupted.
- Each ask runs in a span named for the hook (`Hook.beforeTool`, ...), with the asking task, its conversation, and for
  the tool hooks the tool's name and the call's id.

### Hook tasks

`Hook.task(task, input)` makes the task an `onYield`, `afterTools` or `afterRun` handler asks for (Pi's `hookTask`).
The generation creates the tasks as its children in one commit and waits for them, so a stop aborts them and a crash
resumes them; once they exist, the hook is not asked again. A task asked for from `onYield` decides whether the
answer stands, while the run's inputs are still open: its result schema is `Hook.YieldDecision`, and it completes
with `Hook.stand` or `Hook.continueWith(input)`. `input` is text, or a list of at least one text or image item: Pi
ignores an empty list, so `continueWith([])` does not compile, and a result that holds one anyway fails to encode
and ends its task `faulted`. One asked for from `afterTools` has the result schema
`Hook.AfterToolsDecision` and completes with `Hook.proceed` or `Hook.terminate`. `afterRun` tasks act on an answer
that stands; their result is their own.

```ts
const Verdict = Entry.make("review.verdict", Schema.Struct({ approved: Schema.Boolean, note: Schema.String }));

// A review: a second opinion on every answer, kept as an entry, that may send the agent back to work.
const Review = Task.make({
	name: "review.review",
	version: 1,
	input: Schema.Struct({ answer: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("review") }),
	result: Hook.YieldDecision,
	initial: () => ({ phase: "review" as const }),
	phases: {
		review: (task, api) =>
			Effect.gen(function* () {
				// A memo: a phase that runs again after a crash does not ask the reviewer twice.
				const kept = yield* api.memo<{ approved: boolean; note: string }>("review.verdict");
				const verdict = Option.isSome(kept)
					? kept.value
					: yield* Effect.flatMap(
							Reviewer.use((reviewer) => reviewer.judge(task.input.answer)),
							(given) => api.memo("review.verdict", given),
						);
				// The verdict entry and the task's decision are stored together.
				return yield* api.commit((tx) =>
					Effect.as(
						tx.append(Verdict, api.conversationId, { data: verdict }),
						Task.complete(
							verdict.approved ? Hook.stand : Hook.continueWith(`A reviewer objected: ${verdict.note}`),
						),
					),
				);
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const Reviewed = Extension.make({
	name: "review",
	tasks: [Review],
	hooks: [
		Hook.onYield((answer) =>
			Effect.map(Hook.task(Review, { answer: textOf(answer) }), (request) =>
				Option.some({ kind: "tasks" as const, tasks: [request] }),
			),
		),
	],
});
```

The first `onYield` task, in the order they were asked for, that completes with a `continue` sends the agent back to
work in the same run, unless a user message or a reset was queued meanwhile. `Submission.wait` and every caller see
only an answer the tasks let stand. Pi sets no limit on such loops: the extension counts its corrections itself.

## Gate

What a `beforeTool` handler returns:

| | |
|---|---|
| `Gate.allow` | The call goes on to the next hook, and runs when none stops it |
| `Gate.block(reason)` | The call does not run; the model gets an error result with the reason |
| `Gate.rewrite(args)` | The call goes on with other arguments, which Pi validates again |
| `Gate.park({ signals, until })` | The call sleeps, holding no process, until a signal arrives or the harness clock reaches `until` (epoch milliseconds) |

A park needs a signal, a deadline, or both. A wake asks every `beforeTool` hook again from the first, so a gate reads
its key and then allows, blocks, or parks on a new key. Fix a deadline once, in a memo.

## Signal

`Signal.make(name, version, schema)` defines a typed value delivered to a live task from outside. The value is encoded
to JSON when sent and decoded when read, both through `schema`.

```ts
const Approval = Signal.make("approvals.decision", 1, Schema.Struct({ allow: Schema.Boolean }));

const Approvals = Hook.beforeTool((call, api) =>
	Effect.gen(function* () {
		if (call.name !== "write") return Gate.allow;
		const until = yield* api.memo("approvals.until", (yield* api.now) + 24 * 60 * 60 * 1000);
		const state = yield* api.readSignal(Approval, call.id);
		// Nothing came yet: show the question somewhere, with `api.taskId` and the key, and park.
		if (Option.isNone(state)) return Gate.park({ signals: [Approval.key(call.id)], until });
		if (state.value.kind === "expired") return Gate.block("No approval within a day");
		return state.value.value.allow ? Gate.allow : Gate.block("Not approved");
	}),
);

// Whatever shows the question delivers the answer: "delivered", "duplicate", "invalid", "closed" or "not_found".
const decide = (taskId: TaskId, callId: string) => Harness.signal(taskId, Approval, callId, { allow: true });
```

A parked call survives a close and a reopen. A value outside the schema fails `Harness.signal` with
`SchemaDecodeError` before anything is stored. Nothing checks who sends a signal: authenticate senders in your host.

### Reading a key from outside the task

```ts
// From outside the task: none while the call waits for its decision, and once the call ended.
const decision = (taskId: TaskId, callId: string) => Harness.signalState(taskId, Approval, callId);
```

`Harness.signalState(taskId, signal, key)` reads a key's state from the task's stored record, decoded as the task's
own `readSignal` gives it: `Option.none` while nothing came, a value, or `expired`. `Signal.stateIn(record, signal,
key)` reads it from a record you already hold: one of `Harness.inspect`, of `Harness.getTask`, of `tx.task` in a
commit, and fails only with `SchemaDecodeError`: it decodes the memo and the value with schemas and needs no Pi token.
`Signal.stateIn(signal, key)` is the same, data-last, for a pipe over the record. Pi has
no call for this. Both read the memo Pi keeps a key's state in, `pi.signal.<signal name>/<key>`, which
Pi's specification (5.7) describes: a convention of Pi's stored data, not an API, so a later Pi may change it. Pi
drops a task's memos with its outcome: for a task that ended the state is none.

### SubmissionSettled

`Signal.SubmissionSettled` is Pi's built-in signal `pi.submission-settled`. A submission made with
`notify: { taskId, key }` (a field of every draft `submit`, `admit` and `prompt` take) delivers its settled record,
what `Submission.wait` succeeds with, to that task under that key, in the commit that settles it. So a task or a tool
call can sleep on the answer of another conversation and hold no process meanwhile:

```ts
// A subagent that holds no process while the child works: the call parks until the child's submission settled.
const Delegate = Tool.make("delegate", {
	description: "Delegate a self-contained task to a subagent and get its answer back.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			// After the wake the settled record is here: what `Submission.wait` would have given.
			const settled = yield* api.readSignal(Signal.SubmissionSettled, api.callId);
			if (Option.isSome(settled)) {
				return settled.value.kind === "value" && settled.value.value.status === "done"
					? "The subagent answered."
					: Tool.error("The subagent gave no answer.");
			}
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					yield* tx.configure(created.id, { tools: { remove: [ToolName.make("delegate")] } });
					return created.id;
				}),
			);
			const handle = Option.getOrThrow(yield* api.conversation(child));
			// `notify` delivers the settlement to this call's task, under the key the call parks on.
			yield* handle.submit({
				type: "input",
				content: task,
				requestId: api.callId,
				notify: { taskId: api.taskId, key: api.callId },
			});
			return Tool.sleep({ signals: [Signal.SubmissionSettled.key(api.callId)] });
		}),
});
```

A task does the same with `Task.sleep({ state, signals: [Signal.SubmissionSettled.key(key)] })` and reads the record
in the phase its state names. A submission that settles before the sleep is stored wakes it at once. The value is
Pi's own record type and is passed through: Pi checks a value delivered by hand against its own schema and answers
`invalid` for another shape.

## Task

`Task.make(definition)` defines a durable task, as Pi's `defineTask`: a small state machine whose state is stored at
every step, so a harness opened later continues it where it stopped. Input, state and result are Effect `Schema`s,
encoded when stored and decoded for every handler; each phase is an `Effect` that returns the task's step.

```ts
// A payment: `charge` asks the bank, `confirm` completes with the receipt.
const Payment = Task.make({
	name: "app.payment",
	version: 1,
	input: Schema.Struct({ card: Schema.String }),
	// One member per phase. The `phase` picks the handler; the rest is what the phase needs to go on.
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("charge") }),
		Schema.Struct({ phase: Schema.Literal("confirm"), receipt: Schema.String }),
	]),
	result: Schema.Struct({ receipt: Schema.String }),
	initial: () => ({ phase: "charge" as const }),
	phases: {
		// Pi runs a phase again from its top after a crash: the charge is keyed by the task, so a repeat is harmless.
		charge: (task) =>
			Effect.map(
				Bank.use((bank) => bank.charge(task.input.card, `payment-${task.id}`)),
				(receipt) => Task.next({ phase: "confirm" as const, receipt }),
			),
		confirm: (task) => Effect.succeed(Task.complete({ receipt: task.state.receipt })),
	},
	// Runs instead of the phases after `Harness.abortTask`, and decides the outcome.
	abort: () => Effect.succeed(Task.aborted()),
});

// A checkout creates one payment per card as its children, in the commit that stores its wait for them.
const Checkout = Task.make({
	name: "app.checkout",
	version: 1,
	input: Schema.Struct({ cards: Schema.Array(Schema.String) }),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("pay") }),
		Schema.Struct({ phase: Schema.Literal("decide"), payments: Schema.Array(Task.Id) }),
	]),
	result: Schema.String,
	initial: () => ({ phase: "pay" as const }),
	phases: {
		pay: (task, api) =>
			api.commit((tx) =>
				Effect.gen(function* () {
					const payments = yield* Effect.forEach(task.input.cards, (card) =>
						tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }),
					);
					// Resume in `decide` once every payment ended; the first failure aborts the others.
					return Task.wait({ state: { phase: "decide" as const, payments }, on: payments, policy: "failFast" });
				}),
			),
		decide: (task, api) =>
			Effect.map(api.outcomesOf(Payment, task.state.payments), (outcomes) =>
				outcomes.every((outcome) => outcome.status === "completed")
					? Task.complete("order placed")
					: Task.fail({ message: "payment failed" }),
			),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

// Tasks are installed with an extension. The registry Layer now requires `Bank`, which `charge` needs.
const Shop = Extension.make({ name: "shop", tasks: [Payment, Checkout] });

const placeOrder = (cards: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		const id = yield* root.commit((tx) =>
			tx.createTask(Checkout, { cards }, { ownership: { kind: "conversation" } }),
		);
		return (yield* Harness.waitForTaskOf(Checkout, id)).state.outcome;
	}); // Effect<TaskOutcome<string>, DurableError | SchemaDecodeError, Harness>
```

- **Definition.** `name` and `version` are stored; `initial(input)` gives the first state, synchronously, in the
  commit that creates the task; `migrate(input, state, fromVersion)` is Pi's `migrate`, returning the current values.
  The schemas need no services, because Pi asks for the first state synchronously, and the `phase` of a state must
  encode to itself. A definition without a handler for every phase, or with one for an unknown phase, does not
  compile.
- **Creating.** `tx.createTask(task, input, options)` in any commit, with Pi's options: `ownership` is required
  (`{ kind: "conversation" }` for a top-level task, `{ kind: "task", taskId }` for a child, which lives in its
  owner's conversation), `conversationId` defaults to the conversation the commit is bound to, and `background` keeps
  a conversation-owned task out of idle waits and aborts. A commit has no key for exactly-once creation: a tool's
  `api.createTask` has one, and a task creates its children in the commit that stores the next state, which names
  them.
- **Reading.** `Harness.getTaskOf(task, id)` and `waitForTaskOf(task, id)` decode the result with the task's schema;
  `task.outcome(stored)` decodes any stored outcome. An outcome is Pi's: `completed` with the result, `failed` with an
  error, `aborted`, and the scheduler's `faulted` and `orphaned`. `Task.ended(status)` says whether a task in that
  status has ended: its outcome is decided, so it runs no more code, takes no signal and has no memos. That is
  `completing` (work it owns may still be live) and `terminal`; it is the one place that reads Pi's statuses so,
  typed by Pi's states, so a status Pi adds fails to compile there until it is decided.
- **A failing phase.** A phase that fails, with a failure or a defect, and one whose input, state or step does not
  match its schema, reaches Pi as a throwing phase: Pi ends the task `faulted` with the error's message, at once, and
  reports it (`task_faulted`, reason `threw`). Nothing is retried. An expected failure is an outcome the phase
  returns: `Task.fail`.
- **Crashes and the restart limit.** Pi counts a restart for every task that was running when a process died, and
  the phase runs again from its top; a close counts nothing. A new state the task commits starts the count over. Once
  the count reaches `settings.restartLimit` (default 5) Pi ends the task `faulted` with detail
  `{ reason: "restart_limit" }` instead of running it again. `task.record.restarts` is the count a phase reads.
- **Interruption.** When the task is aborted or the harness closes, the running handler's fiber is interrupted. An
  abort then runs `abort`, once the work the task owns has ended; a close leaves the task for the next open.
- **Services.** What the phases and `abort` need joins the requirements of `Registry.layer`, as for tools and hooks.
- **Tracing.** Each phase runs in a span, `Task.phase` (`Task.abort` for the abort handler), with the task's kind, its
  phase, its id and its conversation.

### Steps

What a phase returns, and what the body of `api.commit` returns:

| Constructor | The task |
|---|---|
| `Task.next(state)` | Goes on at `state`: another phase, or progress within the same one |
| `Task.sleepUntil(until, state)`, `Task.sleep({ state, until?, signals? })` | Sleeps, holding no process, until the harness clock reaches `until` or a signal arrives, then resumes at `state`; `task.wake` says why |
| `Task.wait({ state, on, policy })` | Waits for tasks, then resumes at `state`. Pi's policies: `allSettled` (all ended), `failFast` (the same, and the first failure aborts the others), `any` (the first one ended) |
| `Task.complete(result)`, `Task.fail(error, result?)`, `Task.aborted(reason?, result?)` | Ends with that outcome. Pi holds it as `completing` until the work the task owns has ended |
| `Task.unchanged` | In a commit body only: stores the body's other writes and leaves the state |

A phase must change the state or end the task: Pi faults one that returns without progress. There is no sleep inside
a phase, because a phase runs again from its top: what comes after a wait belongs in the phase the next state names,
and what it needs in that state. `on` may name tasks the waiting task does not own, with `allSettled` or `any`.

### The task api

The second argument of a handler is Pi's runtime for that invocation, in Effect terms:

| | |
|---|---|
| `taskId`, `conversationId`, `now`, `agent` | The task, its conversation, the harness clock, what the conversation runs with |
| `commit(body, options?)` | A commit of the task: the step the body returns is stored with what it wrote |
| `commitReturning(body, options?)` | The same, for a body that returns `{ step, value }`: it succeeds with the value |
| `memo(name)`, `memo(name, candidate)` | A first-writer-wins value kept while the task can run |
| `readSignal(signal, key)` | The value a sleep on a signal woke for |
| `getTask(id)`, `waitForTask(id)`, `ownedTasks`, `abortOwned(id)` | Other tasks: a record, a wait that holds the invocation, the live children, an abort of one |
| `outcomes(ids)`, `outcomesOf(task, ids)` | The outcomes of ended tasks, as stored or with their results decoded: for after a wait |
| `conversation(id)` | A handle to submit to a conversation, or to admit a submission inside the task's commit |
| `entry`, `entryOf`, `entries`, `context`, `snapshot`, `snapshotAsOf` | Committed reads |
| `report(error, from?)` | Hands a failure that does not fail the task to the harness's reports |
| `eachHook(hooks, name, ask)` | Asks the task's own hook `name` of every selected extension that answers it (see [A task's own hooks](#a-tasks-own-hooks)) |
| `timer(millis)` | Waits on the harness's timer (so its `Clock`), for pacing inside a phase; not durable |
| `watchDoc(doc, …address)` | A document watch from inside the task, as `Harness.watchDoc`; a tool's api has it too |
| `pi` | Pi's own runtime: the models (`pi.models`), the settings, the registry snapshot, the environment |

Pi's rules for a task's commit: it rejects when the task ended, the invocation ended, the harness is closing, or,
outside the abort handler, the task was marked for abort. The step replaces the task's state in the same commit, so
it is stored with the entries, documents and child tasks the body wrote, or not at all. Entries the body appends
carry the task's id, and `tx.createTask` defaults to the task's conversation. A sleep or a wait ends the invocation.
A child needs a live owner: Pi rejects one for an owner that has ended, holds an outcome, or is marked for abort, so
an abort handler creates none. The rules of [Commits](#commits) hold for the body.

`api.commit` succeeds with `Task.committed`, because its body's value is the step. `api.commitReturning` is for a
body that also has something to hand back, such as what it read:

```ts
// Starts a payment unless two are already under way. The count is read in the commit that acts on it, and the phase
// has it afterwards.
const Throttled = Task.make({
	name: "app.throttled",
	version: 1,
	input: Schema.Struct({ card: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("start") }),
	result: Schema.Struct({ started: Schema.Boolean }),
	initial: () => ({ phase: "start" as const }),
	phases: {
		start: (task, api) =>
			Effect.gen(function* () {
				const underWay = yield* api.commitReturning((tx) =>
					Effect.gen(function* () {
						// Table reads come before the first table write.
						const query = { conversationId: api.conversationId, kind: Payment.name, status: "pending" } as const;
						const { items } = yield* tx.scanTasks(query, 2);
						const started = items.length < 2;
						if (started) {
							yield* tx.createTask(Payment, { card: task.input.card }, { ownership: { kind: "conversation" } });
						}
						return { step: Task.complete({ started }), value: items.length };
					}),
				);
				yield* Effect.logDebug(`payments under way: ${underWay}`);
				return Task.committed;
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});
```

A tool's `api.commit`, `Harness.commit` and `Conversation.commit` succeed with their body's value as they are.

### A task's own hooks

A task may ask extension code questions of its own, as Pi's built-in tasks ask theirs. `TaskHooks.make` types them for
a task kind, `TaskHooks.answer` answers them in an extension, and `api.eachHook` asks every answer, in extension order.
A failing answer is reported and the next is asked: a hook fails open.

```ts
const ReviewHooks = TaskHooks.make<{ readonly check: (text: string) => Effect.Effect<boolean> }>({ name: "app.review" });

const Review = Task.make({
	name: "app.review",
	version: 1,
	input: Schema.Struct({ text: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("ask") }),
	result: Schema.Boolean,
	initial: () => ({ phase: "ask" as const }),
	phases: {
		ask: (task, api) =>
			Effect.gen(function* () {
				let passed = true;
				yield* api.eachHook(ReviewHooks, "check", (check) =>
					Effect.map(check(task.input.text), (ok) => {
						passed &&= ok;
					}),
				);
				return Task.complete(passed);
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const strict = Extension.make({
	name: "strict",
	hooks: [TaskHooks.answer(ReviewHooks, { check: (text) => Effect.succeed(text.length < 280) })],
});
```

## Watches

Pi's watches are Streams. Each starts with the value at attachment, then gives one `Watch.Change` per change:
`value` (the newest committed value), `ops` (the Chord operations from the element before) and `retired`. Closing
the stream's scope releases Pi's watch.

```ts
// A UI: one conversation's transcript window and built-in documents (`pi.live`, `pi.inbox`, `pi.usage`).
const answers = root.changes().pipe(
	Stream.map((change) => change.value.entries.filter((entry) => entry.kind === "pi.assistant").length),
	Stream.changes,
);
// One of your own documents, decoded.
const counts = Stream.map(Harness.watchDoc(Todos, root.id), (change) => change.value.items.length);
```

| | |
|---|---|
| `Conversation.changes(window?)` | Pi's `watch`: the conversation's view. `window` bounds its entries (newest 50, up to 100) |
| `Harness.watchDoc(doc, …address)` | Pi's `watchDoc`, decoded. No element when the address holds no document |
| `Harness.taskGraph` | Pi's `watchTaskGraph`: every live task with its owner and status |
| `Harness.commits`, `Harness.attachCommits` | Pi's `observeCommits`: every stored commit with what it stored; `attachCommits` attaches now, for a reader of stored state (see [Stored commits](#stored-commits)) |
| `Harness.observeDoc`, `Harness.observeConversation(id, window?)`, `Harness.observeTaskGraph` | Pi's synchronous observers: every commit one element, unfolded and in order, however slow the consumer (they wait in memory) |
| `Harness.closing`, `Harness.closed` | Succeed when the harness begins to close, and once it has closed, with why (`closed`, or `failed` with the storage error) |
| `Transcript.stream(conversation, { window, pageSize })` | A conversation's view kept as the client's whole transcript (Pi's `ConversationTranscript`): each element has the transcript, whose `loadEarlier` and `fillGap` load what the window left out |

Pi delivers one change at a time and folds the commits that land meanwhile into the next, so a slow consumer gets
fewer, larger changes and always the newest value. A watch is not a log of every commit. A stream ends when the
harness closes, and fails when the harness failed. It also fails when Pi delivers a `failed` call (its value cannot
be computed now), which Pi Durable 1.6 never does: an element carries no failure, so the stream does not go on
silently. Retry the stream to watch again from the value then.

### Stored commits

`Harness.commits` is the log a watch is not: Pi's `observeCommits` as a Stream.

```ts
// An outbox: every entry of every conversation as it is stored, in commit order.
const storedEntries = Stream.flatMap(Harness.commits, (commit) =>
	Stream.fromIterable(commit.changes.flatMap((change) => (change.type === "entry" ? [change.value] : []))),
);
```

- **One element** is one storage transaction, Pi's `CommitPublication`: its `seq`, the sequence number storage gave
  it, and `changes`, everything it stored, in no particular order. A change is a whole table record that was written
  (`type` `conversation`, `entry`, `task` or `submission`, the record in `value`), or a document change: `document`
  with `kind: "change"` (its `record`, its `conversationId`, the new `value`, its `version` and the Chord `ops` that
  led to it; no `ops` for a creation) or `kind: "retire"`, or `document.copy` for a document a fork starts with.
- **What is not an element:** a commit stored before the stream ran, a commit that wrote nothing, and a deferred
  commit (a streamed partial answer) until it is stored, with the commit or the deadline that stores it. So `seq` has
  gaps, and after a restart a consumer catches up from storage (`Harness.scanConversations`, `entries`).
- **A slow consumer** never holds the harness up. Pi calls the observer on its line of commits, and the observer only
  puts the publication into a queue. The queue has no bound: elements wait in memory until taken, each holding the
  records Pi stored, not copies. A consumer that stops taking makes memory grow by what is committed meanwhile.
- **The end.** It fails with `UnexpectedError` ("session closed") when the harness closes, as Pi ends its observers,
  and with the harness's own failure when it failed. Closing the stream's scope detaches the observer.
- **Attached now.** `Harness.commits` attaches its observer when the stream starts to run, in whatever fiber runs it.
  A consumer that reads stored state and then follows what changes it takes `Harness.attachCommits`, an Effect on the
  scope: once it succeeded the observer is attached, and every commit stored from then on is an element of the Stream
  it gives, also one stored while the consumer reads. Run that stream once.

## Scans and idle reads

Pi scans its tables only inside a commit. These read without a commit of your own: each page, and each record, is
read in a commit that writes nothing, which a read-only harness allows too.

```ts
// The conversations a task owns, the sleeping tasks of one kind, and where a conversation came from.
const ownedBy = (taskId: TaskId) => Stream.runCollect(Harness.scanConversations({ ownerTaskId: taskId }));
const sleeping = (kind: string) => Stream.runCollect(Harness.scanTasks({ kind, status: "sleeping" }));
const origin = (conversation: Conversation.Conversation) =>
	Effect.all({ parent: conversation.parent, owner: conversation.owner });
```

| | |
|---|---|
| `Harness.scanConversations(query?)` | A Stream of conversation records in id order. Pi's filters: `ownerTaskId`, `ownerConversationId`, `order`; and `pageSize` (default 100) |
| `Harness.scanTasks(query?)` | A Stream of task records in id order, ended ones included. Pi's filters: `conversationId`, `kind`, `status`, `abortRequested`, `background`, `order`; and `pageSize` |
| `Harness.conversationRecord(id)` | A conversation's record, an `Option`: its `id`, `parent` and `owner` |
| `tx.scanConversations`, `tx.scanTasks`, `tx.scanEntries` | One page, inside a commit of yours |
| `tx.conversations(query?)`, `tx.tasks(query?)` | The harness's two Streams, every page read inside a commit of yours: one point in time |

A stream reads a page when it is pulled, and each page is a commit of its own: a scan is not one point in time, so a
record created or changed while it runs may or may not appear. Read with `tx.conversations` or `tx.tasks` inside
one commit when that matters.

```ts
const waiting = {
	harness: yield* Harness.isIdle,
	conversation: yield* Harness.isConversationIdle(root.id),
};
```

`Harness.isIdle` and `Harness.isConversationIdle(id)` answer at once whether `Harness.waitForIdle` and that
conversation's `waitForIdle` would succeed now, and start no scheduling. Pi has no such call: they apply Pi's idle
rule (no live task that is not in the background, in the scope) to the live tasks of `Harness.inspect`, and read the
owners in a commit that writes nothing while any task is live. `Idle.quiet(live, scope, tx)` is the rule itself, for a
commit of yours. Idle is not what admission asks: `submit` finds a conversation busy while a run is going on, which is
`run` of its `pi.live` document.

## Hosts

What a host that embeds a harness needs, beside the storage and the clock.

```ts
const host = Effect.gen(function* () {
	// Failures that fail no call: a throwing hook, a faulted task, the error that failed the harness. Started at once,
	// it has subscribed when the fork returns, so it misses no report of what comes after.
	yield* Effect.forkScoped(
		Stream.runForEach(Harness.reports, (report) => Alerts.use((alerts) => alerts.send(report))),
		{ startImmediately: true },
	);
	// The host owns the wake-ups: arm an alarm from each value, and resume when it fires.
	yield* Effect.forkScoped(Stream.runForEach(Harness.wakes, (wake) => Alarm.use((alarm) => alarm.arm(wake))));
});
const onAlarm = Harness.resume;

const live = Harness.layer({
	hostWakes: true,
	// Runs in every commit that creates or forks a conversation.
	conversationCreated: (tx, conversation) => Effect.asVoid(tx.doc(Todos, conversation.id)),
});
```

- **Options passed on to Pi unchanged:** `telemetry`, `identity`, `env`. `conversationCreated(tx, conversation)` is
  an Effect on a `Tx`; what it needs is a requirement of the Layer, and its failure fails the creating commit.
- **`Harness.reports`** is a Stream of Pi's `Report`s, whole, for every subscriber from the moment it runs. The Layer
  also logs each report to the Effect logger it was built with: `storage_failed`, `task_faulted` and
  `migration_failed` at `Error`, the rest at `Warn`, with the kind, Pi's ids and names and the class of the error.
  Never the error's message, which may quote a prompt.
- **`hostWakes: true`** is Pi's `onWake`: Pi arms no timer for sleeping tasks, and every change of its wake state is
  an element of `Harness.wakes`, kept until taken (one consumer). `Harness.wake` reads the current value:
  `{ active, at? }`. `Harness.resume` is what the host runs when its own wake-up fires. Pi calls `onWake` after the
  commit that changed the value, so arm a recovery wake-up before a call that can start work.
- **`Harness.usageEvents(conversationId)`** observes that conversation's usage ledger (`pi.usage`) commit by commit:
  its value now, then one element for every commit that changed it, unfolded. `value` holds the conversation's totals
  after the commit, per `provider/model` and per tool name; `ops` say which counters the commit set. Pi adds a model
  response's usage in the commit that records it, an error or an aborted one too, so a failed attempt is an element.
  For the usage of one call as it happens, a `Hook.afterResponse` handler reads `message.usage`. The stream fails
  with `UnexpectedError` when the harness closes: Pi ends its observers so.
- **`ParentContext`** holds the Chord context every Pi call of a fiber is made under: its telemetry span, its values
  and its cancellation. Default: Chord's background context. Inside a tool or hook handler it is that invocation's.
  `@effectified/pi-chord/context` makes one from Effect: cancelled by a scope or by the Clock.

```ts
import { ChordContext } from "@effectified/pi-chord/context";

// Every Pi call of `program` is cancelled after thirty seconds of the Clock, and fails with `Cancelled`.
const bounded = Effect.scoped(
	Effect.flatMap(ChordContext.timeout("30 seconds"), (deadline) =>
		Effect.provideService(program, ParentContext, deadline),
	),
);
```

## Errors

A call into Pi fails with one of a closed union of tagged errors, `DurableError`: `ConversationBusy`,
`ConversationIdle`, `ReadAfterWrite`, `ReadOnlySession`, `SessionFailed`, `StorageRequestError`, `Cancelled` (Pi
cancelled a call the fiber did not interrupt) and `UnexpectedError` (anything else Pi rejects with, in `cause`).
`DurableError` is also the union's schema: `DurableError.match(error, { ... })` picks a handler per tag, and
`DurableError.guards` tests for one.
Every error class Pi Durable exports has its tag: the mapping is keyed by Pi's exports, so a class Pi adds fails to
compile until it has one. `conversationId` of `ConversationBusy` and `ConversationIdle` is Pi's `ConversationId`.
`Registry.layer` and signals add `SchemaConversionError`, and signals, documents and typed entries
`SchemaDecodeError`, both from `@effectified/pi-schema`. A commit also fails with whatever its body fails with.

## Interruption

- **The caller.** Interrupting an Effect of this package cancels Pi's call through its context, and the interruption
  completes once Pi settled the call. For a wait (`prompt`, `Submission.wait`, `waitForIdle`, `waitForTask`) that
  cancels only the wait: the submission and its run go on. An input Pi was handed is admitted even when the caller is
  interrupted meanwhile; a `requestId` finds it again. To stop the work, call `Conversation.abort` or
  `Harness.abortTask`.
- **Handlers.** When Pi aborts a tool call or a hook, the handler's fiber is interrupted, and its finalizers run
  before Pi goes on.
- **Close.** Closing the scope of `Harness.layer` closes the harness: running handlers are interrupted and what was
  not committed stays pending. Reopening the storage resumes it. A model request a close stopped is sent again; a
  tool call it stopped runs again only with `replay: "safe"`.

## Time

Pi's clock and timers are Effect's `Clock`, read when `Harness.layer` is built. Sleeps, retry backoffs and the
deadlines of parked calls are stored on that clock, so a `TestClock` moves them without real waiting, and every
process that opens one storage must use the same clock.

## Testing

`@effectified/pi-durable/testing` is what a test of an agent needs, with no provider:

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
  memory storage, `Models` and `ScriptedModels`. Give `storage` a SQLite storage to test a close and a reopen: every
  build of the Layer is a new harness on the same data.
- `TestHarness.layerWith({ registry, models, responses, storage, harness, provider })` is the same for a product
  that builds the registry itself or wraps the models (below).
- `TestHarness.sqlStorage(client, { prefix })` is Pi's SQLite storage on the `SqlClient` Layer you pass, for a
  restart test (below).
- `ScriptedModels` queues more responses while the test runs and counts the requests.
- `answer(text)` and `toolCall(name, args)` build turns; `held(turn)` holds one back until `release`, with `requested`
  to wait for, so a test can act while a run is busy. pi-ai's `fauxAssistantMessage`, `fauxText`, `fauxThinking` and
  `fauxToolCall` are exported too; a response may also be a function of the request.

### Pi's suites and benchmarks

`storageConformance(storage, expect)` and `envConformance(env, expect, options?)` give Pi's conformance cases for a
storage Layer of your own and for an execution environment, each case an Effect the test runner runs.
`Benchmark.seed`, `Benchmark.reads`, `Benchmark.writes` and `Benchmark.commitWrites` are Pi's storage benchmarks on the
storage of the context.

```ts
describe("my storage", () => {
	for (const testCase of Effect.runSync(storageConformance(myStorage, expect))) {
		it(testCase.name, () => Effect.runPromise(testCase.run));
	}
});
```

### With a registry and models of your own

`TestHarness.layer` builds the registry from your extensions and gives the harness the scripted models. A product
whose own Layer builds the registry (a guard), or whose Layer wraps the models (a budget, a router), passes those
Layers to `TestHarness.layerWith`:

```ts
const test = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const settled = yield* root.prompt("What is record 42 called?");
	return {
		settled,
		reached: yield* ScriptedModels.use((models) => models.callCount), // what reached the provider
		metered: yield* Meter.use((meter) => meter.requests), // what the product's own Models saw
	};
}).pipe(
	Effect.provide(
		TestHarness.layerWith({
			registry: Registry.layer([App]), // or the Layer of a guard, which builds the registry itself
			models: Metered, // a Layer<Models | Meter, never, Models>: it wraps the scripted Models
			responses: [toolCall("lookup", { id: "42" }), answer("It is called Answer.")],
		}),
	),
	Effect.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
);
```

- `registry` is any Layer that provides `Registry`; `models` is any Layer that provides `Models` and requires the
  `Models` it wraps, which is the scripted one. Both are optional. What either provides besides (a guard's service,
  a budget's events) is provided by the result, and what they require is required of you.
- `ScriptedModels` stays underneath: it scripts the responses and counts the requests that reach the provider.
- A Layer that needs the open harness goes over the result:
  `attach.pipe(Layer.provideMerge(TestHarness.layerWith(options)))`.

### A restart

Memory storage cannot be reopened. `TestHarness.sqlStorage` takes the `SqlClient` Layer of the driver the test runs
on, so the kit imports neither: with a database file, each build of a harness Layer on it is a new process on the
same data.

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

The test [`test/kit-restart.ts`](test/kit-restart.ts) runs this on both drivers.

## Subpaths

Each subpath of Pi Durable an application uses has one here, with the same name. Node's file system, processes and
SQLite are behind `node` subpaths.

| Subpath | Gives |
|---|---|
| `/env` | Pi's environment contract (`ExecutionEnv`, `Result`, `FileInfo`, ...): its failures as `FileFailed` and `ExecFailed`, `fromResult`, and `decodeText`, `decodeRange` and `scanLines` over Streams of bytes. `@effectified/pi-env` builds on it |
| `/env/node` | `make({ cwd })`: Pi's local environment, its commands killed when the scope closes |
| `/tools` | Pi's built-in tools as tools of this package: `read({ images })`, `write`, `edit`, `bash({ prepare })`, `powershell`, where `prepare` is an Effect; `coding()`, Pi's `coding-tools` extension |
| `/tool-search` | `tool` and `extension`: Pi's `tool_search`, which loads deferred tools |
| `/codemode` | `extension({ sandbox })` and `tool({ sandbox })` on a `Sandbox` of `@effectified/pi-codemode`; `store`, the document scripts keep values in |
| `/images` | `Processor` (`prepare` as an Effect), `make` for one of your own, `photon(wasm)` |
| `/images/fit` | `fitImage`, `fitImages` and `extension(processor)`: images fitted to the model's limits before they are stored |
| `/images/node`, `/images/cloudflare` | `nodePhoton(options)`, `cloudflarePhoton`: Photon read from the installed package, or Wrangler's module |
| `/storage/memory`, `/storage/indexeddb` | `memory`; `indexedDb(name, { indexedDB })` |
| `/storage/jsonl`, `/storage/jsonl/node` | `jsonl(directory, fs, options)` on any environment, `nodeJsonl(directory, options)`; opening fails with `JsonlCorrupted` for a directory recovery cannot repair |
| `/storage/sqlite`, `/storage/sqlite/node`, `/storage/sqlite/cloudflare` | `sqlite(database)` and `applyMigrations`; `nodeSqlite(path, options)`; `durableObject(ctx.storage, options)` and `database(ctx.storage)` |
| `/storage/store` | `store(store, owner)`: Pi's storage in a Chord store (`Store.open` of `@effectified/pi-chord`) under an owner name; several harnesses share one store under distinct owners, and the store outlives the harness |

```ts
import * as NodeEnv from "@effectified/pi-durable/env/node";
import * as Tools from "@effectified/pi-durable/tools";

// A harness whose conversations code in a directory: Pi's coding tools on Pi's local environment.
const coding = Layer.unwrap(
	Effect.map(NodeEnv.make({ cwd: "./work" }), (env) =>
		Harness.layer({ env: () => env }).pipe(Layer.provide(Registry.layer([Tools.coding()]))),
	),
);
```

## Types

`Memo` (the memo function of a hook's, a tool's and a task's api), `JsonValue` and `JsonObject` (the JSON Pi stores:
a memo, a checkpoint, a tool's details) are exported beside the modules, so a signature of yours can name them
without a second import. `ToolName` (also `Tool.Name`) is the schema and type of a tool's name.

## Not wrapped yet

Reach these through Pi's own objects (`Harness.Harness`, `Registry.Registry`, `tx.pi`, the `api.pi` of a hook, a
tool or a task):

- A task's `abandonOnRestart` beyond passing it on.
- A tool's running output.
- A signal's `migrate`.
- Raw submissions (`tx.pi.createSubmission`, `settleSubmission`, `placeSubmission`) and a scan of submissions.

## License

MIT
