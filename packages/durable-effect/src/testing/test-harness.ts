// A harness for tests: scripted models, memory storage and a registry of your extensions or your own, as one Layer.

import type { ModelRef } from "@earendil-works/pi-durable";
import type { Models } from "@effectified/pi-ai";
import { type FauxResponseStep, type RegisterFauxProviderOptions, ScriptedModels } from "@effectified/pi-ai/testing";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type * as Conversation from "../conversation.ts";
import type { DurableError } from "../errors.ts";
import type * as Extension from "../extension.ts";
import * as Harness from "../harness.ts";
import * as Registry from "../registry.ts";
import * as Storage from "../storage.ts";

/** Options of `layer`. */
export interface Options<Extensions extends ReadonlyArray<Extension.Extension>, E, R> {
	/** Installed in the registry, in order. Default: none. */
	readonly extensions?: Extensions;
	/** The model's first responses, in order; `ScriptedModels` queues more while the test runs. */
	readonly responses?: ReadonlyArray<FauxResponseStep>;
	/** Default: `Storage.memory`. Give a SQLite storage to test a close and a reopen. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage, E, R>;
	/** Options of `Harness.layer`; what its `conversationCreated` needs joins the Layer's requirements. */
	readonly harness?: Harness.Options<R>;
	/** Options of pi-ai's faux provider. Default: the api name `scripted`, so stored messages are the same every run. */
	readonly provider?: RegisterFauxProviderOptions;
}

/** What `layer` provides: the harness, and what it was built from. */
export type Provided = Harness.Harness | Registry.Registry | Storage.HarnessStorage | Models | ScriptedModels;

/**
 * An open harness whose model answers with scripted responses: no provider, no network, no key. It requires what
 * the extensions' handlers need. Every build is a fresh harness; with a storage that keeps its data, a second build
 * reopens what the first left.
 */
export function layer<const Extensions extends ReadonlyArray<Extension.Extension> = readonly [], E = never, R = never>(
	options: Options<Extensions, E, R> = {},
): Layer.Layer<Provided, DurableError | SchemaConversionError | E, R | Extension.Services<Extensions[number]>> {
	// `Registry.layer` reads the extensions as a tuple; an absent option is the empty one.
	const registry = Registry.layer(options.extensions ?? ([] as ReadonlyArray<Extension.Extension> as Extensions));
	return Harness.layer(options.harness).pipe(
		Layer.provideMerge(Layer.mergeAll(scripted(options), registry, options.storage ?? Storage.memory)),
	);
}

/** Options of `layerWith`. Each type parameter is read from the Layer given, and is `never` for an absent one. */
export interface WithOptions<RegistryOut, RegistryE, RegistryR, ModelsOut, ModelsE, ModelsR, E, R, HarnessR> {
	/**
	 * The registry the harness resolves extensions from, built by your own Layer, such as a guard's, with whatever else
	 * that Layer provides. Default: a registry without extensions.
	 */
	readonly registry?: Layer.Layer<Registry.Registry | RegistryOut, RegistryE, RegistryR>;
	/**
	 * A Layer that provides the `Models` the harness asks and requires the `Models` it wraps, such as a budget or a
	 * router, with whatever else it provides. The scripted provider is what it wraps: `ScriptedModels` still scripts the
	 * responses and counts the requests that reach the provider. Default: the scripted `Models` themselves.
	 */
	readonly models?: Layer.Layer<Models | ModelsOut, ModelsE, ModelsR>;
	/** The model's first responses, in order; `ScriptedModels` queues more while the test runs. */
	readonly responses?: ReadonlyArray<FauxResponseStep>;
	/** Default: `Storage.memory`. Give `sqlStorage` on a file to test a close and a reopen. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage, E, R>;
	/** Options of `Harness.layer`; what its `conversationCreated` needs joins the Layer's requirements. */
	readonly harness?: Harness.Options<HarnessR>;
	/** Options of pi-ai's faux provider. Default: the api name `scripted`. */
	readonly provider?: RegisterFauxProviderOptions;
}

// A registry without extensions converts no schema, so building it cannot fail.
const emptyRegistry: Layer.Layer<Registry.Registry> = Layer.orDie(Registry.layer([]));

/**
 * `layer` for a product that builds the registry itself or wraps the models: an open harness on your `registry` Layer
 * and on your `models` Layer over the scripted provider. It provides what `layer` provides and what your two Layers
 * provide besides, and requires what they, the storage and `conversationCreated` require. A Layer that needs the open
 * harness is provided over the result: `attach.pipe(Layer.provideMerge(TestHarness.layerWith(options)))`.
 */
export function layerWith<
	RegistryOut = never,
	RegistryE = never,
	RegistryR = never,
	ModelsOut = never,
	ModelsE = never,
	ModelsR = never,
	E = never,
	R = never,
	HarnessR = never,
>(
	options: WithOptions<RegistryOut, RegistryE, RegistryR, ModelsOut, ModelsE, ModelsR, E, R, HarnessR> = {},
): Layer.Layer<
	Provided | RegistryOut | ModelsOut,
	DurableError | RegistryE | ModelsE | E,
	RegistryR | Exclude<ModelsR, Models | ScriptedModels> | R | HarnessR
> {
	const models =
		options.models === undefined ? scripted(options) : Layer.provideMerge(options.models, scripted(options));
	return Harness.layer(options.harness).pipe(
		Layer.provideMerge(Layer.mergeAll(models, options.registry ?? emptyRegistry, options.storage ?? Storage.memory)),
	);
}

/**
 * Pi's SQLite storage on the `SqlClient` Layer you give, for a test that closes a harness and opens another on the
 * same data: with a database file, every build of a harness Layer on this storage reopens what the last one left. The
 * kit imports no driver: pass `SqliteClient.layer({ filename })` of `@effect/sql-sqlite-node` or
 * `@effect/sql-sqlite-bun`, whichever the test runs on. Memory storage cannot be reopened.
 */
export function sqlStorage<E = never, R = never>(
	client: Layer.Layer<SqlClient, E, R>,
	options?: Storage.SqlOptions,
): Layer.Layer<Storage.HarnessStorage, DurableError | E, R> {
	return Layer.provide(Storage.sql(options), client);
}

/** The agent change that selects the scripted model: a conversation without a model answers nothing. */
export const agent: Effect.Effect<{ readonly model: ModelRef }, never, ScriptedModels> = ScriptedModels.use(
	({ model }) => Effect.succeed({ model: { provider: model.provider, modelId: model.id } }),
);

/** The root conversation, created on the scripted model on first use. */
export const root: Effect.Effect<Conversation.Conversation, DurableError, Harness.Harness | ScriptedModels> =
	Effect.flatMap(agent, (change) => Harness.rootWith({ agent: change }));

/** The scripted provider with its first responses queued: `ScriptedModels`, and a `Models` that holds only it. */
function scripted(options: {
	readonly responses?: ReadonlyArray<FauxResponseStep>;
	readonly provider?: RegisterFauxProviderOptions;
}): Layer.Layer<Models | ScriptedModels> {
	return Layer.effectDiscard(ScriptedModels.use((models) => models.setResponses(options.responses ?? []))).pipe(
		Layer.provideMerge(ScriptedModels.layer(options.provider ?? { api: "scripted" })),
	);
}
