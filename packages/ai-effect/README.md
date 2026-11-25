# @gunta/pi-ai-effect

Pi's model library ([`@earendil-works/pi-ai`](../ai)) in Effect terms, for `effect` 4.1:

- `Models`, pi-ai's provider collection, as a service and a Layer.
- A chat request as a `Stream` of pi-ai's events or an `Effect` of the final message, with typed errors. Interrupting
  the fiber aborts the provider request.
- Two bridges to `effect/ai`: a pi-ai model as a `LanguageModel`, and a `LanguageModel` as a pi-ai provider.
- Scripted models for tests.

It adds no behaviour of its own: what pi-ai does is what happens. Built for pi-ai 1.6.0.

## Install

```sh
npm install @gunta/pi-ai-effect @earendil-works/pi-ai effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Models

`Models.layer(providers)` builds a pi-ai collection. The service value is pi-ai's own `MutableModels`, so it can be
handed to anything that takes one, and providers can be added while the program runs.

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Effect } from "effect";
import { getModel, Models } from "@gunta/pi-ai-effect";

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
import { complete, getModel, stream } from "@gunta/pi-ai-effect";

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

## Pi serves Effect

`PiLanguageModel.layer(ref)` gives an `effect/ai` `LanguageModel` backed by a pi-ai model, so an Effect AI program
gets Pi's providers and catalog.

```ts
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/ai";
import { Models, PiLanguageModel } from "@gunta/pi-ai-effect";

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
import { complete, EffectProvider, getModel, Models } from "@gunta/pi-ai-effect";

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
import { complete } from "@gunta/pi-ai-effect";
import { fauxAssistantMessage, ScriptedModels } from "@gunta/pi-ai-effect/testing";

const program = Effect.gen(function* () {
	const scripted = yield* ScriptedModels;
	yield* scripted.setResponses([fauxAssistantMessage("Hello")]);
	const message = yield* complete(scripted.model, { messages: [] });
	return [message.content, yield* scripted.callCount];
}).pipe(Effect.provide(ScriptedModels.layer())); // provides ScriptedModels and Models
```

`ScriptedModels` wraps pi-ai's `fauxProvider`. `ScriptedLanguageModel.layer(responses)` is the same idea for
`effect/ai`: a `LanguageModel` that answers with queued parts and records what it was asked.

## Not wrapped yet

- Image generation (`generateImages`) and classifiers (`classify`).
- Deferred responses (`streamDeferred`, `fetchDeferred`, `cancelDeferred`, the `deferred` option).
- OAuth login and logout, credential stores, `checkAuth`, `getAvailable` and model refresh (`refresh`).

All of them remain reachable through the `Models` service value, which is pi-ai's own object.

## License

MIT
