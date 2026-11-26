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
import type { ModelType, ModelTypeMap } from "@effectified/pi-ai";
import { Context, Effect, Layer } from "effect";
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
	readonly getProvider: (providerId: string) => Effect.Effect<ReturnType<PiModelRuntime["getProvider"]>>;
	readonly getModels: (providerId?: string) => Effect.Effect<ReturnType<PiModelRuntime["getModels"]>>;
	readonly getModel: (providerId: string, modelId: string) => Effect.Effect<ReturnType<PiModelRuntime["getModel"]>>;
	readonly getModelsOfType: <T extends ModelType>(
		type: T,
		providerId?: string,
	) => Effect.Effect<readonly ModelTypeMap[T][]>;
	readonly getModelOfType: <T extends ModelType>(
		type: T,
		providerId: string,
		modelId: string,
	) => Effect.Effect<ModelTypeMap[T] | undefined>;
	/** The models of one type whose provider has credentials, checked now. */
	readonly getAvailableOfType: <T extends ModelType>(
		type: T,
		providerId?: string,
		options?: AuthOptions,
	) => Effect.Effect<readonly ModelTypeMap[T][], CodingAgentFailure>;
	/** Every model of every type (chat, image, classifier). */
	readonly getAllModels: (providerId?: string) => Effect.Effect<ReturnType<PiModelRuntime["getAllModels"]>>;
	/** The chat models whose provider has credentials, checked now. */
	readonly getAvailable: (
		providerId?: string,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAvailable"]>>, CodingAgentFailure>;
	/** Every model of every type whose provider has credentials, checked now. */
	readonly getAllAvailable: (
		providerId?: string,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAllAvailable"]>>, CodingAgentFailure>;
	/** The chat models that had credentials at the last check. */
	readonly getAvailableSnapshot: Effect.Effect<ReturnType<PiModelRuntime["getAvailableSnapshot"]>>;
	readonly checkAuth: (
		providerId: string,
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["checkAuth"]>>, CodingAgentFailure>;
	/** The last error of loading models or checking credentials. */
	readonly getError: Effect.Effect<string | undefined>;
	readonly getRegisteredProviderConfig: (
		providerId: string,
	) => Effect.Effect<ReturnType<PiModelRuntime["getRegisteredProviderConfig"]>>;
	readonly getRegisteredProviderIds: Effect.Effect<ReturnType<PiModelRuntime["getRegisteredProviderIds"]>>;
	readonly getRegisteredNativeProvider: (
		providerId: string,
	) => Effect.Effect<ReturnType<PiModelRuntime["getRegisteredNativeProvider"]>>;
	readonly getCompatibilityRequestConfig: (
		getModel: Parameters<PiModelRuntime["getCompatibilityRequestConfig"]>[0],
	) => Effect.Effect<ReturnType<PiModelRuntime["getCompatibilityRequestConfig"]>>;
	readonly isUsingOAuth: (providerId: string) => Effect.Effect<boolean>;
	readonly isUsingSubscription: (providerId: string) => Effect.Effect<boolean>;
	readonly hasConfiguredAuth: (providerId: string) => Effect.Effect<boolean>;
	readonly getProviderAuthStatus: (
		providerId: string,
	) => Effect.Effect<ReturnType<PiModelRuntime["getProviderAuthStatus"]>>;
	/** The credentials a request to a provider (or a model) would use now. */
	readonly getAuth: (
		target: AuthTarget,
		overrides?: Unsignalled<ModelRuntimeAuthOverrides>,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["getAuth"]>>, CodingAgentFailure>;
	/** Sets an API key for this process only, not stored. */
	readonly setRuntimeApiKey: (
		providerId: string,
		apiKey: string,
		options?: AuthOptions,
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly removeRuntimeApiKey: (providerId: string, options?: AuthOptions) => Effect.Effect<void, CodingAgentFailure>;
	/** Waits until credential writes in progress are stored. */
	readonly settleCredentialWrites: Effect.Effect<void, CodingAgentFailure>;
	readonly listCredentials: (
		options?: AuthOptions,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["listCredentials"]>>, CodingAgentFailure>;
	readonly logout: (providerId: string, options?: AuthOptions) => Effect.Effect<void, CodingAgentFailure>;
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
		providerId: string,
		config: Parameters<PiModelRuntime["registerProvider"]>[1],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterProvider: (providerId: string) => Effect.Effect<void>;
	readonly registerVirtualModel: (
		definition: Parameters<PiModelRuntime["registerVirtualModel"]>[0],
	) => Effect.Effect<void, CodingAgentFailure>;
	readonly unregisterVirtualModel: (providerId: string, id: string) => Effect.Effect<void>;
	/** Where a virtual model routes a request: Pi's `resolveModel`. */
	readonly resolveModel: (
		getModel: Parameters<PiModelRuntime["resolveModel"]>[0],
		messages: Parameters<PiModelRuntime["resolveModel"]>[1],
		options: Unsignalled<Parameters<PiModelRuntime["resolveModel"]>[2]>,
	) => Effect.Effect<Awaited<ReturnType<PiModelRuntime["resolveModel"]>>, CodingAgentFailure>;
	/** The model a virtual model stands for, or the model itself. */
	readonly getPhysicalModel: (
		providerId: string,
		modelId: string,
	) => Effect.Effect<ReturnType<PiModelRuntime["getPhysicalModel"]>>;
}

/** What `auth` looks credentials up for: a provider id, or a model of any type. */
export type AuthTarget = Parameters<PiModelRuntime["getAuth"]>[0];

/** What `ModelRuntime.layer` takes: Pi's options, without the signal the fiber owns. */
export type Options = Unsignalled<CreateModelRuntimeOptions>;

/** The model runtime of the program: what a session asks for models and credentials. */
export class ModelRuntime extends Context.Service<ModelRuntime, ModelRuntimeHandle>()(
	"@effectified/pi-coding-agent/ModelRuntime",
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
	static make(options: Options = {}): Effect.Effect<ModelRuntimeHandle, CodingAgentFailure> {
		return Effect.map(
			Effect.tryPromise({ try: (signal) => PiModelRuntime.create({ ...options, signal }), catch: fromPi }),
			fromPiRuntime,
		);
	}
}

/** Pi's runtime as a handle. It stays the caller's: the handle adds nothing to its lifetime. */
export function fromPiRuntime(pi: PiModelRuntime): ModelRuntimeHandle {
	const call = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: fromPi });
	return {
		pi,
		getProviders: Effect.sync(() => pi.getProviders()),
		getProvider: (providerId) => Effect.sync(() => pi.getProvider(providerId)),
		getModels: (providerId) => Effect.sync(() => pi.getModels(providerId)),
		getModel: (providerId, modelId) => Effect.sync(() => pi.getModel(providerId, modelId)),
		getModelsOfType: (type, providerId) => Effect.sync(() => pi.getModelsOfType(type, providerId)),
		getModelOfType: (type, providerId, modelId) => Effect.sync(() => pi.getModelOfType(type, providerId, modelId)),
		getAvailableOfType: (type, providerId, options) =>
			call((signal) => pi.getAvailableOfType(type, providerId, { ...options, signal })),
		getAllModels: (providerId) => Effect.sync(() => pi.getAllModels(providerId)),
		getAvailable: (providerId, options) => call((signal) => pi.getAvailable(providerId, { ...options, signal })),
		getAllAvailable: (providerId, options) =>
			call((signal) => pi.getAllAvailable(providerId, { ...options, signal })),
		getAvailableSnapshot: Effect.sync(() => pi.getAvailableSnapshot()),
		checkAuth: (providerId, options) => call((signal) => pi.checkAuth(providerId, { ...options, signal })),
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
			call((signal) =>
				typeof target === "string"
					? pi.getAuth(target, { ...overrides, signal })
					: pi.getAuth(target, { ...overrides, signal }),
			),
		setRuntimeApiKey: (providerId, apiKey, options) =>
			call((signal) => pi.setRuntimeApiKey(providerId, apiKey, { ...options, signal })),
		removeRuntimeApiKey: (providerId, options) =>
			call((signal) => pi.removeRuntimeApiKey(providerId, { ...options, signal })),
		settleCredentialWrites: call(() => pi.settleCredentialWrites()),
		listCredentials: (options) => call((signal) => pi.listCredentials({ ...options, signal })),
		logout: (providerId, options) => call((signal) => pi.logout(providerId, { ...options, signal })),
		refresh: (options) => call((signal) => pi.refresh({ ...options, signal })),
		registerNativeProvider: (provider) => Effect.sync(() => pi.registerNativeProvider(provider)),
		registerProvider: (providerId, config) =>
			Effect.try({ try: () => pi.registerProvider(providerId, config), catch: fromPi }),
		unregisterProvider: (providerId) => Effect.sync(() => pi.unregisterProvider(providerId)),
		registerVirtualModel: (definition) =>
			Effect.try({ try: () => pi.registerVirtualModel(definition), catch: fromPi }),
		unregisterVirtualModel: (providerId, id) => Effect.sync(() => pi.unregisterVirtualModel(providerId, id)),
		resolveModel: (model, messages, options) =>
			call((signal) => pi.resolveModel(model, messages, { ...options, signal })),
		getPhysicalModel: (providerId, modelId) => Effect.sync(() => pi.getPhysicalModel(providerId, modelId)),
	};
}

/** The credential of `providerId` stored in `authPath` (default: the agent directory's `auth.json`), read now. */
export function readStoredCredential(
	providerId: string,
	authPath?: string,
): Effect.Effect<ReturnType<typeof piReadStoredCredential>, CodingAgentFailure> {
	return Effect.try({ try: () => piReadStoredCredential(providerId, authPath), catch: fromPi });
}

/**
 * The models `patterns` select (`--models`, the `enabledModels` setting) among those of `runtime` with credentials,
 * and what Pi found wrong with the patterns.
 */
export function resolveModelScopeWithDiagnostics(
	patterns: ReadonlyArray<string>,
	runtime: ModelRuntimeHandle,
	options?: AuthOptions,
): Effect.Effect<Awaited<ReturnType<typeof piResolveModelScopeWithDiagnostics>>, CodingAgentFailure> {
	return Effect.tryPromise({
		try: (signal) => piResolveModelScopeWithDiagnostics([...patterns], runtime.pi, { ...options, signal }),
		catch: fromPi,
	});
}
