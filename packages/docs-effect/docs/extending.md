# Write Tools, Hooks, and Plugins

Everything here is `@gunta/pi-durable-effect` unless named otherwise. Its README is the reference, section by
section; this page says which part to use and the rules that are easy to break. For tests of what you write, read
[Test Without a Network](testing.md). To put a tool into the thread composition, read
[Thread Recipes](thread-recipes.md).

The quick start, from the README: a port, a tool that needs it, a hook, and the extension that bundles them.

```ts
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
```

`Registry.layer([App])` installs it. The registry `Layer` requires every service a handler needs (here `Records`), so
a missing service is a compile error, not a run-time one ([Quick start](../../durable-effect/README.md#quick-start)).

## Tool

`Tool.make(name, { description, parameters, success, replay, handler })`. Pi validates a call against the JSON
Schema of `parameters` (from `@gunta/pi-schema-effect`'s `toJsonSchema`); the handler gets the decoded value and the
call's `api`, and returns an `Effect`.

- The model reads a string result as it is, anything else as JSON. A handler failure, and arguments the schema
  rejects, become an error result the model reads, and the run goes on. A defect becomes Pi's `tool_error`.
- Reply with `Tool.result(value, { details })` to keep data the model never reads (evidence, ids for a UI),
  `Tool.error(text)` for an error you decide, `Tool.sleep({ signals, until })` to park until a signal or a time, and
  `Tool.wait({ on, policy })` to park until tasks the call owns have ended. A parked call holds no process; the
  handler runs again when it wakes.
- Each tool call runs as a task of its own: `api.taskId` is the call's task, `api.callId` the id the model gave it.
- `api.commit(body)` is a commit of the call's task, atomic with what it writes. It is its own commit, before Pi
  commits the tool's result: a rerun finds what the first run committed, so check for it first (by `api.callId`).
  `api.memo(name, candidate)` is a value of the call's task that survives a rerun. `api.createTask(task, input,
  { key })` creates a task once per key. `api.conversation(id)` gives a handle to submit to another conversation.

**Replay.** `replay: "unsafe"` (the default) never runs a handler twice: after a close or a crash cut it off, Pi writes
an `interrupted` error result, which the model reads, and may call the tool again under a new call id. `replay:
"safe"` runs it again. Mark a tool safe only when a second run is harmless: a read, or a write the outside service
makes idempotent by a key, answering a repeated key with the first result (a refusal would reach the model as an
error result). Key such a write by `api.taskId` and `api.callId`, or by a memo with a candidate. These ids are unique
within one harness storage only: copies of a storage (actor forks) and separate actors number alike, so in an actor
add `ActorInfo.actorId` to the key. Find a child conversation or a task again by a key the call owns, as the
subagent example does with `tx.scanConversations({ ownerTaskId: api.taskId }, 1)`.

The api table, the replies and the other options (`structured`, `cancel`, `executionMode`, `deferred`,
`prepareArguments`, `outputLimits`), and `Tool.fromToolkit` for an `effect/ai` `Toolkit`:
[Tool](../../durable-effect/README.md#tool).

## Hook

One constructor per hook of Pi's built-in tasks: `Hook.beforeRequest`, `beforeProviderRequest`, `afterResponse`,
`onYield`, `afterTools`, `afterRun`, `beforeCompact`, `beforeTool` (returns a `Gate`), `afterTool`. Where Pi's hook
may answer or not, the handler succeeds with an `Option`.

What a hook can do:

- Read: `api.taskId` (the asking task: for `beforeTool` and `afterTool`, the tool call's), `api.conversationId`,
  `api.now`, `api.memo`, `api.readSignal`, `api.entry`, `api.entryOf`, `api.snapshot`, `api.snapshotAsOf`, `api.pi`,
  and `api.entries(query)`: a `Stream` of the conversation's stored entries (`order`, default descending,
  `minEntryId`, `maxEntryId`, `pageSize`).
- Answer: replace a request's messages, replace a result, continue a run, gate a call.
- Ask for durable work: `Hook.task(task, input)` from `onYield`, `afterTools` or `afterRun`. Pi creates those tasks
  once, as children of the generation, in a commit after the hook answered, and does not ask the hook again.

What a hook cannot do:

- **Commit.** Its only write is a memo, which is a commit of its own, not the step's. What it writes elsewhere is not
  atomic with the step. What exists exactly when a step does is the step's own entry.
- **Be asked once.** Pi asks it again after a crash or a close that came before its answer was committed, and asks
  `beforeTool` again on every wake of a parked call and after every reopen. Keep what it does outside idempotent,
  and fix a decision that must not change in a memo with a candidate: the first writer wins.
- **Keep a counter.** A hook cannot store a count across calls (a memo lives in one task and is dropped with it).
  Derive a count from committed entries (`api.entries`), or have a tool's or a task's commit keep it in a document,
  and fix each call's decision in a memo of that call's task.
- **Stop a provider request.** A failing hook is reported (`extension_error`) and skipped: it fails open. Only
  `beforeTool` fails closed: its failure blocks the call. Money and routes are enforced at the `Models` boundary
  (`@gunta/pi-budget-effect`, `@gunta/pi-router-effect`).

[Hook](../../durable-effect/README.md#hook), [Hook tasks](../../durable-effect/README.md#hook-tasks).

## Gate and signal

A `beforeTool` handler returns `Gate.allow`, `Gate.block(reason)`, `Gate.rewrite(args)` (Pi validates them again),
or `Gate.park({ signals, until })`. A park needs a signal, a deadline in epoch milliseconds on the harness clock, or
both. A wake asks every `beforeTool` hook again from the first, so a gate reads its key, then allows, blocks or
parks again. From the README, a gate that waits a day for a decision:

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

- The deadline is fixed once, in a memo with a candidate: asked again, the gate reads the first value.
- `Signal.make(name, version, schema)`; `Harness.signal(taskId, signal, key, value)` delivers and answers
  `delivered`, `duplicate`, `invalid`, `closed` or `not_found`. Nothing checks who sends one: authenticate in the host.
- `Harness.signalState(taskId, signal, key)` reads a key from outside the task.
- `Signal.SubmissionSettled` with `notify: { taskId, key }` on a submission wakes a task or a call when another
  conversation answers, holding no process.

For human approval do not write this gate yourself: `@gunta/pi-approvals-effect` binds the decision to a digest of
the arguments. [Gate](../../durable-effect/README.md#gate), [Signal](../../durable-effect/README.md#signal).

## Task

`Task.make({ name, version, input, state, result, initial, phases, abort })`: a state machine whose state is stored
at every step. Input, state and result are `Schema`s; each phase is an Effect that returns a step: `Task.next`,
`Task.sleep`, `Task.sleepUntil`, `Task.wait`, `Task.complete`, `Task.fail`, `Task.aborted`.

- **A phase runs again from its top** after a crash. There is no sleep inside a phase: what comes after a wait
  belongs in the phase the next state names. Make outside calls idempotent by a key of the task (`task.id`).
- **A phase must change the state or end the task**, else Pi faults it.
- **A failing phase faults the task at once**, nothing is retried. An expected failure is `Task.fail`.
- **The restart limit.** After `settings.restartLimit` crashes (default 5) without a new state, Pi ends the task
  `faulted` (`restart_limit`).
- **`api.commit(body)`** stores the step with what the body wrote, or nothing. Children are created with
  `tx.createTask(child, input, { ownership: { kind: "task", taskId: task.id } })` in the commit that stores the wait
  for them.
- Read results with `Harness.waitForTaskOf(task, id)`; `Task.ended(status)` says whether a status has ended.

[Task](../../durable-effect/README.md#task), [Steps](../../durable-effect/README.md#steps),
[The task api](../../durable-effect/README.md#the-task-api).

## Documents, entries and commits

A document is typed JSON state beside the transcript; an entry is a typed record appended to a conversation. From the
README, both in one commit:

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

class TooMany extends Schema.TaggedError<TooMany>()("TooMany", { max: Schema.Number }) {}

const addTodo = (item: string, at: Date) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		return yield* root.commit((tx) =>
			Effect.gen(function* () {
				const todos = yield* tx.doc(Todos, root.id);
				const { items } = yield* todos.get;
				// A failing body fails the commit with its own error, and nothing of it is stored.
				if (items.length >= 2) return yield* new TooMany({ max: 2 });
				yield* todos.set({ items: [...items, item] });
				const note = yield* tx.append(Note, root.id, { data: { text: `added ${item}`, at } });
				return note.id;
			}),
		);
	}); // Effect<EntryId, TooMany | DurableError | SchemaDecodeError, Harness>
```

- **`Doc.make`** takes `kind`, `version`, `scope`, `schema`, `initial`, `checkpointWhen`, and for a conversation
  document `history` and `fork`:
  - `scope`: `session` (one per storage, shared by every conversation), `conversation` (one per conversation), or
    `task` (one per task, retired with it).
  - `history`: `latest` keeps the current value; `rewindable` keeps its history for `snapshotAsOf`.
  - `fork`, what a conversation fork at entry `E` starts with: `current` (the parent's committed value when the fork
    commits), `initial` (nothing copied; created from `initial` at first use), `asOf` (the parent's value at `E`;
    `rewindable` only).
  - `checkpointWhen` only picks when Pi stores a full base to bound replay; `() => false` is the usual answer.
  These are Pi's `DocumentSemantics`, in `@earendil-works/pi-durable`'s declarations.
- **`Doc.family`** is one document per key: the direct lookup by a key of yours, since Pi has no index of
  conversations by your key ([Conversation init](../../durable-effect/README.md#conversation-init)).
- **In a commit** `tx.doc(Doc, …address)` opens or creates it: `get`, `set`, `update`, `draft`. **Outside**,
  `snapshot(Doc, …address)` reads the committed value as an `Option` and never creates one.
- **`Entry.make(kind, schema)`**; `tx.append(Note, conversationId, { data })`; `Note.read(record)` types a stored one.
  Entries are history: a fork sees exactly those up to `at`, and the recorder delivers them to the product's sink.
  A document is state: one value, read and replaced.
- **Pi's built-in documents** (`BuiltinDoc.live`, `provider`, `usage`, `inbox`) are Pi's to write: read them only.
  `BuiltinDoc.agent` is written through `configure`.

**The read-before-write rule.** Inside a commit body, table reads (`conversation`, `entry`, `task`,
`scanConversations`, `scanEntries`, `scanTasks`, `latestEntryId`, `submission`) come before the first table write
(`append`, `appendEntry`, `createConversation`, `forkConversation`). After it they fail with `ReadAfterWrite`, and so
do `signal` and an admission. Documents can be read and written at any point.

- Read only through `tx` inside a body: a read of the harness inside it waits for the commit it is in, for ever.
- No long work inside a body: every other commit waits for it.
- A body that fails rolls everything back and fails the Effect with its own error. Once the body has ended, Pi
  stores the commit whatever happens to the caller.
- `init` of `createConversation`, `rootWith` and `fork` runs inside the creating commit: what it writes exists
  exactly when the conversation does. That is where a plugin grants, caps or claims a key for a new conversation.

[Commits](../../durable-effect/README.md#commits), [Doc](../../durable-effect/README.md#doc),
[Entry](../../durable-effect/README.md#entry), [Built-in documents](../../durable-effect/README.md#built-in-documents).

## Memos

`memo(name)` reads; `memo(name, candidate)` stores the candidate unless a value is there, and gives the stored value:
the first writer wins. A memo belongs to a task: a tool's to the call's task, so it survives a rerun of the handler (an
idempotency key); a `beforeTool` hook's to the tool call's task, so a name without the call id is already per call; a
task's own while it can run. A hook's memo is a commit of its own. Pi drops a task's memos with its outcome, so a
memo is no store across calls.

## Extensions and their order

`Extension.make({ name, tools, hooks, tasks })` bundles them; `Registry.layer([...])` installs a list. By default every
conversation selects every installed extension, in order; `configure({ extensions })` or an `Agent.Change` selects
fewer. A task is found by its name whichever conversations select its extension.

**Hooks are asked in extension order, so order is behaviour:**

- A guard first (`@gunta/pi-guard-effect`'s `Guard.registry` installs its own extension first).
- Tools without hooks anywhere after it.
- A `beforeTool` hook that blocks or rewrites before approvals: a hook after approvals that rewrites arguments runs
  a tool with arguments nobody approved.
- Pi takes the **first** `onYield` answer: an extension with one before the review takes answers from the review.
  Make a second `onYield` concern a review check, or run it in `afterRun`.
- An observer (an advisory record) last.

Say in your extension's README where it belongs. The composition's table:
[The order, and why](../../thread-effect/README.md#the-order-and-why).

## Writing a plugin

A plugin is a package of behaviour on the facades. Its rules:

- **It never imports another plugin.** It meets others in a product's composition. Where it needs what another
  plugin gives (a grant, a cap), it declares a port and the product wires it: `ChildSetup` of
  `@gunta/pi-subagent-effect` is implemented by the product with the guard's `Conversations.grantIn` and the budget's
  `Shares` ([The setup port](../../subagent-effect/README.md#the-setup-port)).
- **What the product supplies is a `Context.Service` port** (a sink, a lease, a decider), never a callback option.
  Declare it as the quick start declares `Records`. Make it required when a silent default would be wrong, and give
  the product an explicit `none` Layer for "I have nothing to say" (`ChildSetup.none`, `Swarm.ForkSetup.none`). A
  `Context.Reference` with a default is right only when the default imposes nothing (the router's `ConstraintSource`).
- **No product rule, name or constant in code.** Policies are data, often a `Schema` a product decodes from config.
- **Everything it stores is in the harness storage**, through `Doc`, `Entry`, memos and commits, under kinds prefixed
  by the plugin: documents, entries, tasks, signals and memo names (`recorder.cursor`, `budget.share`,
  `subagent.run`, `approvals.decision`). `pi.` is Pi's. Tool names are what the model reads; they need no prefix. The recorder delivers every entry kind that does
  not start with `pi.` as an `Entry` record, so a plugin's entries reach the product's sink without a list.
- **Errors are `Schema.TaggedError` classes.** No `throw`. Every public function returns `Effect`, `Stream` or `Layer`.
- **Time and ids come from services** (`Clock`), never from `Date.now()` in library code.
- **What Pi defines is not written a second time.** Take a type from Pi's (`Pick`, `Extract`, indexed access, a mapped
  type, `StrictOmit` of `@gunta/pi-ai-effect`); make a choice over a Pi union exhaustive where it is written
  (`satisfies Record<Union, ...>`, a `switch` with a declared return type); use the facades' shared forms
  (`ANSWERED`, `TOKEN_KINDS`, `ModelRef`, `Task.ended`, `Submission.settled`, the id schemas, `Agent.ByName`).
- **Platform code** (`node:`, `bun:`) lives behind a subpath of its own, so the core runs on Node, Bun and Workers.

### What a fork carries, and `onStorageFork`

- **A conversation fork** (`conversation.fork({ at })`, `tx.forkConversation`) sees its parent's entries up to `at`
  and continues alone. A conversation document starts in the fork as its `fork` option says (above). Session
  documents belong to the storage and are shared; task documents and tasks are never copied. Give the fork what it
  needs in the forking commit (`init`).
- **A storage copy** (a Rivet actor fork) carries everything: every conversation, entry, document, memo and task
  record, live background tasks included. It carries nothing in memory, and the host cancels its schedules.

State that is history or a plain value (a note, a grant) is right in a copy as it is: write no step for it. A plugin
whose stored state is wrong in a copy (a cursor, money, a live task) exports an `onStorageFork` Effect:
idempotent, run on a harness opened with `resume: false` before the copy's first request, under a name the host
gives when it must tell copies apart. Follow the four that exist:
[recorder](../../recorder-effect/README.md#a-forked-storage), [budget](../../budget-effect/README.md#a-copied-storage),
[subagent](../../subagent-effect/README.md#a-copied-storage), [swarm](../../swarm-effect/README.md#a-copied-storage).
