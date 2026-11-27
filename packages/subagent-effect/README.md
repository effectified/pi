# @effectified/pi-subagent

Ready-made tools with which an agent of a [Pi Durable](../durable) harness delegates work to a child agent. A plugin
for [`@effectified/pi-durable`](../durable-effect), for `effect` 4.1:

- **Declared agents.** A product declares the subagents a parent may start. A child runs with exactly its
  declaration: none of its parent's tools, instructions or limits.
- **Foreground.** The parent's model calls `subagent` and gets the child's answer as the tool result. The call
  holds no process while the child works, and survives a restart.
- **Background.** `subagent_start` returns a handle at once. The result is sent to the parent as a message when it
  is ready, and `subagent_status` reads it by the handle.
- **Typed results.** With a result `Schema`, the child's answer is decoded, sent back for correction when it does
  not match, and given to the host as a value.
- **A setup port.** The product grants a child its tools and caps its budget in the commit that creates it.
- **Limits.** How deep subagents nest and how many work at once, counted from what Pi stores.

Nothing here knows your tools, models or budgets: all of it is data and one port you supply.

## Install

```sh
npm install @effectified/pi-subagent @effectified/pi-durable effect
```

`effect` is a peer dependency (`~4.1.5`). Built for Pi Durable 1.6.1.

## Quick start

The examples of this README run on the scripted model of the testing kit, and are the test
[`test/readme.test.ts`](test/readme.test.ts).

```ts
import { Effect, Layer, Schema } from "effect";
import { Extension, Harness, Tool } from "@effectified/pi-durable";
import { answer, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { ChildSetup, Subagent, Subagents } from "@effectified/pi-subagent";

const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.String,
	handler: ({ query }) => Effect.succeed(`Results for ${query}: the tower opened on 31 March 1889.`),
});
const Write = Tool.make("write", {
	description: "Write a note.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(`Wrote: ${text}`),
});
const App = Extension.make({ name: "app", tools: [Search, Write] });

const model = { provider: "faux", modelId: "faux-1" };

// A subagent is the whole agent of its child, as data.
const Researcher = Subagent.make("researcher", {
	description: "Finds facts on the web and reports them with their sources.",
	agent: { model, tools: [Search], instructions: "Answer with the facts and their sources.", maxTurns: 8 },
});

const subagents = Subagents.extension({ subagents: [Researcher], maxDepth: 1, maxLive: 4 });

const program = Effect.gen(function* () {
	// The parent has `write` and the foreground tool. The researcher will have `search`, and nothing else.
	const root = yield* Harness.rootWith({ agent: { model, tools: [Write, Subagents.TOOLS.foreground] } });
	return yield* root.prompt("Find out when the Eiffel Tower opened.");
});

const live = TestHarness.layer({
	extensions: [App, subagents],
	responses: [
		toolCall("subagent", { subagent: "researcher", task: "When did the Eiffel Tower open?" }), // the parent
		toolCall("search", { query: "Eiffel Tower opening" }), // the child
		answer("It opened on 31 March 1889."), // the child: the result of the parent's call
		answer("The Eiffel Tower opened on 31 March 1889."), // the parent
	],
	// No guard and no budget here. The registry does not build until a setup is named: see "The setup port".
}).pipe(Layer.provide(ChildSetup.none));

Effect.runPromise(Effect.provide(program, live)).then(console.log); // { status: "done", … }
```

With a real provider, give `Harness.layer` your `Models` and name one of its models in each declaration.

## Declaring subagents

`Subagent.make(name, options)` types a declaration; it is a plain value.

