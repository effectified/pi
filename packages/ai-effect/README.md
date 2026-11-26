# @effectified/pi-ai

Pi's model library ([`@earendil-works/pi-ai`](../ai)) in Effect terms, for `effect` 4.1:

- `Models`, pi-ai's provider collection, as a service and a Layer.
- A chat request as a `Stream` of pi-ai's events or an `Effect` of the final message, with typed errors. Interrupting
  the fiber aborts the provider request.
- Two bridges to `effect/ai`: a pi-ai model as a `LanguageModel`, and a `LanguageModel` as a pi-ai provider.
- Scripted models for tests.

It adds no behaviour of its own: what pi-ai does is what happens. Built for pi-ai 1.6.1.

## Install

```sh
npm install @effectified/pi-ai @earendil-works/pi-ai effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Models

`Models.layer(providers)` builds a pi-ai collection. The service value is pi-ai's own `MutableModels`, so it can be
handed to anything that takes one, and providers can be added while the program runs.

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Effect } from "effect";
import { getModel, Models } from "@effectified/pi-ai";

const program = Effect.gen(function* () {
	// Fails with ModelNotFound when no registered provider lists the model.
	return yield* getModel({ provider: "anthropic", modelId: "claude-opus-4-7" });
}).pipe(Effect.provide(Models.layer([anthropicProvider()])));
```

## Requests

`stream` and `complete` take the options of the model's own API; `streamSimple` and `completeSimple` take pi-ai's
provider-neutral ones (`reasoning`, `toolChoice`). None takes a `signal`: the fiber owns cancellation.

```ts
import { Effect, Stream } from "effect";
import { complete, getModel, stream } from "@effectified/pi-ai";

const program = Effect.gen(function* () {
	const model = yield* getModel({ provider: "anthropic", modelId: "claude-opus-4-7" });
	const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }] };

	// Every pi-ai event up to `done`. Ending the Stream early aborts the request.
	yield* stream(model, context).pipe(
		Stream.runForEach((event) => (event.type === "text_delta" ? Effect.log(event.delta) : Effect.void)),
	);

	// The final message only.
	return yield* complete(model, context).pipe(
		// The request ended in pi-ai's `error` event. `error.response` is the assistant message of that event.
		Effect.catchTag("ModelRequestError", (error) => Effect.fail(error.response.errorMessage)),
	);
});
```

A request that ends in pi-ai's `error` event fails with `ModelRequestError` (`reason` is `"error"`, or `"aborted"`
when the provider gave the request up). Interrupting the fiber is interruption, never this error.

### The key of a request

`requestKey(session, context)` is the SHA-256 of the canonical JSON of a provider session and a whole context, as
64 hexadecimal digits: the same each time one request is sent, in this process or a later one, and another for
every other request. Pi builds a context from committed entries only, so a request sent again after a crash, and
Pi's retry after a provider error, have the key of the first send. `@effectified/pi-router` puts it on its route
events and `@effectified/pi-budget` on its reservations, so a product's lease and its event store name one
request alike. It is no idempotency key for a provider: a retry after an error has the same key by design.

## Values that follow pi-ai's types

Plugins classify, price and record pi-ai's responses. These exports say once what pi-ai's types say, so a member pi-ai
adds fails to compile here, or in the package's conformance check (`test/pi-conformance.ts`), instead of being missed
at run time:

