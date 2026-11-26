# @effectified/pi-review

Review before an answer stands, for [Pi Durable](../durable) agents, for `effect` 4.1, on
[`@effectified/pi-durable`](../durable-effect).

Every final answer of a conversation is reviewed before Pi settles the run that gave it:

- **A second model of another family** reads the task, the run and the answer, and reports findings.
- **Checks** of the product run on the answer: a citation check is built in, and a check of your own is an Effect.
- **A blocking finding** sends the run back with a correction message, at most N times per run.
- **After that the conversation is held**: the run stays open until a person accepts the answer or corrects it.
- **A review that could not run is deferred**: when the reviewer's request fails, the run stays open until the same
  review is asked for again.
- **Every verdict is an entry** of the conversation, written in the review task's own commit, with the reviewer's
  request as a product records a model call.

The package knows no model, no product and no person: the policy, the family table, the checks and the citation
verifier are yours.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-review-0.1.0.tgz $R/effectified-pi-durable-0.1.0.tgz @earendil-works/pi-durable @earendil-works/pi-ai effect
```

`effect` is a peer dependency (`~4.1.5`).

## Quick start

It runs as it stands, because both models are scripted; the same code is the test
[`test/readme.test.ts`](test/readme.test.ts).

```ts
import { fauxProvider } from "@earendil-works/pi-ai";
import { Models } from "@effectified/pi-ai";
import { answer, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Stream } from "effect";
import * as Review from "@effectified/pi-review";

// Policy as data: who reviews, the family of every model, how many corrective runs, what blocks.
const policy: Review.Policy.Policy = {
	reviewer: { provider: "reviewer-lab", modelId: "judge" },
	families: [
		{ provider: "author-lab", modelId: "writer", family: "alpha" },
		{ provider: "reviewer-lab", modelId: "judge", family: "beta" },
	],
	maxCorrections: 1,
	blocking: "block",
};

// Two scripted providers stand in for two model families: no network and no key.
const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
reviewer.setResponses([
	answer('{"findings":[{"severity":"block","text":"Six times seven is 42.","location":"It is 41."}]}'),
	answer('{"findings":[]}'),
]);

const live = Layer.effectDiscard(Models.use((models) => Effect.sync(() => models.setProvider(reviewer.provider)))).pipe(
	Layer.provideMerge(
		TestHarness.layer({
			extensions: [Review.extension({ policy })],
			responses: [answer("It is 41."), answer("It is 42.")],
			provider: { provider: "author-lab", models: [{ id: "writer" }] },
		}),
	),
);

const program = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	// Settles once an answer passed its review: here the second one.
	const settled = yield* root.prompt("What is six times seven?");
	yield* root.waitForIdle;
	const state = yield* Review.state(root);
	const verdicts = yield* Stream.runCollect(Review.verdicts(root));
	return { settled: settled.status, state: state._tag, outcomes: verdicts.map((entry) => entry.data.outcome._tag) };
});

