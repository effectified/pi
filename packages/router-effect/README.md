# @gunta/pi-router-effect

Model routing for Pi in Effect, for `effect` 4.1. A caller asks for an alias such as `"author"` or `"fast"`. A route
table, which is plain data, says which models of which providers may serve that alias, in which order, for which
content, from which region, under which labels and at what price. The router is a [`@earendil-works/pi-ai`](../ai) provider whose models
are the aliases, so anything that takes a pi-ai `Models` (a Pi Durable harness, [`@gunta/pi-ai-effect`](../ai-effect))
uses it by naming `{ provider: "router", modelId: "author" }`.

- A model id comes only from the route table.
- A route that may not see the content, runs in a region the request does not allow, or lacks a label the request
  requires is never used. No route left is a typed error, never a default.
- A product can constrain each conversation on its own, through a port the router asks for every request.
- Fallback to the next route is explicit and recorded: every attempt is an event, with the id of its request and the
  pi-ai session it came with.
- A failed attempt that was billed is settled before another route takes it over, through a port the router waits
  for.
- Per concurrency key: a cap on requests in flight, and a backoff after a rate limit.
- Prices in integer micro units; every attempt is priced, also a failed one. The same prices as rows for a budget.

It knows no product rule: classifications, regions, labels, aliases and currencies are whatever the table says. Built
for pi-ai 1.6.0. It needs no harness: it depends on `@gunta/pi-ai-effect` only.

## Install

```sh
npm install @gunta/pi-router-effect @gunta/pi-ai-effect @earendil-works/pi-ai effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## The route table

```ts
import type { RouteTable } from "@gunta/pi-router-effect";

const table: RouteTable = {
	// The product's labels, lowest to highest. The router has none of its own.
	classifications: ["public", "internal", "secret"],
	// Every concurrency key a route names: how many requests may be in flight on it.
	limits: { openrouter: { maxInFlight: 8 }, local: { maxInFlight: 2 } },
	// Optional. After a rate limit a key waits baseMillis, doubled for each one in a row, at most maxMillis.
	backoff: { baseMillis: 1_000, maxMillis: 60_000 },
	aliases: [
		{
			alias: "author",
			// Optional: the constraints of a request that carries none.
			defaults: { classification: "internal" },
			// Tried in this order.
			routes: [
				{
					provider: "openrouter", // the id of a provider in Models
					model: "anthropic/claude-haiku-5.5", // a chat model that provider lists
					region: "us",
					ceiling: "public", // the highest classification this route may see
					// Per million tokens, in millionths of the currency: USD 1.00 in, USD 5.00 out.
					price: { currency: "USD", input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
					concurrencyKey: "openrouter",
				},
				{
					provider: "local",
					model: "qwen-3-coder",
					region: "eu",
					ceiling: "secret",
					price: { currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					concurrencyKey: "local",
					// Optional: what the product says of the route. A request can require labels.
					labels: ["zero-data-retention"],
				},
			],
		},
	],
};
```

`RouteTable` is an Effect `Schema`. `decodeRouteTable(json)` reads a stored table and fails with `RouteTableError`
(issue `Malformed`) when it is not one: a price must be a whole number of micro units, zero or more, and a label must
be text without white space, not empty. A route without `labels` carries none, so a table written before labels
existed decodes as it is.

The table is validated when the Layer is built, against the providers in `Models` at that moment. `RouteTableError`
lists every issue, each naming its entry:

| Issue | Meaning |
|---|---|
| `Malformed` | the value is not the shape of a table: a field is missing, a price is a fraction, a label has white space |
| `DuplicateClassification`, `DuplicateAlias`, `DuplicateRoute` | a label, an alias, or a provider and model within one alias is there twice |
| `EmptyAlias` | an alias with no route |
| `UnknownCeiling`, `UnknownDefaultClassification` | a label that is not in `classifications` |
| `UnknownConcurrencyKey` | a route's key has no entry in `limits` |
| `UnknownProvider`, `UnknownModel` | `Models` has no such provider, or it lists no such chat model |

## Serving Pi

`Router.layer(table)` validates the table and puts the router's provider into `Models` until the scope closes. It
provides `Router` and `RouteEvents`.

```ts
import { Effect, Layer } from "effect";
import { complete, getModel, Models } from "@gunta/pi-ai-effect";
import { Router } from "@gunta/pi-router-effect";

const live = Router.layer(table, { id: "router" }).pipe(Layer.provideMerge(Models.layer([openrouter, local])));

const program = Effect.gen(function* () {
	const model = yield* getModel({ provider: "router", modelId: "author" });
	return yield* complete(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] });
}).pipe(Effect.provide(live));
```

A Pi Durable conversation whose agent model is `{ provider: "router", modelId: "author" }` goes through the router
with no other change.

The alias model promises what every route of the alias can do: the smallest context window and output limit, a
modality only if every route reads it, reasoning only if every route reasons. Its catalog price is pi-ai's price of
the first route's model.

The message a request returns is the route's own message, unchanged: its `provider` and `model` name the route that
served it, and `usage.cost` is pi-ai's estimate from its catalog. When the route was not the first one tried, the
message also gets a pi-ai diagnostic of type `route_fallback` with the alias, the attempt number and the routes
that failed.

## Constraints of a request

A request says three things about itself: the classification of its content, the regions that may serve it, and the
labels a route must carry. They travel in pi-ai's request `metadata`, under the key `"pi-router"`.

```ts
import { constraintsToMetadata } from "@gunta/pi-router-effect";

