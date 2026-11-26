// Pi's model collection (`Models`) as an Effect service: the providers a program can call and their credentials.

import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { ProviderAuthContext, toPiAuthContext } from "./auth-context.ts";
import { Credentials, toPiStore } from "./credentials.ts";
import { currentRunner } from "./run-in-pi.ts";

/**
 * The pi-ai `Models` collection of this program. The service value is pi-ai's own object, so it can be handed to
 * anything that takes one (a Pi Durable harness), and providers can be added or replaced while the program runs.
 */
export class Models extends Context.Service<Models, MutableModels>()("@effectified/pi-ai/Models") {
	/** A fresh collection holding `providers`; a later provider replaces an earlier one with the same id. */
	static layer(providers: readonly Provider[], options?: CreateModelsOptions): Layer.Layer<Models> {
		return Layer.sync(Models, () => withProviders(createModels(options), providers));
	}

	/**
	 * `layer` with its credentials in the `Credentials` service and the environment and files of its auth from the
	 * `ProviderAuthContext` service, each called in the context the layer is built in. pi-ai refreshes OAuth tokens
	 * inside the store's `modify`, so the store's one-at-a-time rule is what keeps two requests from refreshing one
	 * token twice.
	 */
	static layerWithAuth(
		providers: readonly Provider[],
		options?: Omit<CreateModelsOptions, "credentials" | "authContext">,
	): Layer.Layer<Models, never, Credentials | ProviderAuthContext> {
		return Layer.effect(
			Models,
			Effect.gen(function* () {
				const credentials = yield* Credentials;
				const authContext = yield* ProviderAuthContext;
				const run = yield* currentRunner<never>();
				const models = createModels({
					...options,
					credentials: toPiStore(credentials, run),
					authContext: toPiAuthContext(authContext, run),
				});
				return withProviders(models, providers);
			}),
		);
	}
}

function withProviders(models: MutableModels, providers: readonly Provider[]): MutableModels {
	for (const provider of providers) models.setProvider(provider);
	return models;
}
