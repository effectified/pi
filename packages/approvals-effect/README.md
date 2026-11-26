# @effectified/pi-approvals

Human approval of tool calls for [Pi Durable](../durable) agents, for `effect` 4.1, on
[`@effectified/pi-durable`](../durable-effect).

A tool call that needs a person's approval parks before it runs. It holds no process, survives restarts, and runs only
once someone approved exactly the arguments it has. The result says who decided.

- **Policy** from the product: tools by name, and optionally a rule that is an Effect over the call.
- **A typed request** for each ask, with a digest of the arguments and an expiry, shown through a port you provide.
- **A typed decision**, approved or denied, bound to that digest, delivered with `decide`.
- **Pending requests** listed from the harness storage, and **who decided** kept with the tool's result.

The package authenticates nobody and knows no product: it parks, binds and records.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-approvals-0.1.0.tgz $R/effectified-pi-durable-0.1.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`).

## Quick start

It runs as it stands, because the model is scripted; the same code is the test
[`test/readme.test.ts`](test/readme.test.ts).

```ts
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { Tool } from "@effectified/pi-durable";
import { answer, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import * as Approvals from "@effectified/pi-approvals";

const Transfer = Tool.make("transfer", {
	description: "Transfer money to someone.",
	parameters: Schema.Struct({ to: Schema.String, amount: Schema.Number }),
	success: Schema.String,
	handler: ({ to, amount }) => Effect.succeed(`sent ${amount} to ${to}`),
});

// The port: where your product shows a request to a person. Here, a queue the program below reads.
const shown = Effect.runSync(Queue.unbounded<Approvals.Request>());
const InboxLive = Layer.succeed(Approvals.Inbox, {
	publish: (request) => Effect.asVoid(Queue.offer(shown, request)),
});

const live = TestHarness.layer({
	extensions: [
		{ name: "app", tools: [Transfer] },
		// After every extension that blocks or rewrites tool calls.
		Approvals.extension({ tools: ["transfer"], expiresAfter: "1 day" }),
	],
	// No provider and no key: the model answers with these turns, in order.
	responses: [toolCall("transfer", { to: "bob", amount: 250 }), answer("Sent.")],
}).pipe(Layer.provide(InboxLive));

const program = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const submission = yield* root.submit({ type: "input", content: "Send bob 250." });
	// The call parks before it runs and holds no process. The inbox was shown what it would run with.
	const request = yield* Queue.take(shown);
	// Later, once your host has authenticated the person who decides:
	const delivery = yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada"));
	// The tool runs once, with exactly the arguments of the request, and the model answers.
	const settled = yield* submission.wait;
	yield* root.waitForIdle;
	// Who decided is kept with the tool's result.
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	const records = yield* Effect.forEach(entries, Approvals.applied);
	return { request, delivery, settled: settled.status, record: records.find(Option.isSome) };
});

Effect.runPromise(Effect.provide(program, live)).then(console.log);
```

With a real harness, install the extension in `Registry.layer([...])` and provide `Approvals.Inbox` to it.

## Policy

Which calls need approval is yours to say:

```ts
class Limits extends Context.Service<Limits, { readonly free: number }>()("app/Limits") {}