// A pi-ai request.
yield* complete(model, context, {
	metadata: constraintsToMetadata({ classification: "secret", regions: ["eu"], requires: ["zero-data-retention"] }),
});

// A Pi Durable harness: its stream settings carry metadata to every request of every conversation.
const settings = { stream: { metadata: constraintsToMetadata({ classification: "internal" }) } };
```

Why `metadata`: it is the one request option that both reaches `Provider.stream` and can be set for a Pi Durable
harness, and pi-ai defines it as the field "providers extract the fields they understand" from. Headers reach the
provider too, but they are HTTP headers and would be sent on to a third party. The router removes its key before the
request goes to a route's provider; the rest of the metadata is passed on.

- A request's constraints win over the alias's `defaults`, field by field: a default fills in what the request does
  not say.
- Content with no classification, from the request, the alias or the product, is treated as the **highest** label:
  only a route that may see everything serves it.
- A request without regions may be served from any region.
- `requires` lists labels: a route serves only if its `labels` hold every one of them. A label means what the product
  says it means (`zero-data-retention`, `byok`, `batch`): the router compares text.
- Constraints that cannot be read, or a classification the table does not list, fail the request
  (`InvalidConstraints`).

`Router.resolve` answers which routes may serve, without a request:

```ts
const router = yield* Router;
yield* router.resolve("author", { classification: "public" }); // both routes, in table order
yield* router.resolve("author", { classification: "secret" }); // the local route only
yield* router.resolve("author", { classification: "public", requires: ["zero-data-retention"] }); // the local route
yield* router.resolve("author", { classification: "secret", regions: ["us"] }); // fails: NoRouteAvailable
```

`NoRouteAvailable` says why each route is excluded, in table order: `classification`, `region` or `label`, the first
of the three that holds, and for `label` the required labels the route lacks (`missing`).

## Constraints of a conversation

Pi Durable takes request metadata from the harness's settings: one value for all its conversations. A product that
keeps a classification, regions or required labels per conversation provides a `ConstraintSource`. The router asks
it for every request, before it resolves the routes, with what reaches a provider request: the alias, pi-ai's
`sessionId` and the metadata. Pi Durable sends each conversation's provider session (the `sessionId` of its
`pi.provider` document, created in the commit that creates the conversation) as the `sessionId` of every request of
that conversation, so a lookup by session is a lookup by conversation.

```ts
import { Effect, Layer } from "effect";
import { type Constraints, ConstraintSource, ConstraintsUnavailable, Router } from "@gunta/pi-router-effect";

// The product's own state: what it decided about each conversation, by the conversation's provider session.
const bySession = new Map<string, Constraints>();
bySession.set("0197-session-of-a-public-thread", { classification: "public" });
bySession.set("0197-session-of-an-eu-thread", { classification: "internal", regions: ["eu"] });

