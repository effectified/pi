// Naming a chat model and looking it up in `Models`, with a typed error when it is not there.

import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";
import { ModelNotFound } from "./errors.ts";
import { Models } from "./models.ts";

/**
 * Names one chat model: the id of its provider and the model's id within that provider. The schema of Pi Durable's
 * `ModelRef` (the model an agent runs with), for a model named in stored state or on a wire.
 */
export const ModelRef = Schema.Struct({ provider: Schema.String, modelId: Schema.String });

/** Names one chat model: the id of its provider and the model's id within that provider. */
export type ModelRef = typeof ModelRef.Type;

/**
 * The chat model `ref` names, from the last-known model lists of the providers in `Models`. Fails with
 * `ModelNotFound` when the provider is not registered or does not list the model.
 */
export function getModel(ref: ModelRef): Effect.Effect<Model<Api>, ModelNotFound, Models> {
	return Models.use((models) => {
		const model = models.getModel(ref.provider, ref.modelId);
		return model === undefined
			? Effect.fail(new ModelNotFound({ provider: ref.provider, modelId: ref.modelId }))
			: Effect.succeed(model);
	});
}