| Field | |
|---|---|
| `name` | What the parent's model passes to the tools, and what the records keep: a `Subagent.Name`, which `make` brands |
| `description` | What the subagent is for, in words the parent's model picks it by |
| `agent.model`, `agent.tools` | Required. The child's model, and its tools: exactly these, in order |
| `agent.thinkingLevel`, `instructions`, `cwd`, `maxTurns`, `compaction` | Optional. Left out: unset in the child |
| `agent.extensions` | Optional. Left out: the host's selection, so guards and recorders stay selected |
| `agent.modelTools` | Optional. Of `tools`, those the model is offered. Left out: all of them |
| `result` | Optional. A `Schema` the final answer must match (see [Typed results](#typed-results)) |
| `corrections` | How often an answer that does not match is sent back. Default: 2 |

**A child runs with exactly its declaration.** Pi starts a task-owned conversation as a copy of its owner's stored
agent (`pi.agent`), every field. This package then writes every field of that agent in the creating commit: a
declared field replaces the copy, and a field the declaration leaves out is cleared (`null`), never inherited. A
parent with tools `a` and `b`, instructions and a turn limit, and a declaration that names only tool `c`, gives a
child that is offered exactly `c` and has neither the instructions nor the limit.

`model` and `tools` are required because a cleared field follows the host: no model at all, and every tool of every
selected extension. A child can start subagents of its own only when its declaration lists the subagent tools, and
only within `maxDepth`.

`Subagents.extension({ subagents, maxDepth, maxLive })` is what a registry installs: the three tools and the task
that drives a child. Install it after a guard's extension. A registry with two declarations of one name, or with a
`result` that has no JSON Schema, does not build (`SchemaConversionError`).

## The tools as the model sees them

`Subagents.TOOLS` holds the names, for a parent's agent and for a guard's grant. A conversation gets them as it gets
any tool: through its agent's `tools`.

| Tool | Parameters | Result |
|---|---|---|
| `subagent` | `subagent`: a declared name; `task`: everything the child needs | The child's answer, once it is there |
| `subagent_start` | The same | `Started subagent NAME in the background. Handle: H. …`, at once |
| `subagent_status` | `handle`: what `subagent_start` gave | Still working, the result, or why the child failed |

The descriptions of `subagent` and `subagent_start` list the declared names with their descriptions. A child sees
nothing of its parent's conversation; the `task` is its first message.

Every result about a child carries details for the host, which the model never reads:
`{ conversationId, handle, subagent, mode, status }`, with `result` for a typed result and `reason` for a failure.
`status` is `running`, `answered` or `failed`. The handle is the child's conversation id as text, a `Child.Handle`
(`Child.key(conversationId)`). The tools decode what the model passes: the subagent's name as a `Subagent.Name`, the
handle as a `Child.Handle`.

**Failure is a result.** A child that does not answer gives the parent an error result that says why, and the
parent's run goes on. Pi's reason is in `details.reason`:

| `reason` | The model reads |
|---|---|
| `model_error` | `The subagent's model request failed: TEXT. …` A budget stop arrives so, with the budget's text |
| `turn_limit` | `The subagent used up its turns (N turns) without a final answer. Give it a smaller task.` |
| `aborted` | `The subagent was stopped before it answered.` |
| `no_model` | `The subagent has no usable model. Starting it again will not help.` |
| `invalid_result` | The schema's issues, and the child's last answer |
| `setup_failed` | `The subagent could not be set up: REASON` (the setup port's `beforeStart`) |
| `copied` | `The subagent did not go on in this copy of its storage: … Start it again if you still need it.` (see [A copied storage](#a-copied-storage)) |
| any other of Pi's | `The subagent ended without an answer (REASON): DETAIL.` |

A child that was never created is an error result too, with `details: { status: "refused", reason }`: an
undeclared name (`UnknownSubagent`), a limit (`DepthExceeded`, `TooManyChildren`), or the setup port
(`ChildSetupFailed`).

## Typed results

```ts
const Fact = Schema.Struct({ claim: Schema.String, source: Schema.String });

const FactFinder = Subagent.make("fact-finder", {
	description: "Finds one fact and its source.",
	agent: { model, tools: [Search] },
	result: Fact,
	corrections: 1,
});

// The parent's model reads the tool result as JSON text: {"claim":"…","source":"…"}
// The host reads the value in the stored tool result's details, and decodes it with the declaration:
const factOf = (details: { readonly result: unknown }) => Subagent.result(FactFinder, details.result);
// Effect<{ claim: string; source: string }, ResultMismatch>
```

How a child produces a typed result: it answers in text with one JSON value. The JSON Schema of `result` is added
to the task it is given. Its final answer, bare or in a fenced block, is parsed and decoded against the schema; what
is kept is the schema's own JSON form, without fields the schema does not know. An answer that does not match is
sent back to the child with the issues, at most `corrections` times, and then the child fails with
`invalid_result`. Pi Durable 1.6.0 has no structured output per request, and a `finish` tool would give the child a
tool its declaration does not name. The cost, stated plainly: a model that will not write JSON spends `corrections`
more requests before the parent learns of it.

## Background children

```ts
const program = Effect.gen(function* () {
	const root = yield* Harness.rootWith({
		agent: { model, tools: [Subagents.TOOLS.background, Subagents.TOOLS.status] },
	});
	// The model calls `subagent_start`, reads the handle, and answers while the child still works.
	yield* root.prompt("Start the research in the background, and tell me that you did.");
	// Later the result arrives by itself, as an input to the parent, and starts a turn:
	//   [subagent researcher, handle 14, finished]
	//   It opened on 31 March 1889.
	yield* Harness.waitForIdle;
});
```

The result reaches the parent Pi's own way, as an input (`whenBusy: "followUp"`): it starts a turn when the parent
is idle, and follows the current answer otherwise. It is placed as an entry of kind `subagent.report`
(`Subagents.REPORT`) with
`{ handle, conversationId, subagent, isError }` as data, so a UI can show it as a report and not as a user message;
the model reads it as a user message. It is admitted in the commit that ends the child's run, under a request id, so
a restart delivers it once. `subagent_status` reads the same result at any time, also after a restart, from the
child's document. A model can read only the children of its own conversation.

## The setup port

`ChildSetup.ChildSetup` is what the product decides about every child. It is **required**: `Registry.layer` with
the subagent extension has `ChildSetup` in its requirements, so a harness without one does not compile. The other
plugins meet a child they were told nothing about in different ways, a guard refusing its every call and a budget
letting it spend without a cap. An optional port with a default that does nothing would make the second silent. A
product that has neither plugin says so with `ChildSetup.none`.

| | Runs | A failure |
|---|---|---|
| `created(tx, child)` | Inside the commit that creates the child, after the declared agent was written | Fails the commit: no child exists, and the tool result is an error with `reason` |
| `beforeStart(child)` | After that commit, before the child gets its task. Pi may run it again after a crash | The child ends without a provider request, with an error result |

`child` is a `ChildSetup.Child`, a `Schema`: `{ conversationId, parentId, subagent, mode, depth }`. Both fail with
`ChildSetupFailed`, whose `reason` the parent's model reads.

A product with the guard and the budget plugins, as product code. A child inherits no grant, so `created` gives it
its allow-list; the budget plugin sets a cap in a commit of its own, so that goes into `beforeStart`:

```ts
import { Conversations, Guard } from "@effectified/pi-guard";
import { Shares } from "@effectified/pi-budget";

// The product's own table: what each declared subagent may call, and spend.
const allowances: Record<string, { readonly tools: ReadonlyArray<string>; readonly cap: bigint }> = {
	researcher: { tools: ["search"], cap: 50_000n },
};

const refused = (child: ChildSetup.Child) => (cause: unknown) =>
	ChildSetupFailed.make({ reason: `The subagent ${child.subagent} has no allowance.`, cause });

const Setup = Layer.effect(
	ChildSetup.ChildSetup,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		const shares = yield* Shares;
		const allowanceOf = (child: ChildSetup.Child) =>
			Effect.mapError(Effect.fromNullishOr(allowances[child.subagent]), refused(child));
		return {
			// Stored with the child or not at all: no child ever exists without its grant.
			created: (tx, child) =>
				Effect.flatMap(allowanceOf(child), ({ tools }) =>
					Conversations.grantIn(tx, child.conversationId, { tools }).pipe(
						Effect.provideService(Guard.Guard, guard),
						Effect.mapError(refused(child)),
					),
				),
			// The cap is in place before the child's first provider request. Setting it again is harmless.
			beforeStart: (child) =>
				Effect.flatMap(allowanceOf(child), ({ cap }) =>
					shares.setCap(child.conversationId, cap).pipe(Effect.asVoid, Effect.mapError(refused(child))),
				),
		};
	}),
);
```

`created` runs after this package wrote the declared agent, so what it configures there (a guard narrows `tools` to
its grant) is what the child gets. Every conversation reserves on the one lease of the budget, so a child's spend
comes out of the same budget as its parent's; the cap bounds the child's part. This package imports neither plugin:
its test runs this Layer against stand-ins with the same signatures.

## Limits

`maxDepth` and `maxLive` are required, and enforced in the commit that would create the child. A start beyond a
limit is an error result, and nothing is stored.

- **`maxDepth`**: how deep subagents nest. 1 lets a conversation start children that can start none; 2 lets those
  children start their own. Counted from the asking conversation's own `subagent.child` document: one more than its
  depth, 1 when it has none.
- **`maxLive`**: how many subagents of one conversation may be at work at once, foreground and background together.
  Counted from Pi's task table: the tasks of kind `subagent.run` in the asking conversation that Pi has not settled,
  read in the creating commit. A run whose outcome is decided still counts while its child's work runs on (Pi's
  `completing`, such as an `afterRun` hook of the child's answer). Pi runs commits one after another, so two calls of
  one round cannot both pass.

Both counts are read from storage each time, so a restart resets neither.

## Records

A child is a conversation of its own, so a recorder records it under its own id, and this package adds nothing for
that. Two things link a child to its parent:

- **Pi's own record.** `ConversationRecord.owner` of the child is `{ conversationId, taskId }`: the parent's
  conversation, and the task that drives the child. Pi keeps it after that task ended.
- **The `subagent.child` document**, in the session scope under the child's conversation id as text:
  `{ conversation, subagent, parent, depth, mode, task, state }` (`Child.Record`). `state` is a `Child.State`:
  `Running`, `Answered` (the entry of the final answer), `Typed` (also the result as JSON) or `Failed` (`reason`,
  `message`, the last answer's entry if any). `Child.State.match(state, { ... })` takes one handler per tag.

```ts
import type { ConversationId } from "@effectified/pi-durable";
import { Child } from "@effectified/pi-subagent";

// From a child to its parent, its declaration and how it ended: one committed read.
const linkOf = (child: ConversationId) => Harness.snapshot(Child.Document, Child.key(child));
// From a parent to its children: Pi's owner index.
const childrenOf = (parent: ConversationId) =>
	Harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent }, 100));
```

The second document, `subagent.started` in the scope of a task, is this package's own bookkeeping: the child a tool
call or a run task started. Pi retires it with its task. A host that forks the whole storage copies the
`subagent.child` documents with the conversations they name, and every run task: see
[A copied storage](#a-copied-storage).

## A copied storage

A host that copies a whole harness storage, such as a Rivet actor fork, copies every run task with it. A child that
had ended is right in the copy as it is: its document and its result are history. A run that was live is not. Left
alone it starts its phase again in the copy, and the storage it was copied from does the same: both give the child
its task, or both send the child's result to the parent, where it starts a turn.

```ts
import { onStorageFork } from "@effectified/pi-subagent";

// In the host of the copy, on a harness opened with `resume: false`, before anything else:
yield* onStorageFork; // Effect<void, DurableError | SchemaDecodeError, Harness>
yield* Harness.resume;
```

`onStorageFork` does two things to the copy, and nothing to the storage it was copied from:

1. It writes the mark `subagent.copy` with the id of the newest task: every run up to it was copied. A marked run
   starts no phase. Its phases and its abort handler read the mark first and end the task `aborted` with the reason
   `copied`.
2. It marks every live run for abort (`Harness.abortTask`). That wakes a run that sleeps until its child's
   submission settles, and Pi ends the work a run owns, its child's, before the run's own end.

What that gives, once the copy resumes:

- **No provider request.** A run that had not handed its child the task never does. A child's request that the copy
  holds in flight is aborted and not sent again.
- **No report.** The parent's conversation in the copy gets no `subagent.report`, so no turn starts there.
- **The setup port is not asked.** `beforeStart` does not run again in the copy.
- **The child's document says why.** Its state is `Failed` with the reason `copied`, and `subagent_status` gives
  the parent's model that as an error result. The original's child goes on and reports to the original's parent.
- **The copy's own subagents run as usual**: their tasks are newer than the mark. `maxLive` counts live runs, so a
  copied run frees its place when it ends.

**Foreground runs** are ended the same way. A foreground run is a child task of its parent's tool call, which is
live work of the conversation: a host that copies only a storage with nothing in flight, as the Rivet host does,
never copies one. In a copy made anyway, the waiting `subagent` call gets the error result above and the parent's
run goes on; that run, copied in flight, is the host's to decide about.

**Idempotent**, as a host needs after a crash in the middle: run again before the copy's first call, it writes the
same mark and marks the same tasks. It is not a step for a storage that has started work of its own: a run started
since would be older than the new mark, and would be ended.

What a host that forks only an idle storage still copies live is a background run in two short windows: after the
run was created and before its child got the task, and after the child's submission settled and before the run
recorded it. `test/sqlite-suites.ts` copies a SQLite file in the first window, and in the middle of a child's
request, on both drivers.

## Guarantees and their limits

In Pi's terms. One durable task of kind `subagent.run` (`Subagents.TASK`) drives every child: it submits the task with
`notify: { taskId, key }`, sleeps on Pi's built-in `SubmissionSettled` signal, and records the outcome. It owns the
child's conversation. What differs between the two kinds of child is who owns that task.

- **A foreground child is attached.** Its run is a child task of the parent's tool call, which parks on it
  (`wait`). `Conversation.abort` on the parent marks the call, and Pi's cascade reaches the run and the child's
  conversation: the child's model request is aborted and the child never answers. The parent is idle only once the
  child is.
- **A background child outlives the parent's abort.** Its run is a conversation-owned task with `background: true`,
  a boundary of Pi's abort and idle traversal. `Conversation.abort` on the parent stops the parent's run and leaves
  the child working; `waitForIdle` on the parent does not wait for it. The child's result then arrives as an input
  and starts a turn in the stopped parent, as Pi's example 22 says of its reports. `abort({ background: true })`
  reaches it too, and no result is sent for a child stopped so.
- **A child is created once.** The creating commit records the child under the tool call's task, and every tool is
  `replay: "safe"`: a call that runs again after a crash, or after its park, finds the child it made.
- **A restart resumes.** A parked call and a sleeping run hold no process and are found again on reopen. A model
  request of the child that a close stopped is sent again, as Pi does for every request.
- **Limits of the guarantees.** Nothing here stops a provider request: a budget does, and a child without a cap is
  bounded by its `maxTurns` only, so declare one. `beforeStart` is not atomic with the child's creation: a crash
  between the two leaves a child that exists and has not started, and the run calls `beforeStart` again when it
  resumes. A run that Pi faults or orphans writes no outcome: the tools then answer
  `Subagent NAME ended without recording a result.` A background result is an input like any other: a host that
  resets the parent, or forks its conversation, decides what becomes of it. A declaration that was removed while a
  child of it worked faults that child's run when it wakes.

## License

MIT