const PerConversation = Layer.succeed(ConstraintSource, {
	constraintsOf: ({ alias, sessionId }) =>
		// A session the product does not know is not served: the request is refused.
		Effect.mapError(
			Effect.fromNullishOr(sessionId === undefined ? undefined : bySession.get(sessionId)),
			() => new ConstraintsUnavailable({ alias, reason: `no constraints for session ${sessionId}` }),
		),
});

const live = Router.layer(table).pipe(Layer.provide(PerConversation), Layer.provideMerge(Models.layer([openrouter, local])));
```

What the source answers only ever narrows a request. Three parties have a say, and they combine in two steps:

1. **The request over the alias**, as above: a request's field wins over the alias's default.
2. **The source over both**, never wider:
   - **classification**: the stricter one holds, the higher label of the table. A request that names a stricter
     label than the source keeps its own; one that names a laxer label gets the source's.
   - **regions**: they intersect. A route must run in a region both allow; when they share none, no route serves
     (`NoRouteAvailable`, every route excluded for `region`). A request never gets regions back that the source
     left out.
   - **requires**: they add up. Nothing a request says removes a label the source requires.
   - A field only one side names is that side's. A classification only the source names is the content's
     classification, so the request is no longer treated as the highest label.

- **Fail closed.** A source that fails refuses the request with its own `ConstraintsUnavailable`; one that dies
  refuses it with a `ConstraintsUnavailable` whose `reason` names the defect. Nothing is sent and no route event is
  written. Through pi-ai the request ends in an `error` whose text is a fixed sentence without the reason, so no word
  of a product's reason can make Pi send the request again.
- **The default imposes nothing.** `ConstraintSource` is a `Context.Reference` whose default answers `{}`: a router
  built without one routes by the request and the alias alone, as before. So a product that forgets to provide its
  source gets no per-conversation filter and no error: provide it under `Router.layer`, which takes the source of
  the context it is built in.
- `Router.resolve` asks no source: it has no request.
- The router stores nothing. After a restart the source is asked again for a request Pi sends again, so the product
  must answer from state that outlives the process.

## Fallback

A request tries its routes in order. The next route is tried only when:

- the route's provider or model is not registered, or pi-ai says the provider has no credentials
  (`Models.checkAuth`); or
- the response failed with an error pi-ai calls retryable (`isRetryableAssistantError`), it is not a context
  overflow (`isContextOverflow`), and none of it had reached the caller.

Every other failure ends the request with that route's error: an error that is not retryable (a bad request, an
exhausted quota), an abort by the provider or by the caller, and any failure after output started. pi-ai's `start`
event is held back until the route has output, so a caller never sees two responses.

Requests made through pi-ai end in pi-ai's `error` event. `Router.stream` and `Router.complete` are the same
request in Effect terms, with typed errors:

```ts
const router = yield* Router;
const message = yield* router.complete("author", context, { constraints: { classification: "public" } }).pipe(
	Effect.catchTags({
		// Every route failed. `error.failures` has one entry per attempt.
		RoutesExhausted: (error) => Effect.fail(error.message),
		// The constraints exclude every route. `error.excluded` says why, route by route.
		NoRouteAvailable: (error) => Effect.fail(error.message),
	}),
);
```

The other errors are `UnknownAlias`, `InvalidConstraints`, `ConstraintsUnavailable`, `AttemptUnsettled` (see
[With a budget](#with-a-budget)), and `ModelRequestError` of `@gunta/pi-ai-effect` for the one route that ended the
request.

## The record

Every attempt is published to `RouteEvents` when it ends, before its outcome reaches the caller.

```ts
import { Effect, Stream } from "effect";
import { RouteEvents } from "@gunta/pi-router-effect";

