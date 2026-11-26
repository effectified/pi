# @effectified/pi-budget

A budget lease for Pi agents in Effect, for `effect` 4.1. No provider request of a Pi Durable harness goes out
without money reserved for it under a lease the product owns, every response is settled against that lease, and a
harness whose lease is gone stops cleanly and can be continued.

- **Reserve, send, settle.** Each provider request first reserves an estimate on the product's `Lease`, and tells
  it what the request really cost when it ended: returned, failed or aborted.
- **Money through a price table.** Prices are data, per provider and model, in integer micro units; a cost is
  exact `bigint` arithmetic, rounded up once per response. A model without a price is refused.
- **A fenced lease stops the run.** The request is not sent and is not retried. The run ends with a typed reason
  that Pi stores, and one Effect continues it under a new lease.
- **Shares.** Every conversation draws on the harness's lease; one conversation (a subagent) can have a cap of
  its own, kept in the harness storage and set in the commit that creates it. What a conversation with a share
  has settled is one read.
- **Spend from elsewhere.** Usage that reached the budget as no response, such as a router's attempt that failed
  before another route served, is charged to the same lease and share through `Spend`.
- **Events** for every reservation, settlement and refusal: amounts, model and outcome, never content.

It knows no product rule: the lease, the size of a reservation, the prices and the currency are the product's.
Built for pi-ai 1.6.1 and Pi Durable 1.6.1, on [`@effectified/pi-ai`](../ai-effect) and
[`@effectified/pi-durable`](../durable-effect).

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install $R/effectified-pi-budget-0.1.0.tgz $R/effectified-pi-durable-0.1.0.tgz $R/effectified-pi-ai-0.1.0.tgz @earendil-works/pi-durable @earendil-works/pi-ai effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Where the lease is enforced

A Pi hook cannot stop a model request: a failing generation hook is reported and skipped. The one place every
provider request passes, whoever makes it (a generation, a compaction summary, a tool that uses `api.models`), is
the pi-ai `Models` the harness is opened with. `BudgetedModels.layer` takes the `Models` of the context and
provides a `Models` whose requests reserve first and settle after, so a harness opened on it cannot make an
unreserved request.

## The lease

The product provides `Lease`, a service with two Effects.

```ts
import { Effect, Layer } from "effect";
import { Lease, LeaseFenced } from "@effectified/pi-budget";

/** A product's lease. This one is a wallet in memory; a real one is a row the product fences and renews. */
const wallet = { left: 1_000_000n, held: new Map<string, bigint>(), fenced: false };

const WalletLease = Layer.succeed(Lease, {
	reserve: (estimate, request) =>
		Effect.suspend(() => {
			if (wallet.fenced) return Effect.fail(new LeaseFenced({ reason: "fenced" }));
			if (wallet.left < estimate) return Effect.fail(new LeaseFenced({ reason: "out_of_money" }));
			const token = `${request.provider}/${request.model}#${wallet.held.size + 1}`;
			wallet.left -= estimate;
			wallet.held.set(token, estimate);
			return Effect.succeed(token);
		}),
	settle: (token, settlement) =>
		Effect.sync(() => {
			// The reservation goes back and the real cost comes off, whether the request returned, failed or was aborted.
			wallet.left += (wallet.held.get(token) ?? 0n) - settlement.cost;
			wallet.held.delete(token);
		}),
});
```

- `reserve(estimate, request)` gives the token of a reservation, or fails with `LeaseFenced` and the product's own
  `reason` (gone, expired, out of money). `request` says what is asked: `kind` (`chat`, `deferred`, `images`,
  `classifier`), `provider`, `model`, `session` and `conversation` when known, `requestKey` for a chat request with
  a session (the same for every send of one request: see [Guarantees and their limits](#guarantees-and-their-limits)),
  and `key` for a spend recorded through `Spend`.
- `settle(token, { usage, cost, outcome })` is called exactly once for every token, whatever happened: `usage` is
  what the provider reported (zeros when it reported nothing), `cost` is that usage at the price table, and
  `outcome` is `returned`, `failed` or `aborted`.
- Both run uninterruptibly, so a reservation made is never lost. Keep them short, or give them a timeout.

## Prices and the estimate

```ts
import { Estimator, type PriceTable } from "@effectified/pi-budget";

