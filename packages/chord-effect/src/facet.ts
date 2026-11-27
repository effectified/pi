// A Chord facet whose method handlers are Effects that use services: the facet a Chord host loads like any other.

import {
	type ClientModules,
	defineFacet,
	type Facet,
	type FacetHost,
	type FacetSelf,
	type LoadReport,
	LoadedFacets as PiLoadedFacets,
	type PluginFacet,
	type Principal,
	evaluateRegistered as piEvaluateRegistered,
	type RegisteredScript,
	type ReloadReport,
	type SetEntry,
} from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Effect, Schema } from "effect";
import { chordCall } from "./call.ts";
import type { ChordCallError } from "./errors.ts";
import type { Host } from "./host.ts";
import { runner } from "./runner.ts";

// Chord's facet types, under this module.
export type {
	ClientModules,
	Facet,
	FacetHost,
	FacetSelf,
	PluginFacet,
	Prepared,
	RegisteredScript,
	ServeOptions,
	SetEntry,
} from "@earendil-works/chord";

/**
 * Turns an Effect handler into the promise-returning function Chord calls: a method (`(args, ctx)` or `(ctx)`), an
 * `on` routine, a job's run. Its last argument is Chord's context of the call (`ctx`): the Effect runs with it as its
 * `ParentContext` and is interrupted when Chord cancels the call. A failure reaches the caller as Chord's error:
 * `ChordFailed` and `PluginFailed` with their code (`invalid`, `forbidden`, a plugin's own), anything else as an
 * internal error.
 */
export type Lift<R> = <Params extends readonly [...unknown[], ChordContext], A, E>(
	handler: (...params: Params) => Effect.Effect<A, E, R>,
) => (...params: Params) => Promise<A>;

/**
 * Defines a facet whose handlers are Effects: `setup` declares as Chord's does (`host.serve`, `self.contribute`), and
 * wraps each Effect handler with `lift`. The handlers run with the services of the context this Effect runs in, so
 * the facet needs `R`, what they use.
 */
export function make<P extends Principal, R = never>(
	setup: (host: FacetHost<P>, self: FacetSelf, lift: Lift<R>) => void,
): Effect.Effect<Facet<P>, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = runner(context);
		const lift: Lift<R> =
			(handler) =>
			(...params) =>
				// The last argument is the call's ctx, as `Lift` declares.
				run(handler(...params), params[params.length - 1] as ChordContext);
		return defineFacet<P>((host, self) => setup(host, self, lift));
	});
}

/** A plugin's script that would not evaluate: what it threw, or a default export that is no facet. */
export class ScriptFailed extends Schema.TaggedError<ScriptFailed, { readonly brand: unique symbol }>()(
	"ScriptFailed",
	{
		plugin: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Chord's `evaluateRegistered`: runs a registered plugin script and gives its facet. Its `require` answers `modules`
 * only. Fails with `ScriptFailed` when the script throws or exports no facet.
 */
export function evaluate<P extends Principal = Principal>(
	script: RegisteredScript,
	modules: ClientModules,
): Effect.Effect<Facet<P>, ScriptFailed> {
	return Effect.try({
		try: () => piEvaluateRegistered<P>(script, modules),
		catch: (cause) => ScriptFailed.make({ plugin: script.plugin, cause }),
	});
}

/** A host's loaded plugin scripts (Chord's `LoadedFacets`), reloaded one set after another. */
export interface LoadedSet {
	/** Reloads the host on `entries`, the complete new set: a plugin whose script failed keeps its old code. */
	readonly reload: (entries: readonly SetEntry[]) => Effect.Effect<ReloadReport, ChordCallError>;
}

/**
 * Chord's `LoadedFacets.load`: loads `core` (the app's own facets) and the plugin scripts `entries` on `host`; a
 * script that fails to prepare is left out and reported in the report's `failed`. Gives the loaded set and the report.
 */
export function loadSet<P extends Principal>(
	host: Host<P>,
	core: readonly PluginFacet<P>[],
	entries: readonly SetEntry[],
): Effect.Effect<{ readonly loaded: LoadedSet; readonly report: LoadReport }, ChordCallError> {
	return Effect.map(
		chordCall((context) => PiLoadedFacets.load(host.host, core, entries, context)),
		({ loaded, report }) => ({
			loaded: { reload: (next) => chordCall((context) => loaded.reload(host.host, next, context)) },
			report,
		}),
	);
}