const record = Effect.gen(function* () {
	const events = yield* RouteEvents;
	yield* events.stream.pipe(
		Stream.runForEach((event) =>
			Effect.log(`${event.alias} #${event.attempt} ${event.route.provider}: ${event.outcome} ${event.cost.micros}`),
		),
	);
});
```

A `RouteEvent` has the router id, the request's number and its `requestId`, the pi-ai `sessionId` the request came
with and the `requestKey` of what it asks (when it had a session), the alias, the whole route, the attempt number, the `outcome` (`served`, `failed`, `aborted`,
`unavailable`), `fallback` (true when the next route is tried because of this outcome), pi-ai's error text, the token
usage, its cost at the route's price, and three times from Effect's `Clock`: when the attempt began, how long it
waited for the limiter and how long the request took. `events.subscribe` subscribes at once, so nothing published
afterwards is missed.

- **`requestId`** is the same for every attempt of one request and belongs to no other request, of this router or
  another, in this process or a later one: the router's instance (the Clock time it was built at and a number of
  Effect's `Random`) and the request's number. `requestId` and `attempt` together name one attempt for good.
  `request` still counts the requests of one router from 1.
- **`sessionId`** ties an attempt to a conversation: Pi Durable sends each conversation's provider session.
- **`requestKey`** names what a request with a session asks: the SHA-256 of the canonical JSON of the session and
  the whole context. Unlike `requestId` it is the same for every send of one request, in this process or a later
  one: Pi builds a request's context from its committed entries and leaves out answers that failed or were cut off,
  so the request it sends again after a crash has the key of the one that was cut off. Pi's retry after a provider
  error has it too. A new request of the conversation asks more (an input, a tool result, an answer), and has
  another. `@gunta/pi-budget-effect` makes the same key of the same request for its reservation, so a lease and the
  route events name one request alike. A copy of a storage keeps its source's sessions, so a request in flight when
  a Rivet actor was forked is sent by both actors under one key. It costs a walk of the context and a hash per
  request.
- **`fallback`** says what happened, not what was meant: an attempt the product's `AttemptSettlement` was handed is
  published when the port has answered, and says `false` when the port could not settle it, because no route took
  it over.

## With a budget

[`@gunta/pi-budget-effect`](../budget-effect) wraps the `Models` the harness is opened with, the router underneath
it. One request of the harness is then one reservation, settled with the usage of the message the request ends
with. The router makes sure that this message carries the usage of the request's **last** attempt and of no earlier
one. An attempt another route took over used tokens too, and the budget never sees it. The router hands each such
attempt to the product's `AttemptSettlement` and waits for it, before the next route is sent anything:

```ts
import { Effect, Layer } from "effect";
import { Spend } from "@gunta/pi-budget-effect";
import { AttemptSettlement, Router } from "@gunta/pi-router-effect";

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