const table: PriceTable = {
	currency: "USD",
	// Per million tokens, in millionths of the currency: USD 3.00 in, USD 15.00 out.
	prices: [
		{ provider: "faux", model: "faux-1", input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
	],
};

// What the product sets aside for one request: here always 5 cents.
const estimate = Estimator.fixed(50_000n);
```

- The four kinds are pi-ai's: `input` is the input neither read from nor written to the cache, `output` includes
  reasoning. A cost is pi-ai's (`calculateCost`): each count times its price, cache writes kept for one hour
  (`cacheWrite1h`, a part of `cacheWrite`) at twice the input price, summed exactly, divided by a million and rounded
  up once.
- A price may have `tiers`, as pi-ai's model costs do: a request whose input tokens (`input`, `cacheRead` and
  `cacheWrite` together) are more than a tier's `inputTokensAbove` is charged at that tier's prices for all of its
  tokens, the tier with the highest threshold below it winning. `{ ..., tiers: [{ inputTokensAbove: 200_000, input:
  6_000_000, output: 30_000_000, cacheRead: 600_000, cacheWrite: 7_500_000 }] }`.
- `Prices.layer(table)` fails with `InvalidPriceTable` for a table that is not whole numbers or lists a model
  twice. `Prices` also gives `priceOf` and `cost` as Effects, for an estimator that reads the table.
- `Estimator` is a port: `Estimator.fixed(micros)`, or `Layer.succeed(Estimator, { estimate: (request) => … })`
  for a rule that depends on the request. The budget has no pricing opinion of its own.

### Prices behind a router

Behind [`@effectified/pi-router`](../router-effect) a request is asked of an alias (`router/author`) and answered
by a route (`openrouter/anthropic/claude-haiku-5.5`). The budget uses two prices for it:

- **Before it is sent**, the model that was asked: the alias. Without a row for it the request is refused
  (`PriceMissing`). The `Estimator` is given the alias too.
- **When it is settled**, the model the response names: the route that served. A response the provider failed
  names its route as well, and so does what had arrived of a request that was cut off. Only a response that names
  a model the table does not list, or a request that ended before any of it arrived, is settled at the alias's
  price; the second has no usage and costs nothing.

So the table needs a row for each route's model and a row for each alias. The router gives both from its route
table, as plain data in the shape of `PriceTable`: `priceRows(routes)`. Neither package imports the other; the rows
below are what it returns for an alias `author` with two routes.

```ts
import { Prices, type PriceTable } from "@effectified/pi-budget";

// From the product's route table: `yield* priceRows(routes)` of @effectified/pi-router, written out.
const routerRows: PriceTable = {
	currency: "USD",
	prices: [
		// Each route's model at the route's price: what a response is settled at.
		{ provider: "openrouter", model: "anthropic/claude-haiku-5.5", input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
		{ provider: "local", model: "qwen-3-coder", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Each alias at the highest price of its routes for each kind of token: what a request is checked against.
		{ provider: "router", model: "author", input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
	],
};

const routerPrices = Prices.layer(routerRows);
```

Both packages price in the same units (integer micro units per million tokens), by pi-ai's rule, and round the same
way: summed exactly, rounded up once per response, a count that is not a whole number rounded up, one that is not a
positive number counted as zero, one-hour cache writes counted at most all of `cacheWrite`. The cost in a route event is the cost this budget settles for the same usage.

## Compose

```ts
import { Effect, Layer } from "effect";
import { Harness, Registry, Storage } from "@effectified/pi-durable";
import { ScriptedModels } from "@effectified/pi-durable/testing";
import { BudgetedModels, Prices, Shares } from "@effectified/pi-budget";

const budget = Layer.mergeAll(WalletLease, estimate, Layer.orDie(Prices.layer(table)));

// The `Models` of this Layer is the budgeted one. The providers go underneath it.
const budgeted = BudgetedModels.layerWithShares.pipe(
	Layer.provideMerge(Shares.layer),
	Layer.provide(budget),
	Layer.provideMerge(ScriptedModels.layer()), // with real providers: Layer.provide(Models.layer([anthropicProvider()]))
);

const live = Shares.attach.pipe(
	Layer.provideMerge(Harness.layer()),
	Layer.provideMerge(budgeted),
	Layer.provide(Layer.orDie(Registry.layer([]))),
	Layer.provide(Storage.memory),
);

/** The scripted model as an agent, for the conversations of the examples below. */
const agent = ScriptedModels.use(({ model }) =>
	Effect.succeed({ model: { provider: model.provider, modelId: model.id } }),
);
```

The examples of this README run as they stand, because the model is scripted (`ScriptedModels` and `answer` of
`@effectified/pi-durable/testing`, whose provider is `faux` and whose model is `faux-1`); they are the test
[`test/readme.test.ts`](test/readme.test.ts).

- **Order.** The budgeted `Models` sits directly under the harness. Everything that makes provider requests on
  its own goes underneath: the providers, and [`@effectified/pi-router`](../router-effect).
- **With the router.** Build `Router.layer(routes)` and `BudgetedModels` on the same plain `Models` value, and open
  the harness on the budgeted one. The harness asks for an alias, so one harness request is one reservation, settled
  with the usage of the request's last attempt. The table needs a row for the alias and for each route's model (see
  [Prices behind a router](#prices-behind-a-router)). An attempt that failed before another route served is handed
  to the router's settlement port, which the product implements with `Spend` (see
  [Spend the budget did not see](#spend-the-budget-did-not-see)).
- **Without shares**, use `BudgetedModels.layer` and leave out `Shares.layer` and `Shares.attach`.
- **With shares**, `Shares.attach` must be built on the harness: until it is, every request that names a session
  waits. That is what keeps a cap in force when a reopened harness continues unfinished work at once.
- This package installs no extension, so it has no place in the order of `Registry.layer([...])`.

## Events

```ts
const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([answer("Hello.")]);
	const events = yield* BudgetEvents.use((hub) => hub.subscribe);
	const message = yield* complete(scripted.model, {
		messages: [{ role: "user", content: "Hello", timestamp: 0 }],
	});
	const [reserved, settled] = yield* Stream.runCollect(Stream.take(events, 2));
	return { message, reserved, settled, left: wallet.left };
}).pipe(Effect.scoped);
// reserved: { _tag: "Reserved", request, reservation, estimate: 50000n, currency: "USD", at }
// settled:  { _tag: "Settled", request, reservation, estimate, usage, cost: 39n, outcome: "returned", currency, at }
```

`BudgetEvents` is provided by `BudgetedModels.layer`. `subscribe` gives the events from now on; `stream` those
from the moment it runs. `Refused` carries the typed refusal and no reservation. `BudgetEvent` is a `Schema`, so an
event encodes to JSON.

## Spend the budget did not see

The budgeted `Models` settles what a response says was used. Usage that reaches it as no response is charged
through `Spend`, which `BudgetedModels.layer` and `layerWithShares` provide on the same lease, prices, events and
shares. The case it is for: a router's attempt that failed after using tokens and that another route took over. The
harness's request ends with the serving route's message, so the budgeted `Models` never sees the failed attempt.
[`@effectified/pi-router`](../router-effect) hands that attempt to a port, `AttemptSettlement`, and waits for the
answer before it tries the next route. A product implements the port with `Spend`:

```ts
import { Effect, Layer } from "effect";
import { Spend } from "@effectified/pi-budget";
import { AttemptSettlement } from "@effectified/pi-router";

/** Charges each attempt another route takes over to the budget, before that route is tried. */
const SettleAttempts = Layer.effect(
	AttemptSettlement,
	Effect.gen(function* () {
		const spend = yield* Spend;
		return AttemptSettlement.of({
			settle: (event) =>
				spend.record({
					key: `${event.requestId}#${event.attempt}`,
					provider: event.route.provider,
					model: event.route.model,
					session: event.sessionId,
					requestKey: event.requestKey,
					usage: event.usage,
					outcome: "failed",
				}),
		});
	}),
);
```

Provide it under `Router.layer(routes)`, with this budget's Layer under it for `Spend`, and the plain `Models` under
the router itself: the router's README has the lines. Neither package imports the other; this is product code, and
this package's test runs it against a stand-in with the port's signature, fed route events as plain data.

**The rule:** settle exactly the attempts the router hands to the port, with no filter of your own. The router hands
over each attempt that failed, cost something and is being taken over by another route. It never hands over a
request's last attempt, served or failed: that one's usage is in the message the request ended with, which the
budgeted `Models` settles, so nothing is charged twice.

- **Inside the request.** The router waits for `settle`, so the lease is told in this order: `reserve` for the
  request, `reserve` and `settle` for the failed attempt, `settle` for the request. The attempt is on the lease and
  in the conversation's share before its request ends, and an outcome read at that moment has it.
- **When `record` fails here** (a fenced lease, a model without a price), the router tries no other route and ends
  the request with the failed route's own message, usage included, under an error text Pi does not retry. The
  budgeted `Models` settles that message with the request's own reservation, at the route's price (at the alias's
  when the route's model has none). The lease gave that reservation before it was fenced, so it is told what the
  provider billed after all, and so is the share. The run stops with the router's text, in which `refusalOf` finds
  no refusal; a lease that is still fenced then refuses the conversation's next request itself.
- **The stream form.** A product can instead forward the router's route events with `fallback: true` and a cost
  above zero to `record` from a fiber of its own. That still works, but nothing orders it with the request, so a
  record the lease refuses, or one a stop gets ahead of, is lost; use one of the two, not both.

`spend.record({ key, provider, model, session, requestKey, usage, outcome })` does, in this order (`requestKey`, the
route event's, is passed on to the lease and is not the spend's name):

1. **Once per key.** A key this process recorded before answers `{ _tag: "Duplicate" }` and charges nothing.
2. **Price.** `usage` at the table's price of `provider` and `model`: the route's own model, never an alias.
3. **Reserve and settle.** It reserves exactly that cost on the lease and settles it at once: a pair of its own,
   with `key` in the `request` both carry, and `kind: "chat"`.
4. **Share.** With a `session` whose conversation has a share, the cost is added to it and the total is stored.
5. **Events.** `Reserved` and `Settled`, as for a request.

It answers `{ _tag: "Settled", reservation, cost, conversation? }`.

- **A fenced lease.** The provider was paid, and no refusal undoes that. `record` then fails with `LeaseFenced`
  and records nothing: no settlement, nothing added to a share, the key still unused, and a `Refused` event. A model
  without a price fails the same way with `PriceMissing`. Under the router's port the attempt is then settled with
  its request (above). A product that calls `record` on its own calls it again with the same key under a new lease,
  or books the amount itself.
- **No cap stops it.** A share takes the cost also when that carries it over its cap. The conversation's next
  request is then refused with `ShareExhausted`.
- A spend that names a `session` waits until `Shares.attach` has run, as a request does.

What a crash can still cost on this path:

- **Between a provider's failure and `record`.** The provider billed the attempt and the process died before the
  lease was asked: nobody is told. The router keeps nothing across a restart, and the request's own reservation
  stays unsettled, for the lease to expire. Only a crash does this: the router runs the port uninterruptibly, so a
  request that is aborted at that moment still has its failed attempt settled on the lease.
- **Between `reserve` and `settle` of the spend.** The lease holds a reservation of exactly the attempt's cost that
  is never settled, as for a request (see [Guarantees and their limits](#guarantees-and-their-limits)).
- **Between `settle` and the commit of a share's total.** The lease is right and the stored total is short by that
  attempt, so the conversation's cap allows that much more after the restart.
- **The keys are in memory**, one per recorded spend, until the Layer's scope closes. After a restart a spend that
  is told again is charged again: once more on the lease, once more on the share. The router does not tell an
  attempt twice, and a request Pi sends again after a restart is a new request with new attempts, so this is for a
  product that replays what it kept. The lease receives the `key` with the reservation (`request.key`), the same
  in every process, so a lease that remembers keys can refuse the second charge.

## A fenced lease: stop and continue

```ts
const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([answer("Hello.")]);
	const root = yield* Harness.rootWith({ agent: yield* agent });

	// The lease is fenced: the request is not sent, and the run ends without an answer.
	const settled = yield* root.prompt("Hello");
	// Both read what Pi stored, so they say the same after a restart.
	const fromSubmission = yield* refusalOf(settled.detail);
	const stop = yield* stopOf(root.id);

	// The product renews its lease, then continues the conversation where it stopped.
	wallet.fenced = false;
	const continued = yield* continueStopped(root);
	return { settled, fromSubmission, stop, answered: yield* continued.wait, requests: yield* scripted.callCount };
});
// settled:  { status: "unanswered", reason: "model_error", detail: "Budget: the lease is fenced, … [budget:…]" }
// stop:     Option.some({ refusal: LeaseFenced { reason: "fenced" }, inputs: [settled.id] })
// answered: { status: "done", … }, after one provider request
```

What happens, in Pi's terms:

1. A refused request ends in pi-ai's `error` event before anything is sent. Its text is a fixed sentence and the
   refusal as JSON in hexadecimal, so no word of the product's reason can match the patterns pi-ai retries or
   compacts for. Pi Durable classifies it as an error that is not retryable.
2. In one commit Pi appends the error to the transcript, settles the run's inputs `unanswered` with reason
   `model_error` and that text as `detail`, and records `pi.live.runFailure`. The conversation is idle. Inputs
   queued behind the run stay queued (`settings.afterFailedRun`).
3. `stopOf(conversationId)` reads `runFailure` and gives the typed refusal: `LeaseFenced` with the product's
   reason, `ShareExhausted`, or `PriceMissing`. `refusalOf(detail)` reads the same from a settled submission.
   Both are stored by Pi, so they are the same after a restart. Pi removes `runFailure` when the next run starts.
4. `continueStopped(conversation)` admits Pi's `continue`: a run on the transcript as it is. Every entry up to the
   refused request is there (a tool result too), and the run answers. The stopped inputs keep their `unanswered`
   record; their answer is the continued run's.

Nothing continues by itself: the product decides when a new lease is there.

## Shares

```ts
const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([answer("One."), answer("Two."), answer("Three.")]);
	const shares = yield* Shares;
	const root = yield* Harness.rootWith({ agent: yield* agent });
	const child = yield* Harness.createConversation({ ownership: { kind: "ownerless" }, agent: yield* agent });

	// The child may spend 20 micro units of the harness's lease.
	yield* shares.setCap(child.id, 20n);
	const first = yield* child.prompt("First");
	const second = yield* child.prompt("Second");
	const stop = yield* stopOf(child.id);
	const rootAnswer = yield* root.prompt("Hello");
	return { first, second, stop, rootAnswer, share: yield* shares.get(child.id) };
});
// first: done. second: unanswered, stop: ShareExhausted { conversation, cap: 20n, settled }. rootAnswer: done.
```

- A child's budget comes out of the parent's: every conversation reserves on the one lease of the harness. A cap
  only limits how much of it one conversation may use.
- A capped conversation is refused with `ShareExhausted` once what it has settled reaches its cap. The check is
  against settled amounts, so the request that crosses the cap is served, and so are requests of the same
  conversation that were in flight with it.
- **How a request is attributed.** Pi Durable sends each conversation's provider session (`pi.provider`'s
  `sessionId`) as pi-ai's `sessionId` with every generation and compaction request, and that is what reaches the
  model boundary. A share is stored under that session. A request without a session (a tool calling
  `api.models` without one, an image or classifier request, the fetch of a deferred response) draws on the lease
  and counts against no share.
- **Where it is stored.** One document per conversation with a share, kind `budget.share`, in the harness storage:
  `{ conversation, cap?, settled, inherited? }`. Giving a share is one commit, and each settled request of a
  conversation with a share is one commit of the new total: one per response, none per token, and none for
  conversations without a share.
- A fork of a conversation starts without a share, as Pi gives it a provider session of its own. A host that forks
  the whole storage (a Rivet actor fork) copies every `budget.share` with its total: see
  [A copied storage](#a-copied-storage).

### A cap in the commit that creates a conversation

`setCap` is a commit of its own, so a conversation exists for a moment without its cap. `setCapIn(tx, conversation,
cap)` writes the same share through a commit the caller already has: the one that creates the conversation.

```ts
const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([answer("One."), answer("Two.")]);
	const shares = yield* Shares;
	const child = yield* Harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: yield* agent,
		// Stored with the conversation or not at all: no child ever exists without its cap.
		init: (tx, conversation) => Effect.asVoid(shares.setCapIn(tx, conversation, 20n)),
	});
	const first = yield* child.prompt("First");
	const second = yield* child.prompt("Second");
	return { first, second, share: yield* shares.get(child.id) };
});
// first: done, counted against the cap from this first request. second: unanswered, ShareExhausted.
```

- It reads the conversation's provider session through the commit. Pi creates `pi.provider` in the commit that
  creates the conversation, so it is there for a conversation the same commit just made: in `init`, in a host's
  `conversationCreated`, in a tool's commit after `tx.createConversation`, and in the subagent plugin's
  `ChildSetup.created(tx, child)`, which makes its `beforeStart` unnecessary for the cap.
- The durable result is that of `setCap`: the same document, under the same key. A commit that is rolled back
  leaves no share, and the conversation's next request reads what is stored.
- For a conversation that does not exist Pi fails the commit, so `setCapIn` fails with a `DurableError` where
  `setCap` fails with `NoProviderSession`.

### What a conversation has spent

`shares.get(conversation)` is one committed read: `{ conversation, settled, cap?, inherited? }`, in micro units, as
stored. It is none for a conversation without a share, because the budget counts a conversation's requests only when
it has one. A product that reports what a thread spent, and wants no cap on it, gives the thread a share without a
cap:

```ts
const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([answer("One."), answer("Two.")]);
	const shares = yield* Shares;
	const root = yield* Harness.rootWith({ agent: yield* agent });
	// Counted from here on, and never refused for it. In a creating commit: shares.trackIn(tx, conversation).
	yield* shares.track(root.id);
	yield* root.prompt("First");
	yield* root.prompt("Second");
	return yield* shares.get(root.id);
});
// Option.some({ conversation: root.id, settled }): what the two responses cost at the price table, and no cap.
```

- **Cost.** A share without a cap costs what a capped one costs: one commit per settled response. That is why
  it is asked for and not given to every conversation. A request alone names a session, not a conversation, so the
  budget could not create the share by itself either.
- `track` leaves a share the conversation already has as it is, cap included; `setCap` gives a tracked share a cap.
- **What it holds.** Every request of the conversation that named its session and settled after the share was
  given, and every spend recorded with that session. Not the requests before the share, not the conversations a
  task of this one owns (each has its own share), and not requests without a session.
- **What a crash can leave out.** The total is stored after the lease is told. A crash, or a close, between the
  two leaves the stored total short by that one request; the lease has it. A request a close cut off is the common
  case, and Pi sends it again on reopen, where it is counted.

### A copied storage

A host that copies a whole harness storage, such as a Rivet actor fork, copies every share with the total its source
had settled. The same money is then stored in two storages, and a product that adds up what its actors settled
counts it twice.

```ts
import { onStorageFork } from "@effectified/pi-budget";

