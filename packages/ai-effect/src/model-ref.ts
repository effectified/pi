// Naming a chat model and looking it up in `Models`, with a typed error when it is not there.

import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";
import { ModelNotFound } from "./errors.ts";
import { ModelId, ProviderId } from "./ids.ts";
import { Models } from "./models.ts";

/**
 * Names one chat model: the id of its provider and the model's id within that provider. The schema of Pi Durable's
 * `ModelRef` (the model an agent runs with), for a model named in stored state or on a wire: its encoded form is
 * Pi's, its type has the ids branded. Made from Pi's plain form with `fromPiModelRef`, from a model with
 * `modelRefOf`, or by decoding.
 */
export const ModelRef = Schema.Struct({ provider: ProviderId, modelId: ModelId });

/** Names one chat model: the id of its provider and the model's id within that provider. */
export type ModelRef = typeof ModelRef.Type;

/**
 * A model's name in Pi's plain form, ids unbranded: Pi Durable's `ModelRef`, and the encoded form of `ModelRef`.
 */
export type PiModelRef = typeof ModelRef.Encoded;

/**
 * Pi's plain `ModelRef` with its ids branded, where one enters from Pi: an agent's model in Pi Durable, the provider
 * and model a message names, a literal of a test.
 */
export function fromPiModelRef(ref: PiModelRef): ModelRef {
	return ModelRef.make({ provider: ProviderId.make(ref.provider), modelId: ModelId.make(ref.modelId) });
}

/** The name of a pi-ai model (any type: chat, image, classifier): its provider and its id, branded. */
export function modelRefOf(model: Pick<AnyModel, "provider" | "id">): ModelRef {
	return fromPiModelRef({ provider: model.provider, modelId: model.id });
}

/**
 * The chat model `ref` names, from the last-known model lists of the providers in `Models`. Fails with
 * `ModelNotFound` when the provider is not registered or does not list the model.
 *
 * Not cached: pi-ai's lookup is a map read on a catalog it merges once per change, and providers can be set or
 * removed while the program runs, which a cache here could not see.
 */
export const getModel: (ref: ModelRef) => Effect.Effect<Model<Api>, ModelNotFound, Models> = Effect.fn(
	"ModelRef.getModel",
)(function* (ref) {
	const models = yield* Models;
	const model = models.getModel(ref.provider, ref.modelId);
	if (model === undefined) return yield* ModelNotFound.make({ provider: ref.provider, modelId: ref.modelId });
	return model;
});