const routed = Router.layer(table).pipe(
	// The settlement gets the budget's `Spend` and nothing else of it: the router stays on the providers' `Models`.
	Layer.provide(Layer.provide(SettleAttempts, budgeted)),
	Layer.provide(providers),
);
```

`providers` is the plain `Models.layer([...])`, and `budgeted` is the budget's Layer built on that same value
(`BudgetedModels.layer.pipe(Layer.provide(budget), Layer.provide(providers))`). The application merges `routed` and
`budgeted` under its harness. A Layer value is built once, so both hold one `Models` and one `Spend`. Never give
`Router.layer` the budgeted `Models`: every attempt would be reserved a second time.

**The rule:** the router calls `settle` once for each attempt that failed after its provider billed it (a cost above
zero at the route's price) and that the next route is about to take over, and for no other attempt.

- **Never a request's last attempt**, whether it served, failed or was aborted. Its usage is in the message the
  request ends with, which the budget settles. So `settle` needs no filter, and nothing is charged twice.
- **Never an attempt that cost nothing.** A route that was `unavailable` sent nothing, most refused requests (a 429,
  a 503) report no usage, and a free route costs nothing whatever it used.
- **When.** After the attempt failed and before the next route is asked anything, in the order of the attempts. The
  attempt's route event is published when `settle` has answered. The caller has seen nothing of the request yet:
  when `Router.complete` returns, or pi-ai's stream ends, every attempt before the last that cost something is
  settled.
- **Fail closed.** When `settle` fails (with anything), dies or throws, the attempt was not settled, and no other
  route is tried. The attempt becomes the request's last:
  - Its route event says `fallback: false`.
  - The request fails with `AttemptUnsettled`: `alias`, `requestId` and `attempt` (the attempt's name, as in its
    event), `provider`, `model`, `reason` (the port's text) and `response` (the failed route's pi-ai message).
  - Through pi-ai it ends in an `error` that is the failed route's own message, its usage included, under a fixed
    sentence. A budget around the router therefore settles this attempt with the request's own reservation, at the
    route's price. That reservation was given before the request was sent, so a lease that is fenced by now is
    still told what the provider billed.
  - Pi does not send the request again: the sentence holds neither the provider's words nor the port's reason.
- **Why not go on, and why not retry.** Going on would spend on a second route while the first one's bill has no
  owner. A retry would send the request to the first route again and be billed again, and what refused the
  settlement (a fenced lease, a model without a price) does not pass by waiting.
- **Interruption.** `settle` runs uninterruptibly: a caller that gives up while it runs waits for it, the attempt
  is recorded as what it was, and then no other route is tried. Nothing bounds it but the port itself, so keep it
  short or give it a timeout.
- **The default does nothing.** `AttemptSettlement` is a `Context.Reference` whose default settles nothing: a router
  built without one falls back as before. Provide the product's under `Router.layer`, which takes the settlement of
  the context it is built in, for `Router.complete` and for requests through pi-ai alike.

What can still go wrong: the router stores nothing. A process that dies between a provider's failure and the end
of `settle` leaves that attempt settled by nobody; Pi sends the request again, under a new request id.

**The stream form.** A product can instead subscribe to `RouteEvents` and forward the events with `fallback: true`
and a cost above zero from a fiber of its own; that still works, and it is the same set of attempts. The port is
preferred because nothing orders the stream with the request: a forwarded attempt can be settled after its request
ended, and a lease fenced or a process stopped in between loses it without the request knowing. Use one of the two,
not both.

Neither package imports the other: the code above is product code, and this package's test runs it against a
stand-in with the signature of `Spend`.

## Limits and backoff

Routes with the same `concurrencyKey` share one limit. A request holds a slot from when it is sent until its
response ends. When a response is a rate limit, the key backs off: nothing starts on it until the wait has passed.
The request itself moves on to its next route.

- The wait is `baseMillis`, doubled for each rate limit in a row, at most `maxMillis`. A served request resets it.
- A `retry-after-ms` or `retry-after` header is used instead, when the provider's adapter reports the refused
  response through pi-ai's `onResponse`, and so is pi-ai's own "Server requested Ns retry delay". Both are capped at
  `maxMillis` as well.
- Waiting is interruptible and runs on Effect's `Clock`, so `TestClock` drives it.

`Limiter` is also usable alone:

```ts
import { Limiter } from "@gunta/pi-router-effect";

const limited = Effect.gen(function* () {
	const limiter = yield* Limiter;
	return yield* limiter.withPermit("crawler", fetchPage);
}).pipe(Effect.provide(Limiter.layer({ limits: { crawler: { maxInFlight: 4 } } })));
```

## Prices

`cost(route, usage)` is the cost of a pi-ai `Usage` at a route's price, as a `bigint` of micro units. The four token
counts are multiplied by their prices and summed exactly, then rounded up to the next micro unit once.

```ts
import { cost } from "@gunta/pi-router-effect";

// 1,234 input and 567 output tokens at USD 3 and USD 15 per million.
const price = { currency: "USD", input: 3_000_000, output: 15_000_000, cacheRead: 0, cacheWrite: 0 };
// { currency: "USD", micros: 12207n }
yield* cost({ price }, { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 });
```

It fails with `InvalidUsage` for a count that is not a whole number of tokens: it is the strict form, for a
product's own figures. The cost in a route event is the same arithmetic and never fails, because an attempt is
recorded whatever a provider reported: a count that is not a whole number is rounded up, and one that is not a
positive number counts as zero. That is the rule of `@gunta/pi-budget-effect`, so both packages give the same amount
for the same usage at the same price.

### Prices for a budget

A budget needs a price for every model it settles, and the route table already has them. `priceRows(table)` gives
them as plain rows, in the shape the `PriceTable` of `@gunta/pi-budget-effect` decodes, so a price is written once:

```ts
import { priceRows } from "@gunta/pi-router-effect";

