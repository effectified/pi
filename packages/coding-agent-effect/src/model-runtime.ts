// pi-coding-agent's model runtime in Effect: the providers, models and credentials of a coding agent as a service and
// its queries as Effects. Its providers are pi-ai's, so `@effectified/pi-ai`'s (`EffectProvider.make`, the scripted
// provider of its tests) register on it.

import {
	type CreateModelRuntimeOptions,
	type ModelRuntimeAuthOverrides,
	ModelRuntime as PiModelRuntime,
	readStoredCredential as piReadStoredCredential,
	resolveModelScopeWithDiagnostics as piResolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import type { ModelId, ModelType, ModelTypeMap, ProviderId } from "@effectified/pi-ai";
import { Context, Effect, Layer, Redacted } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** One argument list of a Pi method, without the abort signal the fiber owns. */
type Unsignalled<O> = O extends { signal?: AbortSignal } ? Omit<O, "signal"> : O;

/** The options of Pi's credential operations, without the signal the fiber owns. */
export type AuthOptions = Unsignalled<NonNullable<Parameters<PiModelRuntime["setRuntimeApiKey"]>[2]>>;

/** A model runtime: Pi's object and its members as Effects. */
export interface ModelRuntimeHandle {
	/** Pi's runtime, for what takes one as it is: a session, a resource loader. */
	readonly pi: PiModelRuntime;
	readonly getProviders: Effect.Effect<ReturnType<PiModelRuntime["getProviders"]>>;
	readonly getProvider: (providerId: ProviderId) => Effect.Effect<ReturnType<PiModelRuntime["getProvider"]>>;
	readonly getModels: (providerId?: ProviderId) => Effect.Effect<ReturnType<PiModelRuntime["getModels"]>>;
	readonly getModel: (
		providerId: ProviderId,
		modelId: ModelId,
	) => Effect.Effect<ReturnType<PiModelRuntime["getModel"]>>;
	readonly getModelsOfType: <T extends ModelType>(
		type: T,
		providerId?: ProviderId,
	) => Effect.Effect<readonly ModelTypeMap[T][]>;
	readonly getModelOfType: <T extends ModelType>(
		type: T,
		providerId: ProviderId,
		modelId: ModelId,
	) => Effect.Effect<ModelTypeMap[T] | undefined>;
	/** The models of one type whose provider has credentials, checked now. */
	readonly getAvailableOfType: <T extends ModelType>(
		type: T,
		providerId?: ProviderId,
		options?: AuthOptions,
	) => Effect.Effect<readonly ModelTypeMap[T][], CodingAgentFailure>;
	/** Every model of every type (chat, image, classifier). */
	readonly getAllModels: (providerId?: ProviderId) => Effect.Effect<ReturnType<PiModelRuntime["getAllModels"]>>;
	/** The chat models whose provider has credentials, checked now. */
	readonly getAvailable: (
		providerId?: ProviderId,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAvailable"]>>, CodingAgentFailure>;
	/** Every model of every type whose provider has credentials, checked now. */
	readonly getAllAvailable: (
		providerId?: ProviderId,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAllAvailable"]>>, CodingAgentFailure>;
	/** The chat models that had credentials at the last check. */
	readonly getAvailableSnapshot: Effect.Effect<ReturnType<PiModelRuntime["getAvailableSnapshot"]>>;
	readonly checkAuth: (
		providerId: ProviderId,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["checkAuth"]>>, CodingAgentFailure>;
	/** The last error of loading models or checking credentials. */
	readonly getError: Effect.Effect<string | undefined>;
	readonly getRegisteredProviderConfig: (
		providerId: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRuntime["getRegisteredProviderConfig"]>>;
	readonly getRegisteredProviderIds: Effect.Effect<ReturnType<PiModelRuntime["getRegisteredProviderIds"]>>;
	readonly getRegisteredNativeProvider: (
		providerId: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRuntime["getRegisteredNativeProvider"]>>;
	readonly getCompatibilityRequestConfig: (
		getModel: Parameters<PiModelRuntime["getCompatibilityRequestConfig"]>[0],
	) => Effect.Effect<ReturnType<PiModelRuntime["getCompatibilityRequestConfig"]>>;
	readonly isUsingOAuth: (providerId: ProviderId) => Effect.Effect<boolean>;
	readonly isUsingSubscription: (providerId: ProviderId) => Effect.Effect<boolean>;
	readonly hasConfiguredAuth: (providerId: ProviderId) => Effect.Effect<boolean>;
	readonly getProviderAuthStatus: (
		providerId: ProviderId,
	) => Effect.Effect<ReturnType<PiModelRuntime["getProviderAuthStatus"]>>;
	/** The credentials a request to a provider (or a model) would use now. */
	readonly getAuth: (
		target: AuthTarget,
		overrides?: Unsignalled<ModelRuntimeAuthOverrides>,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAuth"]>>, CodingAgentFailure>;
	/** Sets an API key for this process only, not stored. It leaves `Redacted` where Pi keeps it. */
	readonly setRuntimeApiKey: (
		providerId: ProviderId,
		apiKey: Redacted.Redacted<string>,
		options?: AuthOptions,
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly removeRuntimeApiKey: (
		providerId: ProviderId,
		options?: AuthOptions,
	) => Effect.Effect<void, CodingAgentFailure>;
	/** Waits until credential writes in progress are stored. */
	readonly settleCredentialWrites: Effect.Effect<void, CodingAgentFailure>;
	readonly listCredentials: (
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["listCredentials"]>>, CodingAgentFailure>;
	readonly logout: (providerId: ProviderId, options?: AuthOptions) => Effect.Effect<void, CodingAgentFailure>;
	/** Reloads `models.json` and the catalogs, and checks credentials again. */
	readonly refresh: (
		options?: Unsignalled<NonNullable<Parameters<PiModelRuntime["refresh"]>[0]>>,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["refresh"]>>, CodingAgentFailure>;
	/** Adds a pi-ai provider, such as `ScriptedModels`' or one of `EffectProvider.make`. */
	readonly registerNativeProvider: (
		provider: Parameters<PiModelRuntime["registerNativeProvider"]>[0],
	) => Effect.Effect<void>;
	/** Adds or overrides a provider from configuration, as `models.json` and extensions do. */
	readonly registerProvider: (
		providerId: ProviderId,
		config: Parameters<PiModelRuntime["registerProvider"]>[1],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterProvider: (providerId: ProviderId) => Effect.Effect<void>;
	readonly registerVirtualModel: (
		definition: Parameters<PiModelRuntime["registerVirtualModel"]>[0],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterVirtualModel: (providerId: ProviderId, id: string) => Effect.Effect<void>;
	/** Where a virtual model routes a request: Pi's `resolveModel`. */
	readonly resolveModel: (
		getModel: Parameters<PiModelRuntime["resolveModel"]>[0],
		messages: Parameters<PiModelRuntime["resolveModel"]>[1],
		options: Unsignalled<Parameters<PiModelRuntime["resolveModel"]>[2]>,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["resolveModel"]>>, CodingAgentFailure>;
	/** The model a virtual model stands for, or the model itself. */
	readonly getPhysicalModel: (
		providerId: ProviderId,
		modelId: ModelId,
	) => Effect.Effect<ReturnType<PiModelRuntime["getPhysicalModel"]>>;
}

/** What `auth` looks credentials up for: a provider id, or a model of any type. */
export type AuthTarget = Parameters<PiModelRuntime["getAuth"]>[0];

/** What `ModelRuntime.layer` takes: Pi's options, without the signal the fiber owns. */
export type Options = Unsignalled<CreateModelRuntimeOptions>;

/** The model runtime of the program: what a session asks for models and credentials. */
export class ModelRuntime extends Context.Service<ModelRuntime, ModelRuntimeHandle>()(
	"@effectified/pi-coding-agent/model-runtime/ModelRuntime",
) {
	/**
	 * Pi's `ModelRuntime.create`: credentials from `authPath` (default the agent directory's `auth.json`), models from
	 * `modelsPath` (`null`: none), refreshed from the network only with `allowModelNetwork`. Interrupting it cancels
	 * the first refresh.
	 */
	static layer(options: Options = {}): Layer.Layer<ModelRuntime, CodingAgentFailure> {
		return Layer.effect(ModelRuntime, ModelRuntime.make(options));
	}

	/** A new model runtime: Pi's `ModelRuntime.create`. Interrupting it cancels the first refresh. */
	static readonly make = Effect.fn("ModelRuntime.make")(
		(options: Options = {}): Effect.Effect<ModelRuntimeHandle, CodingAgentFailure> =>
			Effect.map(
				Effect.tryPromise({ try: (signal) => PiModelRuntime.create({ ...options, signal }), catch: fromPi }),
				fromPiRuntime,
			),
	);
}

/** Pi's runtime as a handle. It stays the caller's: the handle adds nothing to its lifetime. */
export function fromPiRuntime(pi: PiModelRuntime): ModelRuntimeHandle {
	// Pi's asynchronous members, each a span named for it: they reach the network or the credential store.
	const call = <A>(name: string, run: (signal: AbortSignal) => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: fromPi }).pipe(Effect.withSpan(`ModelRuntime.${name}`));
	return {
		pi,
		getProviders: Effect.sync(() => pi.getProviders()),
		getProvider: (providerId) => Effect.sync(() => pi.getProvider(providerId)),
		getModels: (providerId) => Effect.sync(() => pi.getModels(providerId)),
		getModel: (providerId, modelId) => Effect.sync(() => pi.getModel(providerId, modelId)),
		getModelsOfType: (type, providerId) => Effect.sync(() => pi.getModelsOfType(type, providerId)),
		getModelOfType: (type, providerId, modelId) => Effect.sync(() => pi.getModelOfType(type, providerId, modelId)),
		getAvailableOfType: (type, providerId, options) =>
			call("getAvailableOfType", (signal) => pi.getAvailableOfType(type, providerId, { ...options, signal })),
		getAllModels: (providerId) => Effect.sync(() => pi.getAllModels(providerId)),
		getAvailable: (providerId, options) =>
			call("getAvailable", (signal) => pi.getAvailable(providerId, { ...options, signal })),
		getAllAvailable: (providerId, options) =>
			call("getAllAvailable", (signal) => pi.getAllAvailable(providerId, { ...options, signal })),
		getAvailableSnapshot: Effect.sync(() => pi.getAvailableSnapshot()),
		checkAuth: (providerId, options) =>
			call("checkAuth", (signal) => pi.checkAuth(providerId, { ...options, signal })),
		getError: Effect.sync(() => pi.getError()),
		getRegisteredProviderConfig: (providerId) => Effect.sync(() => pi.getRegisteredProviderConfig(providerId)),
		getRegisteredProviderIds: Effect.sync(() => pi.getRegisteredProviderIds()),
		getRegisteredNativeProvider: (providerId) => Effect.sync(() => pi.getRegisteredNativeProvider(providerId)),
		getCompatibilityRequestConfig: (model) => Effect.sync(() => pi.getCompatibilityRequestConfig(model)),
		isUsingOAuth: (providerId) => Effect.sync(() => pi.isUsingOAuth(providerId)),
		isUsingSubscription: (providerId) => Effect.sync(() => pi.isUsingSubscription(providerId)),
		hasConfiguredAuth: (providerId) => Effect.sync(() => pi.hasConfiguredAuth(providerId)),
		getProviderAuthStatus: (providerId) => Effect.sync(() => pi.getProviderAuthStatus(providerId)),
		getAuth: (target, overrides) =>
			call("getAuth", (signal) =>
				typeof target === "string"
					? pi.getAuth(target, { ...overrides, signal })
					: pi.getAuth(target, { ...overrides, signal }),
			),
		setRuntimeApiKey: (providerId, apiKey, options) =>
			call("setRuntimeApiKey", (signal) =>
				pi.setRuntimeApiKey(providerId, Redacted.value(apiKey), { ...options, signal }),
			),
		removeRuntimeApiKey: (providerId, options) =>
			call("removeRuntimeApiKey", (signal) => pi.removeRuntimeApiKey(providerId, { ...options, signal })),
		settleCredentialWrites: call("settleCredentialWrites", () => pi.settleCredentialWrites()),
		listCredentials: (options) => call("listCredentials", (signal) => pi.listCredentials({ ...options, signal })),
		logout: (providerId, options) => call("logout", (signal) => pi.logout(providerId, { ...options, signal })),
		refresh: (options) => call("refresh", (signal) => pi.refresh({ ...options, signal })),
		registerNativeProvider: (provider) => Effect.sync(() => pi.registerNativeProvider(provider)),
		registerProvider: (providerId, config) =>
			Effect.try({ try: () => pi.registerProvider(providerId, config), catch: fromPi }),
		unregisterProvider: (providerId) => Effect.sync(() => pi.unregisterProvider(providerId)),
		registerVirtualModel: (definition) =>
			Effect.try({ try: () => pi.registerVirtualModel(definition), catch: fromPi }),
		unregisterVirtualModel: (providerId, id) => Effect.sync(() => pi.unregisterVirtualModel(providerId, id)),
		resolveModel: (model, messages, options) =>
			call("resolveModel", (signal) => pi.resolveModel(model, messages, { ...options, signal })),
		getPhysicalModel: (providerId, modelId) => Effect.sync(() => pi.getPhysicalModel(providerId, modelId)),
	};
}

/** The credential of `providerId` stored in `authPath` (default: the agent directory's `auth.json`), read now. */
export const readStoredCredential = Effect.fn("ModelRuntime.readStoredCredential")(
	(
		providerId: ProviderId,
		authPath?: string,
	): Effect.Effect<ReturnType<typeof piReadStoredCredential>, CodingAgentFailure> =>
		Effect.try({ try: () => piReadStoredCredential(providerId, authPath), catch: fromPi }),
);

/**
 * The models `patterns` select (`--models`, the `enabledModels` setting) among those of `runtime` with credentials,
 * and what Pi found wrong with the patterns.
 */
export const resolveModelScopeWithDiagnostics = Effect.fn("ModelRuntime.resolveModelScopeWithDiagnostics")(
	(
		patterns: ReadonlyArray<string>,
		runtime: ModelRuntimeHandle,
		options?: AuthOptions,
	): Effect.Effect<Awaited<ReturnType<typeof piResolveModelScopeWithDiagnostics>>, CodingAgentFailure> =>
		Effect.tryPromise({
			try: (signal) => piResolveModelScopeWithDiagnostics([...patterns], runtime.pi, { ...options, signal }),
			catch: fromPi,
		}),
);
