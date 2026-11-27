// pi-ai's faux provider as an Effect service: a `Models` whose one provider answers with scripted responses.

import {
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Model,
	type Provider,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { type ModelRef, modelRefOf } from "../model-ref.ts";
import { Models } from "../models.ts";

/** The controls of the scripted provider `ScriptedModels.layer` registers. */
export interface ScriptedModelsService {
	/** The scripted provider itself, for a `Models` built by hand. */
	readonly provider: Provider;
	/** The provider's first model: `faux/faux-1` unless the options name others. */
	readonly model: Model<string>;
	/** The name of `model`, for `getModel` and for the model of an agent. */
	readonly ref: ModelRef;
	/** Every model of the provider. */
	readonly models: readonly Model<string>[];
	/** Replaces the queue of responses. Each request takes the next one; a request with none queued fails. */
	readonly setResponses: (responses: readonly FauxResponseStep[]) => Effect.Effect<void>;
	/** Adds responses to the end of the queue. */
	readonly appendResponses: (responses: readonly FauxResponseStep[]) => Effect.Effect<void>;
	/** How many requests the provider has received. */
	readonly callCount: Effect.Effect<number>;
	/** How many queued responses no request has taken yet. */
	readonly pendingResponseCount: Effect.Effect<number>;
}

/** A scripted pi-ai provider for tests: no network, no keys, responses in the order they were queued. */
export class ScriptedModels extends Context.Service<ScriptedModels, ScriptedModelsService>()(
	"@effectified/pi-ai/testing/scripted-models/ScriptedModels",
) {
	/**
	 * A fresh scripted provider and a `Models` that holds only it. `options` are pi-ai's `fauxProvider` options; give
	 * `tokenSize` equal bounds when a test asserts exact deltas, because pi-ai picks the size of each delta at random.
	 */
	static layer(options?: RegisterFauxProviderOptions): Layer.Layer<ScriptedModels | Models> {
		const scripted = Layer.sync(ScriptedModels, () => fromHandle(fauxProvider(options)));
		const models = Layer.unwrap(ScriptedModels.use((service) => Effect.succeed(Models.layer([service.provider]))));
		return Layer.provideMerge(models, scripted);
	}
}

function fromHandle(handle: FauxProviderHandle): ScriptedModelsService {
	const model = handle.getModel();
	return {
		provider: handle.provider,
		model,
		ref: modelRefOf(model),
		models: handle.models,
		setResponses: Effect.fn("ScriptedModels.setResponses")(function* (responses: readonly FauxResponseStep[]) {
			yield* Effect.sync(() => handle.setResponses([...responses]));
		}),
		appendResponses: Effect.fn("ScriptedModels.appendResponses")(function* (responses: readonly FauxResponseStep[]) {
			yield* Effect.sync(() => handle.appendResponses([...responses]));
		}),
		callCount: Effect.sync(() => handle.state.callCount),
		pendingResponseCount: Effect.sync(() => handle.getPendingResponseCount()),
	};
}
