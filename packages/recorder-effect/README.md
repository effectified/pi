# @effectified/pi-recorder

Every message, model call and tool call of a [Pi Durable](../durable) harness, and every entry a plugin stores
beside the transcript, goes to a sink your product provides, with a deterministic id, at least once, so the
product's own record can be written exactly once. Written on
[`@effectified/pi-durable`](../durable-effect), for `effect` 4.1 and Pi Durable 1.6.1.

- The entries are the outbox. A record is derived from an entry Pi committed with its step, so a record exists
  exactly when its step does. No hook writes a pending row: a Pi hook cannot commit.
- A cursor in the harness storage says, per conversation, how far delivery got. A pump delivers what comes after it,
  in order, and moves it only after the sink took the batch.
- It knows nothing of your product. The sink is a service you provide.

## Install

```sh
npm install @effectified/pi-recorder @effectified/pi-durable effect
```

`effect` is a peer dependency (`~4.1.5`).

## Quick start

It runs as it stands, on scripted models; the same code is in [`test/readme.test.ts`](test/readme.test.ts), like
every example below.

```ts
import { Effect, Layer } from "effect";
import { Recorder, RecordSink, type Records } from "@effectified/pi-recorder";
import { answer, TestHarness } from "@effectified/pi-durable/testing";

// Your store, keyed by record id: a record that comes twice is written once.
const store = new Map<string, Records.Record>();
const Sink = Layer.succeed(RecordSink, {
	deliver: (records) =>
		Effect.sync(() => {
			for (const record of records) store.set(record.id, record);
		}),
});

const program = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	yield* root.prompt("Say hi.", { requestId: "greeting" });
	// Do not answer the caller before the record is written.
	yield* Recorder.flush(root.id);
	return [...store.keys()];
});

const live = Recorder.layer().pipe(
	Layer.provideMerge(TestHarness.layer({ responses: [answer("Hi.")] })),
	Layer.provide(Sink),
);

Effect.runPromise(Effect.provide(program, live)).then(console.log);
// ["1:8:0:message", "1:11:0:model", "1:11:0:message"]
```

With a real harness, `Recorder.layer()` needs the `Harness` of `Harness.layer()` and your `RecordSink`.

## Records

`Records.Record` is a `Schema` tagged union of plain JSON values: a record's JSON form is the same value, and
`Records.Record.match` handles each `_tag`. Times are whole epoch milliseconds, token counts and costs are numbers as
Pi stored them, and an absent value is `null`. Ids are branded: a record's `id` is a `Records.Id`, the conversation,
entry and task ids are Pi Durable's (`Conversation.Id`, `Entry.Id`, `Task.Id`), and a tool's `name` is its
`ToolName`.

| `_tag` | From | Carries |
|---|---|---|
| `Message` | a user message, or the text of a model response | `role`, `entryKind`, `text`, `images` |
| `ModelCall` | every model response, also a failed or aborted one | `provider`, `model`, `api`, `stopReason`, `error`, `usage`, `cost`, `task`, `responseId`, `durationMs` |
| `ToolCallRequested` | each tool call of a model response | `callId`, `name`, `arguments` |
| `ToolCallResult` | a tool result | `callId`, `name`, `isError`, `codes`, `diagnostics`, `text`, `images`, `details`, `usage`, `cost` |
| `Entry` | an entry without a model message that is not Pi's own: a plugin's or the product's | `kind`, `data`, `task` |
| `ModelCallRequested` | a hook, before a model request (advisory, see below) | `after`, `task` |

Every record has `id`, `conversation`, `time` and `advisory`; the five derived from entries also have `entry`.

```ts
const command = (record: Records.Record): string =>
	Records.Record.match(record, {
		Message: (message) => `message ${message.role}: ${message.text}`,
		ModelCall: (call) =>
			call.stopReason === "error" || call.stopReason === "aborted"
				? `model call failed: ${call.error}`
				: `model call returned: ${call.usage.totalTokens} tokens, ${call.cost.total}`,
		ToolCallRequested: (call) => `tool ${call.name} requested`,
		ToolCallResult: (result) =>
			result.isError ? `tool ${result.name} failed: ${result.codes.join()}` : `tool ${result.name} returned`,
		Entry: (entry) => `entry ${entry.kind}: ${Formatter.formatJson(entry.data)}`,
		ModelCallRequested: () => "model call requested",
	});
```

- **Which entries.** An entry with model messages gives the records of its messages, whatever its kind. A user
  message is a `Message` with the entry's kind: `pi.user` for input (or the kind an input was submitted with),
  `pi.reset` for a handoff text, `pi.compaction` for a summary. A model response is a `ModelCall`, then a `Message`
  when it has text, then one `ToolCallRequested` per call. Not recorded: system messages (prompt sections and tool
  definitions) and a response's thinking parts.