Effect.runPromise(Effect.provide(program, live)).then(console.log);
// { settled: "done", state: "Reviewed", outcomes: ["Corrected", "Passed"] }
```

## Policy

`Review.Policy.Policy` is a `Schema` of plain JSON, so a product keeps it in its configuration and decodes it:

```ts
const policy = Schema.decodeUnknownSync(Review.Policy.Policy)({
	reviewer: { provider: "reviewer-lab", modelId: "judge" },
	families: [
		{ provider: "author-lab", modelId: "writer", family: "alpha" },
		{ provider: "reviewer-lab", modelId: "judge", family: "beta" },
	],
	maxCorrections: 1,
	blocking: "block",
	instructions: "Check every date against the transcript.",
});
```

| Field | |
|---|---|
| `reviewer` | The model that reads every answer: `{ provider, modelId }`, as Pi names models |
| `families` | The family table: one row `{ provider, modelId, family }` per model you use, authors and reviewer. The labels are yours. This package has no model name in it |
| `maxCorrections` | How many times one run may be sent back for a correction. A whole number from 0; 0 holds at the first blocking finding |
| `blocking` | The lowest severity that blocks: `info`, `warn` or `block`. Severities are ordered, so `block` always blocks |
| `instructions` | Optional: what the reviewer is told to look for, added after this package's own instructions |

**The family rule fails closed, and it is applied twice.** A model that is not listed has no family, and neither has
one listed twice under two labels.

1. **Before the request**, to the pair as configured: the answer's author and `policy.reviewer`. When the table does
   not place both in two different families, or the harness's `Models` do not have the reviewer, nothing is asked
   and no check runs.
2. **After the request**, to the pair as it happened: the answer's author and the model the reviewer's response
   names (pi-ai's `provider` and `model` of the message). They differ from the policy's when the reviewer is an alias
   of a router: the response names the route that served. When that model fails the rule, its findings are no
   review: they are dropped, no check of yours runs, and no correction is asked for.

Either way the answer gets a verdict with the outcome `NotReviewed` and the reason (`author_family_unknown`,
`reviewer_family_unknown`, `same_family`, `no_reviewer_model`). It is never recorded as passed.

- **The author** is the model that wrote the answer: the `provider` and `model` of the answer's own message, not the
  model the conversation is configured with. Behind an alias that is the route that wrote it.
- **A reviewer alias** needs a row for the alias (what step 1 reads) and one for every route of it (what step 2
  reads). A route the table does not place reviews nothing: `reviewer_family_unknown`.

```ts
const routed = Schema.decodeUnknownSync(Review.Policy.Policy)({
	reviewer: { provider: "router", modelId: "reviewer" }, // an alias
	families: [
		{ provider: "author-lab", modelId: "writer", family: "alpha" },
		{ provider: "router", modelId: "reviewer", family: "beta" }, // the alias
		{ provider: "reviewer-lab", modelId: "judge", family: "beta" }, // each of its routes
	],
	maxCorrections: 1,
	blocking: "block",
});
```

## Checks

A review is a list of checks on the finished answer. Each returns findings: `{ severity, text, location? }`.

1. **The model review** (`review.model`), always first. The reviewer gets one request without tools: the task (the
   run's first user message), the transcript of the run (user messages, the author's text and tool calls, tool
   results; no system messages and no thinking), and the answer. It answers with one JSON object,
   `{"findings":[…]}`, decoded with a `Schema`; a Markdown code fence around it is accepted.
2. **Your checks**, in the order you give them.

```ts
// A check of your own: an Effect over the answer. What it needs is a requirement of the registry.
class Glossary extends Context.Service<Glossary, { readonly banned: ReadonlyArray<string> }>()("app/Glossary") {}

const Wording = Review.Check.make("app.wording", (subject) =>
	Glossary.use(({ banned }) =>
		Effect.succeed(
			banned
				.filter((word) => subject.answer.includes(word))
				.map((word) => ({ severity: "warn" as const, text: `Do not say "${word}".`, location: word })),
		),
	),
);

// The citation check: your extractor finds the citations, your verifier says whether each one holds.
const Cited = Review.Citations.check((text) =>
	[...text.matchAll(/([^.\]]+?)\s*\[([^\]]+)\]/g)].map((match) => ({
		source: match[2] ?? "",
		claim: (match[1] ?? "").trim(),
	})),
);

const VerifierLive = Layer.succeed(Review.Citations.Verifier, {
	verify: (citation) =>
		Effect.succeed<Review.Citations.Verification>(
			citation.source === "atlas" ? { _tag: "Verified" } : { _tag: "Unresolved" },
		),
});

