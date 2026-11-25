// Pi's model collection (`Models`) as an Effect service: the providers a program can call and their credentials.

import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { Context, Layer } from "effect";

/**
 * The pi-ai `Models` collection of this program. The service value is pi-ai's own object, so it can be handed to
 * anything that takes one (a Pi Durable harness), and providers can be added or replaced while the program runs.
 */
export class Models extends Context.Service<Models, MutableModels>()("@gunta/pi-ai-effect/Models") {
	/** A fresh collection holding `providers`; a later provider replaces an earlier one with the same id. */
	static layer(providers: readonly Provider[], options?: CreateModelsOptions): Layer.Layer<Models> {
		return Layer.sync(Models, () => {
			const models = createModels(options);
			for (const provider of providers) models.setProvider(provider);
			return models;
		});
	}
}