- **Entries without a model message.** An entry of any kind that does not start with `pi.` gives one `Entry` record:
  its `kind`, its `data` as stored (`null` when it has none), and the `task` that appended it. This is how a
  plugin's own entries reach the sink: a review's `review.verdict` and `review.release`, a product's `app.note`.
  **Every such kind is delivered, without a list to keep**: a product that mirrors everything does not lose the
  entries of a plugin it installs later, and a sink that wants fewer ignores the kinds it does not know. Pi's own
  entries without a message (a plain `pi.reset`) are Pi's bookkeeping and give no record. An entry with model
  messages gives no `Entry` record: its `data` is not delivered.
- **An entry's time.** Pi stores no time with an entry. `Entry.time` is the `time` field of the entry's data when
  that is a whole number (epoch milliseconds: `review.verdict` and `review.release` carry one), and `null` otherwise.
  It is never the time of delivery, which would make a redelivery differ from the first.
- **Failed attempts.** Pi commits every model response as an entry, a failed one (`stopReason: "error"`, the
  provider's text in `error`) and an aborted one too, with its usage. So they are `ModelCall` records like any other.
  Pi gives the error as text only: there is no error class to pass on.
- **Tool results.** `isError` with a code in `codes` is a result Pi wrote, among them `blocked` (a gate refused the
  call), `invalid_arguments`, `tool_unavailable`, `tool_error` (the tool threw), `interrupted` and `aborted`. An error
  result without a code is one the tool returned itself.
- **A model call a host derives.** `ModelCall` has one optional field, `derived`, which no record of this package
  carries. A host that turns what a plugin stored about a request of its own into a `ModelCall`, so that its sink
  gets every model call in one shape, sets it: `from` is the id of the `Entry` record it derived the call from, and
  `unknown` names the fields that entry does not hold (`api`, `cost.input`), which then carry their empty value
  (`""`, `0`, `false`) and mean "not known". `@effectified/pi-thread` does this for a reviewer's request.
- **Content.** Records carry content: text, images, arguments, tool output. This package logs none of it.

### Ids

`<conversation>:<entry>:<message>:<part>`: Pi's conversation id, Pi's entry id, the index of the message in the entry
(0 for every entry Pi writes itself), and `message`, `model`, `call:<n>` or `result`. An `Entry` record, which has no
message, has `<conversation>:<entry>:entry`. An advisory record has `<conversation>:<after>:requested`.

The scheme is a contract: the ids above are what they were before `Entry` records existed, and
[`test/recorder.test.ts`](test/recorder.test.ts) holds them to the exact list.

- The same entry gives the same records with the same ids, in every process and at every delivery.
- An id is unique within one harness storage. Two storages number alike, so a product with several storages (one per
  actor, say) keys a record by its storage and the id.
- Ids are reproducible: a second identical run on a fresh storage gives the same ids, as long as both storages commit
  in the same order. Pi numbers entries, tasks and documents from one counter, so work that races (parallel tool
  calls, two conversations at once) can number differently from run to run.

## Guarantees and their limits

| Record | Guarantee | What a crash or a close can cost |
|---|---|---|
| `Message`, `ModelCall`, `ToolCallRequested`, `ToolCallResult`, `Entry` | Atomic with the step: derived from the entry Pi committed for it. Delivered at least once, in entry order within a conversation, under one cursor; a redelivery has the same id and content | Nothing Pi committed. After a crash or a close a batch may come again |
| `ModelCallRequested` | Advisory: sent from a hook, outside any commit and outside the order | Lost when the sink fails or the process dies in the hook. Repeated when Pi asks the hook again |

What no record can hold, because Pi commits no entry for it:

- **A response Pi never committed.** When the process crashes after a provider answered and before Pi's commit, or
  while a response streams before Pi stored a first partial, Pi keeps no entry and no usage for it. It counts a failed
  attempt, and tries again by its retry policy or ends the run `interrupted`. That call was paid and is in no record.
  A crash after a stored partial leaves an aborted entry, and so a `ModelCall` with `stopReason: "aborted"`. A close,
  unlike a crash, loses nothing: the stopped request left no entry and is sent again.
- **A run that ends without a model response** (`no_model`, `nothing_to_answer`, `turn_limit`, an abort before any
  answer). Its reason is in the settled submission and in `pi.live.runFailure`.
- **A request before it is sent.** Hence the advisory record.
- **Nested tool calls** (a tool that calls a tool, a code mode script) and **compaction's own model calls**. Their
  usage is in Pi's ledger (`Harness.usage`, `Harness.usageEvents`).
- **A model call a task makes itself**, through the harness's models and outside a generation, such as a reviewer's
  request. It leaves no model message and is not in Pi's ledger. What its task stores about it in an entry of its
  own is delivered as that `Entry` record: `@effectified/pi-review` keeps the request in its verdict (`data.call`).
  The recorder does not know such an entry's shape; a host that does can add a `ModelCall` for it (`derived`, above).

A replay-unsafe tool call that a close or a crash cut off is not run again: Pi writes an `interrupted` error result,
and that is what is recorded.

## The sink

```ts
// A service of your program: here, a table with an upsert, and what its store fails with.
class RowsError extends Schema.TaggedError<RowsError, { readonly brand: unique symbol }>()("RowsError", {
	cause: Schema.Defect(),
}) {}

class Rows extends Context.Service<
	Rows,
	{ readonly upsert: (id: Records.Id, row: Records.Record) => Effect.Effect<void, RowsError> }
>()("app/Rows") {}

const Sink = Layer.effect(
	RecordSink,
	Effect.gen(function* () {
		const rows = yield* Rows;
		return {
			deliver: (records: ReadonlyArray<Records.Record>) =>
				Effect.forEach(records, (record) => rows.upsert(record.id, record), {
					concurrency: 1,
					discard: true,
				}).pipe(Effect.mapError((cause) => RecordSinkError.make({ cause }))),
		};
	}),
);
```

- `deliver` takes one batch, in order. Success means every record of it is stored.
- **It must be idempotent by `Record.id`.** Delivery is at least once: a batch comes again when the sink failed, and
  when the process ended after the sink stored it and before the cursor moved.
- A failure is tried again by the pump's schedule, and the cursor never passes a record the sink did not take:

```ts
const live = Recorder.layer({ retry: Schedule.spaced("250 millis") });
```

  The default retries forever, from 100 milliseconds, doubling up to 30 seconds. When a schedule of yours ends, the
  batch stays undelivered until the conversation's next commit or a flush; the pump logs a warning with the
  conversation's id and the error's tag, never its message.
- Batches of one conversation come one at a time. Batches of different conversations, and advisory records, may come
  concurrently.

## The pump

`Recorder.layer(options)` is a scoped Layer that requires `Harness` and `RecordSink`.

- **Recovery.** When it starts it queues every conversation of the storage, so what an earlier process committed and
  did not deliver is delivered. The Layer does not wait for that.
- **Following.** It observes Pi's stored commits (`observeCommits`): a commit that holds an entry queues that entry's
  conversation. Nothing polls, and a quiet harness costs nothing.
- **Every conversation.** The root, created ones, forks, and conversations a task owns (subagents) are found the same
  way: by the storage scan at start, and by their entries afterwards. A record names its conversation; it does not say
  what a conversation was forked from or which task owns it.
- **Forks.** A fork delivers only its own entries. It has no cursor at first and starts after the entry it was forked
  at, since the entries up to there are its parent's to deliver.
- **The cursor** is the session document `recorder.cursor` (exported as `Cursor`): the newest delivered entry id per
  conversation. It is one document, created when a pump first starts on a storage, and not one per conversation:
  Pi takes a document's id from the counter it numbers entries with, so a document created during a run would shift
  record ids by the moment of a delivery.
- A batch is the records of up to 100 entries. The background pump delivers up to 16 conversations at once.
- One pump per harness. Two would both deliver, and the sink would get everything twice.

## Flush

```ts
const answerTheCaller = Effect.gen(function* () {
	const root = yield* Harness.root;
	const settled = yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
	yield* Recorder.flush(root.id); // this conversation
	yield* Recorder.flushAll; // every conversation, a subagent's too
	return settled;
});
```

`flush(conversationId)` succeeds once the records of everything that conversation had committed when it was called
are in the sink; `flushAll` does so for the whole harness. Both wait while the sink is retried, and fail with
`RecordSinkError` when the retry schedule ends, or with the harness's error. Nothing is lost then.

## The advisory record

A request that is about to be sent leaves no entry. `Advisory.extension` holds a `beforeRequest` hook that hands the
sink a `ModelCallRequested` record before every request:

```ts
const registry = Registry.layer([Guards, App, Advisory.extension]);
```

- **Where it goes:** last. It observes and decides nothing, and guards come first.
- The registry then requires `RecordSink`, as the pump does.
- The hook waits for the sink, once, without a retry: the notice is in the sink before the provider sees the request,
  or the sink failed, and then Pi reports the hook and sends the request anyway.
- `after` is the newest entry when the request was prepared. The `ModelCall` that answers the request is the first one
  of the same `task` with a greater entry id. `time` is fixed in a memo of the task, so a repeated notice is equal to
  the first.
- The model is not known to the hook; it is in the `ModelCall`.

## A forked storage

A host that copies a whole storage (a Rivet actor fork) runs one Effect on the copy before its first call:

```ts
const onFork = onStorageFork; // Effect<void, DurableError, Harness>
```

It moves every conversation's cursor to its newest entry, in one commit. The original keeps running and delivers
everything the copy inherited, the entries it had not delivered yet included; the copy delivers only what it commits
itself. Run it on a harness opened with `resume: false`, before the recorder's Layer is built. Do not drop
`recorder.cursor` on a fork: without it the copy would deliver its whole history again.

Both storages number their later entries alike, so the same id then names different records. That is why a record's
key is its storage and its id.

## License

MIT