// A registry with this extension requires `Review.Citations.Verifier` and `Glossary`: without them it does not compile.
const reviewed = Review.extension({ policy, checks: [Cited, Wording] });
```

- **A check's subject** is `{ conversationId, answerId, answer, author, pass, transcript }`: the answer's entry and
  text, who wrote it, the number of this review within its run, and the run's model messages.
- **The citation check** (`review.citations`) takes an extractor, `(answer) => Citation[]` with
  `{ source, claim, location? }`, and asks the port `Review.Citations.Verifier` about each citation, one after
  another. `verify` answers `Verified`, `Unresolved` (it does not resolve) or `Unsupported` (it does not support its
  claim), the last two with an optional `reason`. Every citation that is not verified is a `block` finding.
- **A check that fails is not a finding.** A failure or a defect of a check, a verifier that fails, a reviewer
  request that failed and a reviewer answer that is not the findings object (`UndecodableReview`) are all kept as
  `failures` of the verdict. They never count as "nothing found". With a blocking finding of another check, the run
  is corrected as usual, and the failure is kept in the verdict. With no blocking finding, a failed check of the
  answer gives `NotReviewed` with the reason `check_failed`, and a failed request gives `Deferred`.
- **A failed request is not a failed check of the answer.** The reviewer's request failed when pi-ai gave an `error`
  or `aborted` response, a response still `pending` or `deferred` (Pi Durable takes neither as an answer:
  `ANSWERED` of `@effectified/pi-ai`), or no response at all: a provider outage, a refusal by whatever wraps the
  models. Nothing was said about the answer, so the review can be asked for again (see [Deferred](#deferred)). An answer that is not
  the findings object is a failed check: asking again is not known to help.
- **Nothing is retried by itself.** A check that should survive a flaky service retries inside its own Effect.

## The loop

At every final answer the extension's `onYield` hook asks for one review task. Pi appends the answer, keeps the
run's inputs open, and waits for the task. The task decides:

| Outcome | When | Transcript | The submission | `Review.state` |
|---|---|---|---|---|
| `Passed` | No blocking finding, no failed check | answer, `review.verdict` | Settles `done` with the answer | `Reviewed` |
| `Corrected` | A blocking finding, and the run has corrections left | answer, `review.verdict`, then Pi's `pi.user` entry with the correction message | Stays open: the same run goes on, and its next answer is reviewed again | `InReview` |
| `Held` | A blocking finding, and none left | answer, `review.verdict` | Stays `placed`. The conversation stays busy and new messages queue | `Held` |
| `Deferred` | No blocking finding, and the reviewer's request failed | answer, `review.verdict` | Stays `placed`, as for `Held` | `Deferred` with the provider's error text |
| `NotReviewed` | The family rule, a missing reviewer model, a failed check, or an abort | answer, `review.verdict` | Settles `done` with the answer | `NotReviewed` with the reason |

**Pi's `done` says the run ended, not that the answer is reviewed.** `Review.state` says that. Only `Passed`, and a
person's `Accept`, make an answer stand.

- **The correction message** carries every blocking finding, numbered, then the other findings as remarks.
  `Review.extension({ policy, correction })` takes a writer, `({ pass, blocking, remarks }) => string`; the default is
  `Review.Correction.standard`. A writer that throws gets the default text.
- **Corrections are counted per run**, from the verdicts stored in it: a verdict with the outcome `Corrected` is the
  count, written in the commit that asked for the correction. A new input starts a new run and a new count. A
  person's correction of a held answer is not counted: the next blocking verdict of that run holds again at once.

## Verdicts

Each review writes one entry of kind `review.verdict` (`Review.VerdictEntry`) into the reviewed conversation, in the
same commit as the task's decision: both are stored, or neither.

| Field | |
|---|---|
| `answer` | The entry id of the answer it is about |
| `inputs` | The submissions the reviewed run answers, as Pi's live run names them (`run.inputs`): which submission a verdict held or deferred. Absent from a verdict stored by an earlier version |
| `pass` | The number of this review within its run, from 1 |
| `corrections` | The corrective runs the run was sent on so far, this verdict's included |
| `author` | `{ provider, modelId, family? }`: the model that wrote the answer, as the answer's message names it |
| `reviewer` | The same for the model that reviewed, as the reviewer's response names it; the policy's reviewer when no response came |
| `call` | The reviewer's request: `{ provider, model, api?, responseModel?, responseId?, stopReason, timestamp?, durationMs?, usage?, error? }`. Absent when nobody was asked |
| `findings` | Every finding of every check, with the check's name, blocking or not |
| `failures` | `{ check, error }` for each check that failed |
| `outcome` | `Passed`, `Corrected`, `Held` with the waiting task, `Deferred` with the waiting task and the `attempt`, or `NotReviewed` with the reason |
| `time` | The harness clock when the verdict was decided, in epoch milliseconds |

- **`pass` is counted per answer.** A review that was deferred and asked for again writes a second verdict about the
  same answer with the same `pass`. `Review.state` reads the newest one.
- **`call` is what a product records as a model call**, field for field what pi-ai's response says:
  - `provider` and `model` are the response's, so behind an alias they name the route that served. `api` is the
    response's api; `responseModel` and `responseId` are there when the provider reported them.
  - `timestamp` is when the request started (pi-ai's `timestamp`), and `durationMs` how long the response took, when
    pi-ai measured it.
  - `usage` is `{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost, costs }`:
    `cost` is pi-ai's `usage.cost.total`, and `costs` is pi-ai's whole `usage.cost`, the cost of each kind of token
    with `totalFromProvider` when the provider billed the total.
  - `error` is the provider's error text of a failed request, as pi-ai gave it.
  - A request that ended without any response has no `usage`. It names the policy's reviewer, the reviewer model's
    `api`, and the harness clock it was sent at as `timestamp`.
  - A verdict stored by an earlier version has none of `api`, `timestamp`, `durationMs`, `responseModel`,
    `responseId`, `cacheWrite1h`, `reasoning` and `costs`, and still decodes.
- A verdict entry has no model message: the author never reads it, only the correction message. A fork sees the
  verdicts up to the entry it was forked at.

```ts
// What a record of the reviewer's model calls is made from: Pi's usage ledger does not hold these requests.
const verdicts = yield* Stream.runCollect(Review.verdicts(root));
const calls = verdicts.flatMap((entry) => {
	const call = entry.data.call;
	return call === undefined
		? []
		: [`${entry.id} ${call.provider}/${call.model} ${call.stopReason} ${call.usage?.totalTokens ?? 0}`];
});
```

A recorder that delivers entries without model messages, such as `@effectified/pi-recorder`, hands a sink every
`review.verdict` and `review.release` entry in order with the conversation's other records. `Review.VerdictEntry.schema`
and `Review.ReleaseEntry.schema` decode their data.

## Review state

```ts
const state = yield* Review.state(root); // a conversation handle of `@effectified/pi-durable`
const verdicts = yield* Stream.runCollect(Review.verdicts(root)); // every stored verdict, oldest first
const since = yield* Stream.runCollect(Review.verdicts(root, { from: entry })); // those from an entry on
```

`Review.State` is a `Schema`, a union of eight:

| | |
|---|---|
| `InReview` | The conversation works on an answer that has no final verdict: the author writes, a review runs, a corrective run does (`verdict` is then the one that asked for it), or a deferred review was asked for again (`verdict` is then the deferred one) |
| `Reviewed` | The newest answer passed its review |
| `Accepted` | The newest answer was held, and a person accepted it as it is: `verdict` and `release` |
| `Held` | The newest answer is held and waits for a person: `verdict`, and the `task` that waits |
| `Released` | The hold has its `decision`, durably, and the review task has not run since: nobody is waited for |
| `Deferred` | The reviewer's request for the newest answer failed: `verdict`, the `task` that waits, the `attempt`, and `reason`, the provider's error text |
| `NotRequired` | The conversation does not select the review extension, and its newest answer has no verdict |
| `NotReviewed` | The run ended, or never started, and the newest answer does not stand as reviewed: `reason` |

The state is bound to the newest assistant entry, so a verdict about an older answer never speaks for a newer one.
Besides a verdict's own reasons, `NotReviewed` has:

- `no_answer`: the conversation has no answer.
- `no_verdict`: the answer has no verdict, in a conversation that selects the extension. The review never ran or
  never finished: see [Limits](#limits).
- `correction_dropped`: a correction was asked for and Pi did not take it, and nothing has answered since.
- `hold_ended`: the answer was held and the conversation was aborted.
- `request_failed`: the review was deferred, and its task ended without reviewing and without a verdict of its own.

A verdict's own reasons include `review_aborted`: the conversation was aborted while the review ran, or while it
was deferred. The review task stores that verdict in the commit that ends it, with the request the reviewer had
already answered, so an aborted review does not read like one that was never asked for.

It is three committed reads, not one transaction: Pi's live document, the entries back to the newest answer, and
then the review task of a held or deferred answer, or the conversation's agent for an answer without a verdict.

### The waits of a transcript

`Review.state` says where the conversation stands now. What it went through is in its entries: a hold and a
deferral each begin with the verdict that put the review task to sleep, in the same commit. `Review.waitOf(verdict)`
gives that wait from the verdict alone: the `Held` or `Deferred` state, as `Review.state` read it while the wait
lasted, and none for a verdict that waited for nobody. It is the same however long ago the verdict was stored and
whatever ended the wait. A verdict's `inputs` say which submission waited.

```ts
// Every hold and deferral of a conversation, oldest first, read back after the fact.
const waits = (yield* Stream.runCollect(Review.verdicts(root))).flatMap((entry) =>
	Option.toArray(Review.waitOf(entry.data)),
);
```

A decision or a retry that was stored and not yet taken (`Released`, a retry under way), and a wait that ended in an
abort or a fault (`hold_ended`, `request_failed`), are not entries: `Review.state` reads them from the task.

## Held

When a run has a blocking finding and no correction left, its review task stores the verdict and goes to sleep on
a signal, in one commit. Pi's generation waits for that task, as for any `onYield` task. So in Pi's terms:

- The answer is in the transcript: Pi appended it before the review started.
- The submission is **not settled**: it stays `placed`, and `Submission.wait` does not return.
- The conversation is busy. A new message queues behind the held run. `waitForIdle` waits.
- Nothing runs and no process is needed: a sleeping task survives a close and a reopen.

A person releases it, through your host:

```ts
const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
// A held answer never settles its submission: wait for whichever comes first.
const held = root.changes().pipe(
	Stream.mapEffect(() => Review.state(root)),
	Stream.filter((state) => state._tag === "Held"),
	Stream.runHead,
	Effect.map(Option.getOrThrow),
);
const outcome = yield* Effect.raceFirst(Effect.andThen(submission.wait, Review.state(root)), held);
// Later, once your host has authenticated the person who decides:
const delivery =
	outcome._tag === "Held" ? yield* Review.release(root, { _tag: "Accept", by: "user:ada" }) : "not held"; // "released"