| | |
|---|---|
| `ANSWERED` | Per pi-ai `StopReason`, whether a response with it answered: `stop`, `length` and `toolUse` (Pi Durable's rule); `error`, `aborted`, `pending` and `deferred` did not |
| `TOKEN_KINDS`, `TokenKind` | The kinds of tokens pi-ai prices (`input`, `output`, `cacheRead`, `cacheWrite`: the keys of `ModelCostRates`), for price tables and usage records |
| `emptyUsage()` | A `Usage` of nothing, a new object each time (pi-ai's `calculateCost` writes into the usage it prices) |
| `ErrorReason` | The reason of pi-ai's `error` event, `error` or `aborted`: what `ModelRequestError.reason` holds |
| `ModelRef` | The schema of a model's name (`{ provider, modelId }`), Pi Durable's `ModelRef`, for state and wires that name one; also its type |
| `StrictOmit<T, K>` | `Omit` that only takes keys `T` has: a key pi-ai renames fails to compile instead of being left in |

## Pi serves Effect

`PiLanguageModel.layer(ref)` gives an `effect/ai` `LanguageModel` backed by a pi-ai model, so an Effect AI program
gets Pi's providers and catalog.

```ts
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/ai";
import { Models, PiLanguageModel } from "@effectified/pi-ai";

const model = PiLanguageModel.layer({ provider: "anthropic", modelId: "claude-opus-4-7" }, { reasoning: "high" }).pipe(
	Layer.provide(Models.layer([anthropicProvider()])),
);

const program = LanguageModel.generateText({ prompt: "Hello" }).pipe(
	Effect.map((response) => response.text),
	Effect.provide(model),
);
```

Carried: system, user, assistant and tool messages, inline images, the request's tools with their JSON Schema, text,
reasoning, tool calls, finish reason and token usage, in `generateText` and `streamText`. A pi-ai error becomes an
`AiError` with reason `UnknownError` and pi-ai's error text.

Not carried, because pi-ai has no place for it:

- `generateObject` and a tool choice that forces a call (`"required"`, `{ tool }`) fail with `InvalidRequestError`
  before any request is made.
- Files that are not inline images, and image URLs, fail the same way.
- Provider-defined tools are declared as ordinary tools; pi-ai has no provider-executed tools.
- pi-ai's cost and its replay signatures for reasoning are not in the response parts.

## Effect serves Pi

`EffectProvider.make({ id, models, layer })` gives a pi-ai provider, built with pi-ai's public `createProvider()`,
whose chat requests run the `LanguageModel` of `layer`. An `effect/ai` provider or a product's router can then drive
anything that takes a pi-ai `Models`.

```ts
import { Effect } from "effect";
import { complete, EffectProvider, getModel, Models } from "@effectified/pi-ai";

const program = Effect.scoped(
	Effect.gen(function* () {
		const provider = yield* EffectProvider.make({
			id: "router",
			models: [{ id: "fast", contextWindow: 200000, maxTokens: 8192 }],
			layer: myLanguageModelLayer, // Layer<LanguageModel.LanguageModel, E, R>
		});
		return yield* Effect.gen(function* () {
			const model = yield* getModel({ provider: "router", modelId: "fast" });
			return yield* complete(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] });
		}).pipe(Effect.provide(Models.layer([provider])));
	}),
);
```

- The layer is built once, in the scope `make` runs in. Closing that scope interrupts every open request and
  releases the layer; a request made afterwards ends as aborted.
- Aborting a pi-ai request (its `signal`) interrupts the fiber that runs it.
- Tools are declared to the model and never run by Effect: Pi runs them. A tool call reaches Pi as the model made
  it, and Pi validates its arguments.
- The provider needs no key. The layer owns its credentials, so the provider's auth always resolves, to nothing.
- Every listed model is served by the same `layer`. Use one provider per `effect/ai` model, or a layer that routes.

Carried: the transcript (system prompt, user text and images, assistant text, reasoning and tool calls, tool
results), the current tools, `toolChoice`, pi-ai's full event sequence, usage with pi-ai's cost at the model's
prices, and the stop reason. An `AiError` becomes pi-ai's `error` event.

Not carried: `temperature`, `maxTokens`, `reasoning` and the other pi-ai request options (an `effect/ai` model takes
them from its own layer), pi-ai's replay signatures, and the provider-executed tool calls, files and sources of a
response.

## Testing

The `./testing` subpath has scripted models: no network, no keys.

```ts
import { Effect } from "effect";
import { complete } from "@effectified/pi-ai";
import { fauxAssistantMessage, ScriptedModels } from "@effectified/pi-ai/testing";

const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([fauxAssistantMessage("Hello")]);
	const message = yield* complete(scripted.model, { messages: [] });
	return [message.content, yield* scripted.callCount];
}).pipe(Effect.provide(ScriptedModels.layer())); // provides ScriptedModels and Models
```

`ScriptedModels` wraps pi-ai's `fauxProvider`. `ScriptedLanguageModel.layer(responses)` is the same idea for
`effect/ai`: a `LanguageModel` that answers with queued parts and records what it was asked. `conditions()` is how a
test waits for a fake of its own without the clock: the fake calls `changed()` after each change of its state, and
the test waits with `when(() => fake.calls.length === 2)`.

`runTest(effect)` runs a test's Effect as a promise, in a scope, on Effect's `TestClock` and `TestConsole`: time
stands still until the test moves it with `TestClock.adjust`, so a sleep, a timeout or a deadline passes without a
wait, and a test that forgets to move the clock hangs until its runner's limit. `runLive(effect)` is the same on the
real clock, for a test of real processes or files. Both import no test runner, so they work under Vitest and under
`bun test`: `@effect/vitest` needs Vitest 5 and does not load under `bun test`.

## Not wrapped yet

- Image generation (`generateImages`) and classifiers (`classify`).
- Deferred responses (`streamDeferred`, `fetchDeferred`, `cancelDeferred`, the `deferred` option).
- OAuth login and logout, credential stores, `checkAuth`, `getAvailable` and model refresh (`refresh`).

All of them remain reachable through the `Models` service value, which is pi-ai's own object.

## License

MIT