const policy: Approvals.Policy<Limits> = {
	// Every call of these tools needs approval.
	tools: ["close_account"],
	// A call of any other tool needs it when this says so. A rule that fails means it does.
	rule: (call) =>
		Limits.use((limits) =>
			Effect.succeed(call.tool === "transfer" && Number(call.arguments.amount) > limits.free),
		),
	// How long a request stays open.
	expiresAfter: "1 day",
};
// A registry with `Approvals.extension(policy)` requires `Limits` and `Approvals.Inbox`.
```

- The rule gets `{ tool, arguments, conversation, callId }`, with the arguments as the hooks before the gate left them.
- A rule that fails or dies asks a person: the gate fails closed.
- The rule is asked until a call first needs approval. From then on the call needs a decision for every change of its
  arguments, whatever the rule would say.
- `expiresAfter` is any finite Effect `Duration` input. The expiry is fixed when a request is first made, on the
  harness clock, and never moves when Pi asks again.

## The request

`Approvals.Request` is a `Schema` of plain JSON:

| Field | |
|---|---|
| `id` | `<task>:<n>:<digest>`: the tool call's task, the number of the ask (from 0), the digest. The same every time |
| `conversation`, `task`, `callId`, `tool` | Where the call is: `task` is the tool call's task, which `decide` signals |
| `arguments` | What the call would run with, as strict JSON in canonical key order |
| `digest` | SHA-256 of the canonical JSON of `arguments`, 64 hexadecimal digits |
| `askedAt`, `expiresAt` | Epoch milliseconds on the harness clock |

`Approvals.Inbox` is the port: `publish(request)` shows a request to a person. Pi asks the gate again after every
reopen of the harness and after every registry change, so `publish` gets a request **at least once and possibly
again**, always with the same `id`. Deduplicate by it. A `publish` that dies blocks the call.

The digest is `Approvals.Digest.of(arguments)`: the SHA-256, from Web Crypto (`crypto.subtle`, a global on Bun, Node
22 and Workers), of the canonical JSON as RFC 8785 writes it (keys sorted by UTF-16 code unit, no whitespace).

```ts
const digest = yield* Approvals.Digest.of({ to: "bob", amount: 250 });
const same = yield* Approvals.Digest.of({ amount: 250, to: "bob" }); // equal to `digest`
```

## The decision

`Approvals.Decision` is a `Schema`, a union of two:

| | |
|---|---|
| `{ _tag: "Approved", digest, by, at }` | The call may run with the arguments of `digest` |
| `{ _tag: "Denied", digest, by, at, note? }` | It must not; the model is told `note` |

`by` is an opaque principal that your host supplies after it authenticated the person; `at` is epoch milliseconds.
`Approvals.approve(request, by)` and `Approvals.deny(request, by, note?)` make one for a request, now on the `Clock`.

```ts
const denial = yield* Approvals.deny(request, "user:bob", "Over this month's limit.");
const delivery = yield* Approvals.decide(request, denial);
// The tool never runs. The model reads: Tool call blocked: Approval denied: Over this month's limit.
```

`Approvals.decide(request, decision)` takes a request or its address (`{ task, id }`) and delivers the decision in
one commit that checks the request and stores the decision together. It answers:

| | |
|---|---|
| `delivered` | Stored with the call, which now runs or is refused by it |
| `already_decided` | The request holds an earlier decision, which stands |
| `superseded` | The call's arguments changed since, and it asks under a newer request. Nothing was stored |
| `gone` | No decision can reach the call any more: it ran, was refused or aborted, or the request expired |
| `unknown` | There is no such tool call, or it never made this request |

It fails with `DigestMismatch`, and stores nothing, for a decision that names another digest than the request's.

```ts
// A second decision changes nothing, and neither does one for a call that ended.
const late = yield* Approvals.decide(request, yield* Approvals.approve(request, "user:ada")); // "gone"
```

## Pending requests

```ts
// Every request a decision can still reach, read from the harness storage: the same after a restart.
const open = yield* Approvals.pending;
```

It reads the live task records of the harness (`Harness.inspect`): the gate keeps each request in a memo of the tool
call's task (`approvals.ask/<n>`), and Pi keeps the state of the request's signal key beside it. So it needs no inbox
and works on a harness opened with `resume: false`. A request is listed from its first ask until it is decided, it
expires, or its call is aborted.

## Who decided

The extension writes what the gate decided by into the tool's result, which Pi stores in the tool result entry
(`pi.tool-result`): `model[0].details.approvals` holds `{ request, outcome }` as JSON. `Approvals.applied(entry)`
decodes it; a recorder can read the JSON without this package.

| `outcome` | On |
|---|---|
| `Approved` (the decision) | The result of the tool, which ran on it |
| `Denied` (the decision) | The blocked result |
| `{ _tag: "Expired" }` | The blocked result |
| `{ _tag: "Undecided" }` | The result of a call aborted while it waited |

It is there for as long as the entry is: compaction never removes entries. While the call is live, the decision is
also in the task record, which Pi clears when the call ends.

## What holds

- **Bound to the digest.** A decision is delivered under the request's id, which contains the digest, and the gate
  reads only the id of the request for the arguments it has now. A decision for other arguments is therefore never
  read: `decide` refuses it (`DigestMismatch`, `superseded`), and even stored it releases nothing.
- **Changed arguments ask again.** When a hook before the gate rewrites the arguments between two asks, the gate makes
  a new request with a new id and a new expiry. The old approval is not used.
- **Once.** An approved call runs when Pi next asks the gate; a second decision is `already_decided` or `gone`.
- **Denied and expired never run.** The model gets an error result: `Approval denied: <note>`, or
  `The approval request expired without a decision`.
- **Survives restarts.** The parked call, its request, its expiry and a delivered decision are in the harness storage.
  Tested on a SQLite file with both drivers.

## Limits

- **Order matters.** Install the extension after every extension that blocks or rewrites tool calls: a call a guard
  blocks never asks a person. A hook installed after it that rewrites the arguments makes the tool run with arguments
  nobody saw; nothing in Pi lets a gate prevent that.
- **A decision needs an open harness.** A signal is a commit of a harness. For a session whose process is gone, open
  the harness, then call `decide`; `resume: false` is enough, and the call runs at the next open that schedules.
- **Authentication is yours.** Nothing checks who calls `decide` or what `by` holds.
- **The record has gaps.** It is not written when the tool reports details that are no object (they stay as they
  are), when Pi skips `afterTool` (past `settings.restartLimit`, or for a task the scheduler faulted), or when the
  hook itself fails, which Pi reports. A second extension that replaces `details` after this one removes it, and an
  `approvals` key of the tool's own details is replaced.
- **`gone` does not say why.** Once a call ended, Pi has dropped its requests: expiry, abort and completion answer the
  same, and so does any id sent to an ended tool call.
- **A parked call keeps its run busy.** New input queues behind it until it is decided, expires or is aborted.
- **Requests live in the task record**, arguments included, while the call is live. Pi keeps live task records in
  memory: arguments of megabytes do not belong in a call that waits for a person.
- **One clock.** Expiries are stored on the harness clock; every process that opens one storage must use the same.

## What your host does

- Authenticates the person and passes a principal as `by`.
- Shows requests from `Inbox.publish`, deduplicated by `id`, and lists `Approvals.pending` after a restart.
- Calls `decide` and treats `already_decided`, `superseded` and `gone` as final.
- Wakes the process at the earliest expiry when it uses `hostWakes` (`Harness.wakes`), as for any sleeping task.

## License

MIT