const ended = yield* Review.waitForHoldEnd(root); // `Accepted`: the review task took the decision
const settled = yield* submission.wait; // done: the answer stands as it is
```

`Review.release(conversation, decision)` delivers a `Review.Decision` to the waiting task in one commit:

| | |
|---|---|
| `{ _tag: "Accept", by, note? }` | The answer stands as it is. Pi settles the submission `done` |
| `{ _tag: "Correct", by, correction }` | The run continues with `correction` as a user message, and the next answer is reviewed again |

```ts
yield* Review.release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
```

It succeeds with `released`, or with `already_released` when the hold already has a decision, which stands. It
fails with `NotHeld` for a conversation that is not held. The task then records the decision as an entry of kind
`review.release` (`Review.ReleaseEntry`: `{ answer, decision, time }`) in the commit that ends the hold. `by` is an
opaque principal your host supplies; nothing here checks who calls `release`.

**`release` returns once the decision is stored, not once it is applied.** The task takes it when a harness next
schedules it. In between:

- `Review.state` reads `Released`, with the `decision`. It reads `Held` only while nobody decided.
- `Review.waitForHoldEnd(conversation)` waits for the review task of the hold to end and gives the state then:
  `Accepted` after an `Accept`, `InReview` after a `Correct`, `NotReviewed` (`hold_ended`) after an abort. A
  conversation that is neither `Held` nor `Released` gets its state at once. A hold nobody releases keeps it waiting,
  and so does a harness that schedules nothing (`resume: false`).

## Deferred

When the reviewer's request fails and no other check blocks the answer, nothing judged the answer. The review task
stores a verdict with the outcome `Deferred` and goes to sleep on a signal, in one commit. In Pi's terms it is a
hold nobody has to decide about:

- The answer is in the transcript, and the submission is **not settled**: it stays `placed`.
- The conversation is busy, a new message queues, and nothing runs. The sleeping task survives a close and a reopen.
- `Review.state` reads `Deferred`. Its `reason` is the provider's error text, unchanged, so a host reads out of it
  whatever its model boundary put there: a budget's refusal, a rate limit.

```ts
const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
// A deferred review does not settle its submission either: watch the state, as for a hold.
const deferred = root.changes().pipe(
	Stream.mapEffect(() => Review.state(root)),
	Stream.filter((state) => state._tag === "Deferred"),
	Stream.runHead,
	Effect.map(Option.getOrThrow),
);
const outcome = yield* Effect.raceFirst(Effect.andThen(submission.wait, Review.state(root)), deferred);
const reason = outcome._tag === "Deferred" ? outcome.reason : ""; // "overloaded": the provider's own words
// Later, once the reviewer can be reached and paid for again:
const asked = outcome._tag === "Deferred" ? yield* Review.retry(root) : "not deferred"; // "retrying"
const settled = yield* submission.wait; // done: the same answer, reviewed as the same pass
```

`Review.retry(conversation)` delivers the request to the waiting task in one commit. The task then reviews the
same answer again:

- **The same task and the same checks.** One new request to the reviewer, then every check of yours again. Each
  attempt keeps its reports in memos of its own, so a restart during it asks nothing twice.
- **The same pass.** The new verdict has the `pass` of the deferred one. Both stay in the transcript.
- **The whole loop afterwards.** A pass settles the submission `done`. A blocking finding corrects the run or holds
  it. A request that fails again defers again, as the next `attempt`.

It succeeds with `retrying`, or with `already_retrying` when the task was asked and has not stored its next verdict
(the state then reads `InReview` with the deferred verdict). It fails with `NotDeferred` for any other conversation.
Like `release`, it returns once the request is stored: a harness opened with `resume: false` takes it and runs
nothing.

Nothing asks again by itself. An abort ends a deferred review as it ends a hold: the submission settles `done`, and
the state reads `NotReviewed` (`review_aborted`).

## Conversations that are not reviewed

The review is a hook of the extension `review`, and Pi asks only the hooks of the extensions a conversation
selects. A conversation that does not select it is not reviewed: no hook, no task, no request.

```ts
// A conversation that is not reviewed, among reviewed ones: it is created without the extension.
const unreviewed = yield* Harness.createConversation({
	ownership: { kind: "ownerless" },
	agent: { model: { provider: "author-lab", modelId: "writer" }, extensions: { remove: [Review.NAME] } },
});
const settled = yield* unreviewed.prompt("What is six times seven?"); // done, and nobody was asked to review
const state = yield* Review.state(unreviewed); // { _tag: "NotRequired" }