// { currency: "USD", prices: [{ provider, model, input, output, cacheRead, cacheWrite }, ...] }
const rows = yield* priceRows(table); // or priceRows(table, "routes") for a router built with { id: "routes" }
// In the product, with the budget: Prices.layer(rows)
```

- **One row per route's model**, at the route's price. A response names the route that served it, and the budget
  settles a response at the price of the model it names. A model several aliases route to has one row.
- **One row per alias**, under the router's provider id, at the highest price of the alias's routes for each kind of
  token. The budget checks a request against the model it was asked for, which is the alias, before it knows which
  route will serve: without this row it refuses the request (`PriceMissing`). No route charges more than this row,
  so an estimate made from it is never too low.
- Route rows first, then alias rows, each in table order.

It fails with `PriceRowsError`, which lists every issue: `MixedCurrencies` (routes priced in more than one currency: a
budget has one), `ConflictingPrice` (one provider and model at two prices, or an alias row that would share a
route's name) and `NoRoute` (a table without a route has no price and no currency).

## OpenRouter

pi-ai 1.6.0 ships an OpenRouter provider, and `@gunta/pi-ai-effect` can make a provider of any `effect/ai` model,
such as `@effect/ai-openrouter`. A table can route to both side by side:

```ts
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { EffectProvider, Models } from "@gunta/pi-ai-effect";

const viaEffect = yield* EffectProvider.make({
	id: "effect-openrouter",
	models: [{ id: "openai/gpt-6-luna", contextWindow: 400_000, maxTokens: 32_000 }],
	layer: openRouterLanguageModel, // Layer<LanguageModel.LanguageModel> from @effect/ai-openrouter
});
const live = Router.layer(table).pipe(Layer.provideMerge(Models.layer([openrouterProvider(), viaEffect])));
// In the table: { provider: "openrouter", model: "anthropic/claude-haiku-5.5", ... }, then
//               { provider: "effect-openrouter", model: "openai/gpt-6-luna", ... }
```

OpenRouter's own routing (its `provider` request field, a regional base URL) is configured on the provider, not in
the route table: register one provider per base URL and name each in a route with its region.

## What it does not do

- It never retries a route: one attempt per route per request. Retrying the request is the caller's policy (Pi
  Durable's retry policy sees pi-ai's own error text).
- It does not choose routes by price, latency or load. The order is the table's.
- It has no token bucket (requests per second): only a cap on requests in flight and the backoff.
- It does not reserve or enforce a budget, and it does not change `usage.cost` on a message. Events carry the cost,
  and a product settles the attempts it is handed (see [With a budget](#with-a-budget)).
- It keeps nothing across a restart: request ids, the limiter and what a `ConstraintSource` answered are in memory.
  A `requestKey` needs nothing kept: it is made of what the request asks.
- It sends a provider no key of the request. pi-ai has no option for one, and the one request id header it sends
  (`x-client-request-id`, on OpenAI-style APIs) carries the session, for session affinity and the prompt cache. A `requestKey` would not
  do either: Pi's retry after a provider error has the key of the request that failed, so a provider that answered a
  key it has seen from its record would answer every retry with that error. What would do is a key that Pi keeps for
  a send a crash cut off and changes after an attempt a provider answered: Pi's generation task has the attempt, but
  counts a cut-off send as a failed attempt, and passes neither to a provider.
- A route label is compared as text. The router does not check that a route keeps what its labels promise.
- Deferred responses are not routed: the `deferred` option is dropped and the response arrives in the request.
- The options of one pi-ai API are not passed on: a route's model can have any API, so both of pi-ai's entry points
  forward pi-ai's provider-neutral options.
- A request's `apiKey` is not passed on. Each route's provider uses its own credentials from `Models`.
- The table is validated once. A provider or a model that disappears later makes its route `unavailable`.
- The limiter is per process. Image and classifier models are not routed.

## License

MIT
