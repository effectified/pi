// pi-coding-agent's model registry in Effect: the view of the model runtime an extension context gives, its queries
// as Effects.

import { ModelRegistry as PiModelRegistry, type ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelId, ModelType, ModelTypeMap, Provider, ProviderId } from "@effectified/pi-ai";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { ModelRuntime } from "./model-runtime.ts";

/** A model registry: Pi's object and its members as Effects. */
export interface ModelRegistryHandle {
	/** Pi's registry, for what takes one as it is. */
	readonly pi: PiModelRegistry;
	/** Reloads `models.json` and the catalogs, and checks credentials again. */
	readonly refresh: (
		options?: Omit<NonNullable<Parameters<PiModelRegistry["refresh"]>[0]>, "signal">,
	) => Effect.Effect<Awaited<ReturnType<PiModelRegistry["refresh"]>>, CodingAgentFailure>;
	readonly getError: Effect.Effect<string | undefined>;
	readonly getAll: Effect.Effect<ReturnType<PiModelRegistry["getAll"]>>;
	/** The chat models that had credentials at the last check. */
	readonly getAvailable: Effect.Effect<ReturnType<PiModelRegistry["getAvailable"]>>;
	readonly find: (provider: ProviderId, modelId: ModelId) => Effect.Effect<ReturnType<PiModelRegistry["find"]>>;
	readonly hasConfiguredAuth: (model: Parameters<PiModelRegistry["hasConfiguredAuth"]>[0]) => Effect.Effect<boolean>;
	/** The API key and headers a request with `model` would carry now. */
	readonly getApiKeyAndHeaders: (
		model: Parameters<PiModelRegistry["getApiKeyAndHeaders"]>[0],
	) => Effect.Effect<Awaited<ReturnType<PiModelRegistry["getApiKeyAndHeaders"]>>, CodingAgentFailure>;
	readonly getProviderAuthStatus: (
		provider: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRegistry["getProviderAuthStatus"]>>;
	readonly getProvider: (provider: ProviderId) => Effect.Effect<ReturnType<PiModelRegistry["getProvider"]>>;
	readonly getModelsOfType: <T extends ModelType>(
		type: T,
		provider?: ProviderId,
	) => Effect.Effect<readonly ModelTypeMap[T][]>;
	/** A model of a non-chat type, such as a classifier. */
	readonly findOfType: <T extends ModelType>(
		type: T,
		provider: ProviderId,
		modelId: ModelId,
	) => Effect.Effect<ModelTypeMap[T] | undefined>;
	readonly getModelOfType: <T extends ModelType>(
		type: T,
		provider: ProviderId,
		modelId: ModelId,
	) => Effect.Effect<ModelTypeMap[T] | undefined>;
	/** The models of one type whose provider has credentials, checked now. */
	readonly getAvailableOfType: <T extends ModelType>(
		type: T,
		provider?: ProviderId,
		options?: Omit<NonNullable<Parameters<PiModelRegistry["getAvailableOfType"]>[2]>, "signal">,
	) => Effect.Effect<readonly ModelTypeMap[T][], CodingAgentFailure>;
	readonly getProviderDisplayName: (provider: ProviderId) => Effect.Effect<string>;
	readonly getProviderAuth: (
		provider: ProviderId,
	) => Effect.Effect<Awaited<ReturnType<PiModelRegistry["getProviderAuth"]>>, CodingAgentFailure>;
	/** The provider's API key, `Redacted`; none when it has none. */
	readonly getApiKeyForProvider: (
		provider: ProviderId,
	) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CodingAgentFailure>;
	readonly isUsingOAuth: (model: Parameters<PiModelRegistry["isUsingOAuth"]>[0]) => Effect.Effect<boolean>;
	/** Adds (or replaces) a pi-ai provider. */
	readonly registerProvider: (provider: Provider) => Effect.Effect<void, CodingAgentFailure>;
	/** Adds (or overrides) the provider `name` from configuration, as `models.json` and extensions do. */
	readonly registerProviderConfig: (
		name: ProviderId,
		config: Parameters<PiModelRuntime["registerProvider"]>[1],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterProvider: (provider: ProviderId) => Effect.Effect<void>;
	readonly registerVirtualModel: (
		definition: Parameters<PiModelRegistry["registerVirtualModel"]>[0],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterVirtualModel: (provider: ProviderId, id: ModelId) => Effect.Effect<void>;
	readonly getRegisteredProviderConfig: (
		provider: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRegistry["getRegisteredProviderConfig"]>>;
	readonly getRegisteredNativeProvider: (
		provider: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRegistry["getRegisteredNativeProvider"]>>;
	readonly getRegisteredProviderIds: Effect.Effect<ReturnType<PiModelRegistry["getRegisteredProviderIds"]>>;
}

/** The model registry of the program, over its `ModelRuntime`. */
export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryHandle>()(
	"@effectified/pi-coding-agent/model-registry/ModelRegistry",
) {
	/** Pi's registry over the program's `ModelRuntime`. */
	static readonly layer: Layer.Layer<ModelRegistry, never, ModelRuntime> = Layer.effect(
		ModelRegistry,
		ModelRuntime.use((runtime) => Effect.sync(() => fromPiRegistry(new PiModelRegistry(runtime.pi)))),
	);
}

/** Pi's registry as a handle. */
export function fromPiRegistry(pi: PiModelRegistry): ModelRegistryHandle {
	// Pi's asynchronous members, each a span named for it: they reach the network or the credential store.
	const call = <A>(name: string, run: (signal: AbortSignal) => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: fromPi }).pipe(Effect.withSpan(`ModelRegistry.${name}`));
	return {
		pi,
		refresh: (options) => call("refresh", (signal) => pi.refresh({ ...options, signal })),
		getError: Effect.sync(() => pi.getError()),
		getAll: Effect.sync(() => pi.getAll()),
		getAvailable: Effect.sync(() => pi.getAvailable()),
		find: (provider, modelId) => Effect.sync(() => pi.find(provider, modelId)),
		hasConfiguredAuth: (model) => Effect.sync(() => pi.hasConfiguredAuth(model)),
		getApiKeyAndHeaders: (model) => call("getApiKeyAndHeaders", () => pi.getApiKeyAndHeaders(model)),
		getProviderAuthStatus: (provider) => Effect.sync(() => pi.getProviderAuthStatus(provider)),
		getProvider: (provider) => Effect.sync(() => pi.getProvider(provider)),
		getModelsOfType: (type, provider) => Effect.sync(() => pi.getModelsOfType(type, provider)),
		findOfType: (type, provider, modelId) => Effect.sync(() => pi.findOfType(type, provider, modelId)),
		getModelOfType: (type, provider, modelId) => Effect.sync(() => pi.getModelOfType(type, provider, modelId)),
		getAvailableOfType: (type, provider, options) =>
			call("getAvailableOfType", (signal) => pi.getAvailableOfType(type, provider, { ...options, signal })),
		getProviderDisplayName: (provider) => Effect.sync(() => pi.getProviderDisplayName(provider)),
		getProviderAuth: (provider) => call("getProviderAuth", () => pi.getProviderAuth(provider)),
		getApiKeyForProvider: (provider) =>
			Effect.map(
				call("getApiKeyForProvider", () => pi.getApiKeyForProvider(provider)),
				(key) => Option.map(Option.fromUndefinedOr(key), (value) => Redacted.make(value)),
			),
		isUsingOAuth: (model) => Effect.sync(() => pi.isUsingOAuth(model)),
		registerProvider: (provider) => Effect.try({ try: () => pi.registerProvider(provider), catch: fromPi }),
		registerProviderConfig: (name, config) =>
			Effect.try({ try: () => pi.registerProvider(name, config), catch: fromPi }),
		unregisterProvider: (provider) => Effect.sync(() => pi.unregisterProvider(provider)),
		registerVirtualModel: (definition) =>
			Effect.try({ try: () => pi.registerVirtualModel(definition), catch: fromPi }),
		unregisterVirtualModel: (provider, id) => Effect.sync(() => pi.unregisterVirtualModel(provider, id)),
		getRegisteredProviderConfig: (provider) => Effect.sync(() => pi.getRegisteredProviderConfig(provider)),
		getRegisteredNativeProvider: (provider) => Effect.sync(() => pi.getRegisteredNativeProvider(provider)),
		getRegisteredProviderIds: Effect.sync(() => pi.getRegisteredProviderIds()),
	};
}