// The same inside a commit, for a conversation the commit creates.
const created = yield* Harness.commit((tx) =>
	Effect.gen(function* () {
		const record = yield* tx.createConversation({ ownership: { kind: "ownerless" } });
		yield* tx.configure(record.id, { extensions: { remove: [Review.NAME] } });
		return record.id;
	}),
);
```

- **`NotRequired` is not a failure.** It says that the conversation does not select the extension and that its
  newest answer has no verdict. Its submission settles `done` as Pi alone would settle it.
- **The selection is Pi's stored agent** (`pi.agent`), written in the creating commit, so it is durable and a fork
  copies it. A conversation a task owns (a subagent's child) starts as a copy of its owner's agent: a child of a
  reviewed conversation is reviewed unless its creator removes the extension, in the commit that creates it.
- **It is read as selected now.** `Review.state` reads the conversation's agent only for an answer without a
  verdict. An answer that was given while the extension was selected and has a verdict keeps its state.
- This package adds no switch of its own: one stored selection decides both whether Pi asks the hook and what the
  state says.

## Restarts

Everything is in the harness storage: the verdict entries, the release entries, the sleeping task of a hold, and
the memos of a running review. Tested on a SQLite file with both drivers:

- **The reviewer is asked once per verdict.** Each check's report, the model review's included, is a memo of the
  review task as soon as the check answered. A harness closed after the reviewer answered and before the verdict
  was committed runs the task again when it reopens: it finds the memo, asks nothing twice, and stores the verdict
  once. A check that had not answered runs again.
- **A restart grants no extra correction.** The count is the verdicts of the run, and a verdict is stored with the
  decision it counts.
- **Held stays held.** After a reopen the state is `Held` by the same task, and nobody is asked again. A harness
  opened with `resume: false` is enough to take a decision: the state then reads `Released`, and the decision is
  applied when a harness next schedules.
- **Deferred stays deferred.** After a reopen the state is `Deferred` by the same task, with the same reason, and
  nobody is asked again. A harness opened with `resume: false` is enough to take a `retry`: the state then reads
  `InReview`, and the review runs when a harness next schedules.

## Cost and budgets

- The reviewer's request goes through the harness's own `Models` (the task's `api.pi.models`), so whatever wraps
  them at the model boundary, such as `@effectified/pi-budget`, sees it.
- It carries the reviewed conversation's provider session (Pi's `pi.provider` document, read through its own token)
  as pi-ai's `sessionId`: the id Pi sends with the conversation's own requests. A cap per conversation counts the
  review. A conversation without one yet sends none.
- One request per verdict, so at most `maxCorrections + 1` per run, plus one for every answer to a person's
  correction. The reviewer reads the whole run: nothing here shortens a transcript that outgrows its context window.
- A request a budget refuses is a failed request: the review is `Deferred`, with the budget's own refusal text as
  the state's `reason` and the verdict's `call.error`. Once the budget covers the conversation again, `Review.retry`
  reviews the answer.
- Pi's usage ledger (`Harness.usage`) counts a conversation's own requests, not the reviewer's: the verdict's
  `call` is where a review's tokens are kept.

## Where it belongs in a registry

```ts
const live = Harness.layer().pipe(
	// Guards first, then your tools, then the review: the only extension with an `onYield` hook.
	Layer.provide(Registry.layer([Guards, Review.extension({ policy })])),
	Layer.provide(Storage.memory),
	// Both models come from the harness's `Models`: a budget that wraps them covers the reviewer too.
	Layer.provide(Models.layer([author.provider, reviewer.provider])),
);
```

Hooks are asked in extension order, and Pi takes the **first** `onYield` answer. The review answers at every final
answer, so:

- An extension before it whose `onYield` hook answers (a continuation, or tasks of its own) takes the answer away
  from the review: that answer has no verdict, and `Review.state` reads `NotReviewed`, `no_verdict`. A hook that
  declines is harmless.
- An extension after it with an `onYield` hook is never asked.

A product with a second `onYield` concern makes it a check of the review, or runs it in `afterRun`, which sees only
answers the review let stand.

## What holds

- **Another family, or no review.** The reviewer is never asked about an answer of its own family or of an unknown
  one as configured, and an answer is never recorded as passed when the model that answered the reviewer's request
  is of the author's family or of an unknown one.
- **At most N corrective runs per run**, counted in the storage. Then the run is held.
- **A held answer does not settle its submission** until a person released it, and a deferred one not until it was
  reviewed again.
- **One request to the reviewer per verdict**, across a close and a reopen.
- **A verdict and its decision are one commit.**
- **A failed check never passes an answer**, and neither does a failed request.
- **An aborted review leaves a verdict** that says so.

## Limits

- **Pi can end a run around the review.** A hook that fails is skipped; `Conversation.abort` ends a run in review,
  held or deferred and settles its inputs `done`; a review task that faults, or a process that died
  `settings.restartLimit` times during one, ends the run with the answer. In each case the submission settles
  `done`, and `Review.state` reads `NotReviewed`: `review_aborted` or `hold_ended` after an abort, `no_verdict` or
  `request_failed` otherwise. Read the state, never the submission alone.
- **An abort's verdict needs the run.** The review task reads the answer it reviews from Pi's live run. An abort
  handler that finds none, or whose commit Pi refuses, ends the task without a verdict: the state then reads
  `no_verdict`.
- **A reviewer that falls back to the author's family reviews nothing.** The answer is `NotReviewed`
  (`same_family`), the request was paid for, and the run ends: nothing asks again. Keep the routes of a reviewer
  alias in families other than the authors'.
- **A fork reads its parent's hold.** A fork sees its parent's verdicts up to the entry it was forked at. Forked
  after a `Held` or `Deferred` verdict, it reads that state with the parent's task, and a `release` or `retry` of
  the fork reaches the parent's task.
- **A queued message replaces a correction.** Pi takes a continuation only when no user message and no reset is
  queued. A message sent while a review runs, or while the conversation is held, makes Pi drop the correction, the
  automatic one or a person's, and settle the run `done` with the blocked answer. The queued message is answered
  next, and that answer is reviewed in its own right. A person's `Correct` is still recorded.
- **`NotReviewed` lets the run end.** It is a durable label, not a hold: your host decides what an unreviewed answer
  is worth.
- **A held conversation blocks**, and so does a deferred one. Its queue does not move until a person decides, the
  review is asked for again, or it is aborted.
- **`Released` is read from a task's memo.** Pi gives a task's own handlers `readSignal` and a host nothing. The
  state reads what Pi's specification says a delivery stores, the task's memo `pi.signal.<name>/<key>`, through
  `Signal.stateIn` of `@effectified/pi-durable`: a memo another version of the signal stored fails the read with
  `SchemaDecodeError`.
- **The state is a snapshot** of three reads; a commit between them can make it one step old.
- **Findings are stored as text** in the conversation, with the reviewer's words.

## What your host does

- Supplies the policy, the family table, the citation extractor and the `Review.Citations.Verifier`.
- Reads `Review.state` after a submission settled, and treats only `Reviewed` and `Accepted` as standing, and
  `NotRequired` as the answer of a conversation it chose not to review.
- Watches for `Held`, shows the verdict's findings to a person it authenticates, and calls `Review.release`.
- Watches for `Deferred`, reads the `reason`, and calls `Review.retry` once the reviewer can be asked again.
- Removes the extension, in the creating commit, from every conversation whose answers go to a program and not to
  a person: subagent children, forks of a fan-out.
- Keeps messages out of a conversation it wants corrected: a queued message replaces the correction.

## License

MIT