// In the host of the copy, on a harness opened with `resume: false`, before its first request:
yield* onStorageFork(copyName); // Effect<void, DurableError | SchemaDecodeError, Harness | Shares>
```

It moves every share's `settled` into `inherited`, in one commit, and keeps the caps. The rule, and why not the
simpler one:

| | A copy of a conversation at 90 of its cap of 100 | Money summed over storages |
|---|---|---|
| Nothing (before this step) | Has 10 left | The 90 are counted in both |
| Zero the totals, keep the caps | Has 100 left: each of 50 copies may spend the cap again | Counted once |
| **Move `settled` into `inherited`** | Has 10 left: a cap counts `inherited + settled` | Counted once: a sum takes `settled` alone |

What `shares.get` reads after it, for a share that had settled 90:

```ts
// In the copy, after the step:   { conversation, cap: 100n, settled: 0n, inherited: 90n }
// After the copy settled 4 more: { conversation, cap: 100n, settled: 4n, inherited: 90n }
// In the storage it was copied from, unchanged: { conversation, cap: 100n, settled: 90n }
```

- **`settled`** is what this storage settled since it was copied. Every request is in the `settled` of exactly one
  storage, the one that sent it.
- **`inherited`** is what was settled before the copy, in every storage this one descends from. It is absent in a
  storage that was never copied, and for a share that had settled nothing.
- **A cap** refuses a request once `inherited + settled` reaches it, and `ShareExhausted.settled` is that sum.
- **`copyName`** names the copy: the same text whenever the step runs again on this copy, and one that no storage it
  was copied from, and no other copy, is given. For a Rivet actor fork: the fork's actor id. It is stored with the
  move as the mark `budget.copy`, which makes the step idempotent: under the same name it changes nothing, also
  after the copy has settled requests of its own. A copy of the copy runs it under its own name, and what the first
  copy settled is inherited there. A mark without a name could not tell the two apart: a copy holds its source's
  mark.
- **Cost.** Two committed reads per conversation of the storage, and one commit that rewrites the shares that had
  settled something. A second run under the same name is one read.

The limits:

- **Copies do not share what is left of a cap.** Each of 50 copies of a conversation at 90 of 100 may settle the
  last 10, and the request that crosses the cap: a cap bounds one conversation in one storage. What bounds the whole
  is the lease, which is the product's and should be one per copy or shared by all, as it decides.
- **Run it before the copy's first request**, as a host's fork hygiene does. Under the name of a copy it has not
  run for, on a storage that is no fresh copy, it would make that storage's own total inherited: the cap still
  holds, and the storage reports less than it settled.
- **The name is the product's to get right.** Two copies given one name are right each by itself; a copy of a copy
  given its source's name keeps what its source settled as its own.
- **The lease knows nothing of this.** It was told every settlement once, by the storage that made it.

`ShareDocument` is the definition of `budget.share`, keyed by the conversation's provider session (`sessionId` of
Pi's `pi.provider`), for a host that decides differently about a copy: `tx.retireDoc(ShareDocument, session)` drops a
share, cap and totals. Do that only before the storage's first request: a budget that has counted a session in
memory stores its total again.

## Guarantees and their limits

What holds:

- No request leaves through the budgeted `Models` without a successful `reserve`. A lease that fails, a missing
  price, a share that cannot be read, and a defect in `reserve` all send nothing.
- Every reservation is settled exactly once: after a response, a provider error (with the usage it reported), an
  abort by the caller, an interruption of the fiber, a closing scope, and a defect of the wrapped `Models`.
- A refusal is never retried: not by pi-ai, not by Pi Durable's attempt retries, not by its overflow compaction.

What does not:

- **Paths around the boundary.** A caller that takes a provider out of `Models` (`getProvider(id).stream(…)`) and
  resolves its key itself is not budgeted, nor is code that holds the unwrapped `Models` (which is where a router
  belongs), nor a request that never goes through pi-ai.
- **Attempts under a router.** A route that failed before another one served is settled only when the product
  implements the router's settlement port with `Spend`. Without it, the lease knows the serving route's usage alone.
- **A crash between `reserve` and `settle`** leaves a reservation that is never settled. The provider may have
  billed the request; the lease only knows the estimate. The product's lease must expire reservations. The most
  this costs is the requests in flight at the crash. A chat request with a session is reserved with `requestKey`,
  the SHA-256 of the canonical JSON of its session and its whole context. Pi builds the context from committed
  entries and leaves out answers that failed or were cut off, so the request it sends again (on reopen, or in
  another process) is reserved under the key of the one the crash cut off: a lease that finds that reservation
  still open can settle or release it at once, or refuse the repeat. Pi's retry after a provider error has the key
  too, but its earlier reservation was settled. A new request of the conversation asks more and has another key.
  Copies of a storage repeat a key (a request in flight when a Rivet actor was forked): the lease tells them apart
  by who asks. Making the key costs a walk of the context and a hash per request.
- **A crash, or a close, between `settle` and the commit of a share's total** leaves the lease right and the
  stored total short by that request, so the conversation's cap allows that much more after the restart, and what
  `shares.get` reports is that much less. A
  request a close cut off is the common case: it settles as aborted after the harness stopped taking commits (a
  warning is logged), and Pi sends it again on reopen, where it is budgeted again.
- **A `settle` that dies** ends the request in an error and publishes no `Settled` event. The provider was paid.
- **Estimates are the product's.** A response that costs more than its reservation is settled at its real cost;
  the budget does not stop a request midway.
- **Image and classifier requests** are reserved and settled like chat requests, with the token usage the
  provider reports. One that reports none settles zero: the table prices tokens, not images.
- **Deferred responses.** The request that defers and each fetch are separate reservations. A fetch carries no
  session, so its cost counts against no share.
- **A count that is not a whole number** (a provider's report) is rounded up, and one that is not a positive number
  counts as zero, because a settlement cannot fail.
- One process drives one harness storage, as for Pi itself: shares are counted in memory and stored as totals.

## License

MIT
