// Test helper for the tests that compare with plain Pi Durable: scripted models both sides can use (pi-ai's faux
// provider), a storage that can be read after close, and a harness Layer over both. Tests of the facade alone use the
// testing kit (src/testing).

import {
	createModels,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Models } from "@gunta/pi-ai-effect";
import type { SchemaConversionError } from "@gunta/pi-schema-effect";
import { Layer } from "effect";
import { Harness, Registry, Storage } from "../src/index.ts";

export { answer } from "../src/testing/index.ts";

/** The faux provider with scripted `responses`: pi-ai's collection, the same as a Layer, and its model for agents. */
export function scriptedModels(responses: FauxResponseStep[]) {
	// A fixed api name: the default is random per provider, and it is stored in every assistant message.
	const faux = fauxProvider({ api: "faux-scripted" });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	return {
		faux,
		models,
		layer: Models.layer([faux.provider]),
		agent: { model: { provider: model.provider, modelId: model.id } },
	};
}

/** The agent change every scripted model answers for: the faux provider's default model. */
export const AGENT = scriptedModels([]).agent;

/**
 * An answer the model is asked for but holds back until `release()`, or until its request is aborted. `requested`
 * resolves once the request arrived, so a test can act while the run is busy. The kit's `held` in promises, which the
 * plain Pi side of a parity scenario awaits.
 */
export function heldAnswer(text: string) {
	const requested = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const response: FauxResponseFactory = (_context, options) => {
		requested.resolve();
		return new Promise((resolve) => {
			const give = () => resolve(fauxAssistantMessage([fauxText(text)]));
			options?.signal?.addEventListener("abort", give, { once: true });
			void released.promise.then(give);
		});
	};
	return { response, requested: requested.promise, release: () => released.resolve() };
}

/** A `MemoryStorage` that stays readable after its harness closed it, and counts how often it was closed. */
export class KeptStorage extends MemoryStorage {
	closes = 0;

	override async close(): Promise<void> {
		this.closes += 1;
	}
}

/** A harness on `storage` (default: fresh memory) and `registry` (default: empty), answered by `models` or `responses`. */
export function harnessLayer<R = never, H = never>(options: {
	readonly responses?: FauxResponseStep[];
	readonly models?: Layer.Layer<Models>;
	readonly registry?: Layer.Layer<Registry.Registry, SchemaConversionError, R>;
	readonly storage?: Layer.Layer<Storage.HarnessStorage>;
	readonly harness?: Harness.Options<H>;
}) {
	return Harness.layer(options.harness).pipe(
		Layer.provide(options.registry ?? Registry.layer([])),
		Layer.provide(options.storage ?? Storage.memory),
		Layer.provide(options.models ?? scriptedModels(options.responses ?? []).layer),
	);
}
