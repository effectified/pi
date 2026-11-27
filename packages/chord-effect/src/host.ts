// A Chord host as a scoped resource: its calls as Effects, the references it gives held for a scope, what it watches
// as Streams, its background errors as a Stream and on the Effect logger.

import {
	type ActivityCounts,
	type Address,
	type ArchivePart,
	type Contract,
	type Ctx,
	createHost,
	type GetOptions,
	type Held,
	type HostDataCounts,
	type HostDeleteOptions,
	type HostError,
	type HostImportOptions,
	type HostKind,
	type HostOptions,
	type KindShape,
	type Link,
	type LinkOptions,
	type LoadReport,
	type ParamsOf,
	type Host as PiHost,
	type PluginFacet,
	type Presence,
	type Principal,
	type Reference,
	type Registry,
	type RegistryValue,
	type ReloadOptions,
	type ReloadReport,
	type RootOptions,
	type RouteHandle,
	type RouteOptions,
} from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import { type Cause, Effect, Option, PubSub, Ref, type Scope, Stream } from "effect";
import { attempt, chordCall, chordSync, currentContext, rejection, storeRejection } from "./call.ts";
import type { ChordCallError } from "./errors.ts";
import { fromIterable, toIterable } from "./iterable.ts";
import { runner } from "./runner.ts";
import type { StoreError } from "./store.ts";
import { values, type WatchError } from "./watch.ts";

// Chord's host types, under this module: Chord's own host is `PiHost`.
export type {
	ActivityCounts,
	CommittedReload,
	Ctx,
	GetOptions,
	Held,
	Host as PiHost,
	HostDeleteOptions,
	HostError,
	HostOptions,
	LinkOptions,
	LoadReport,
	PluginFailure,
	Presence,
	Reference,
	ReloadOptions,
	ReloadReport,
	RootOptions,
	RouteHandle,
	RouteOptions,
} from "@earendil-works/chord";

/** The params of a host kind, as Chord's `hostKind` declares them. */
type Params = NonNullable<KindShape["~params"]>;

/** What `make` takes: Chord's host options; the host's background errors are its `errors` Stream instead of `onError`. */
export type Options<P extends Principal = Principal, R extends JsonValue = JsonValue> = Omit<
	HostOptions<P, R>,
	"onError"
>;

/** How a host reaches hosts of a kind: Chord's route options, `resolve` an Effect. */
export type Route<P extends Principal, K extends KindShape, E, R> = Omit<RouteOptions<P, K>, "resolve"> & {
	/** The link to an address, as Chord's `resolve`: interrupted when the host closes; a failure fails its holders. */
	readonly resolve: (
		address: Parameters<RouteOptions<P, K>["resolve"]>[0],
	) => Effect.Effect<Awaited<ReturnType<RouteOptions<P, K>["resolve"]>>, E, R>;
};

/** A running host: Chord's own (`host`), and its API in Effect terms. */
export interface Host<P extends Principal = Principal, R extends JsonValue = JsonValue> {
	/** Chord's own host, for what takes one (a client's surfaces, `Facet.loadSet`) and what is not wrapped. */
	readonly host: PiHost<P, R>;
	/**
	 * Everything that fails in the background (Chord's `onError`), from the moment the Stream runs. Each is also logged
	 * at the error level on the Effect logger of the context `make` ran in.
	 */
	readonly errors: Stream.Stream<HostError>;
	/** Chord's `load`: runs every facet's setup, publishes what they declared, and waits for the start barrier. */
	readonly load: (facets: readonly PluginFacet<P>[]) => Effect.Effect<LoadReport, ChordCallError>;
	/** Chord's `reload`: `facets` is the complete new plugin set. */
	readonly reload: (
		facets: readonly PluginFacet<P>[],
		options?: ReloadOptions,
	) => Effect.Effect<ReloadReport, ChordCallError>;
	/** Chord's `get`: a reference once its object is live, released when the scope closes. */
	readonly get: <C extends Contract>(
		Type: C,
		params: ParamsOf<C>,
		options?: GetOptions,
	) => Effect.Effect<Reference<C>, ChordCallError, Scope.Scope>;
	/** Chord's `hold`: a reference at once, following its object, released when the scope closes. */
	readonly hold: <C extends Contract>(
		Type: C,
		params: ParamsOf<C>,
		options?: GetOptions,
	) => Effect.Effect<Held<C>, ChordCallError, Scope.Scope>;
	/** Chord's `accept`: a link from a child; the work arriving on it runs under the fiber's `ParentContext`. */
	readonly accept: (link: Link, options: LinkOptions<P>) => Effect.Effect<void, ChordCallError>;
	/** Chord's `connect`: this host's parent link. */
	readonly connect: (link: Link, options: LinkOptions<P>) => Effect.Effect<void, ChordCallError>;
	/** Chord's `route`: how this host reaches hosts of `Kind`, `resolve` run with the services of this Effect. */
	readonly route: <N extends string, Q extends Params, E, RR>(
		Kind: HostKind<N, Q>,
		options: Route<P, HostKind<N, Q>, E, RR>,
	) => Effect.Effect<RouteHandle<HostKind<N, Q>>, ChordCallError, RR>;
	/** Chord's `revoke`: ends the objects and closes the child links of every principal `revocation` revokes. */
	readonly revoke: (revocation: R) => Effect.Effect<void, ChordCallError>;
	/** Chord's `references`: the references to objects of `Type` on this host, as a Stream of the whole list. */
	readonly references: <C extends Contract>(Type: C) => Stream.Stream<readonly Presence<C, P>[], WatchError>;
	/** Chord's `activity`: the work keeping this host busy, for the app's supervisor. */
	readonly activity: Stream.Stream<ActivityCounts, WatchError>;
	/** Chord's `registry`: a registry's composed value, once it is usable. Follow it with `values` of `/watch`. */
	readonly registry: <C, V>(
		R: Registry<C, V>,
		options?: GetOptions,
	) => Effect.Effect<RegistryValue<V>, ChordCallError>;
	/**
	 * Chord's `root`: runs `body` with a call context for code outside objects (a CLI, a Durable tool). The references
	 * `ctx.get` takes are released when `body` ends; `body`'s own failure is the Effect's.
	 */
	readonly root: <A, E, RR>(
		body: (ctx: Ctx<P>) => Effect.Effect<A, E, RR>,
		options?: RootOptions<P>,
	) => Effect.Effect<A, E | ChordCallError, RR>;
	/** Chord's `exportHostData`: the records and rows of `address` in this host's store, as archive parts. */
	readonly exportHostData: (address: Address) => Stream.Stream<ArchivePart, StoreError>;
	/** Chord's `importHostData`: a host's data archive imported into this host's store in one commit. */
	readonly importHostData: <E, RR>(
		parts: Stream.Stream<unknown, E, RR>,
		options?: HostImportOptions,
	) => Effect.Effect<HostDataCounts, StoreError | E, RR>;
	/** Chord's `deleteHostData`: deletes the records and rows of `address` in one commit. */
	readonly deleteHostData: (
		address: Address,
		options?: HostDeleteOptions,
	) => Effect.Effect<HostDataCounts, StoreError>;
}

/**
 * Chord's `createHost`: a host for the life of the scope, closed when the scope closes (its links, root scopes and
 * objects, the last to go live first). Its store, when given, is the app's: close it after the host (open it in an
 * outer scope). Untraced, as every call of this module: Chord records its own spans under the fiber's span, and what
 * a host keeps (its error log, its links' work) outlives a span of this Effect.
 */
export const make: <P extends Principal = Principal, R extends JsonValue = JsonValue>(
	options: Options<P, R>,
) => Effect.Effect<Host<P, R>, never, Scope.Scope> = Effect.fnUntraced(function* <
	P extends Principal,
	R extends JsonValue,
>(options: Options<P, R>) {
	const services = yield* Effect.context<never>();
	// Logging is synchronous: Chord's `onError` logs in place, no fiber outlives the call.
	const log = Effect.runSyncWith(services);
	const errors = yield* Effect.acquireRelease(PubSub.unbounded<HostError>(), PubSub.shutdown);
	const host = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createHost<P, R>({
				...options,
				onError: (error) => {
					PubSub.publishUnsafe(errors, error);
					log(Effect.logError("Chord host error", error));
				},
			}),
		),
		// Chord rejects with an `AggregateError` of the closes that threw; a finalizer has nothing left to recover.
		(opened) => Effect.ignoreCause(attempt((context) => opened.close(context), Effect.die)),
	);
	return of(host, Stream.fromPubSub(errors));
});

/**
 * The Effect API of a host Chord made itself (a client's, an app server's), whose background errors are `errors`. The
 * host stays its maker's to close.
 */
export function of<P extends Principal, R extends JsonValue>(
	host: PiHost<P, R>,
	errors: Stream.Stream<HostError>,
): Host<P, R> {
	return {
		host,
		errors,
		load: (facets) => chordCall((context) => host.load(facets, context)),
		reload: (facets, options) => chordCall((context) => host.reload(facets, context, options)),
		get: (Type, params, options) =>
			Effect.acquireRelease(
				chordCall((context) => host.get(Type, params, context, options)),
				(reference) => Effect.sync(() => reference.release()),
			),
		hold: (Type, params, options) =>
			Effect.acquireRelease(
				Effect.flatMap(currentContext, (context) => chordSync(() => host.hold(Type, params, context, options))),
				(held) => Effect.sync(() => held.release()),
			),
		accept: (link, options) =>
			Effect.flatMap(currentContext, (context) => chordSync(() => host.accept(link, options, context))),
		connect: (link, options) =>
			Effect.flatMap(currentContext, (context) => chordSync(() => host.connect(link, options, context))),
		route: Effect.fnUntraced(function* <N extends string, Q extends Params, E, RR>(
			Kind: HostKind<N, Q>,
			options: Route<P, HostKind<N, Q>, E, RR>,
		) {
			const services = yield* Effect.context<RR>();
			const run = runner(services);
			const context = yield* currentContext;
			return yield* chordSync(() =>
				host.route(
					Kind,
					{ ...options, resolve: (address, routeContext) => run(options.resolve(address), routeContext) },
					context,
				),
			);
		}),
		revoke: (revocation) =>
			Effect.flatMap(currentContext, (context) => chordSync(() => host.revoke(revocation, context))),
		references: (Type) => values(host.references(Type)),
		activity: values(host.activity),
		registry: (R, options) => chordCall((context) => host.registry(R, context, options)),
		root: Effect.fnUntraced(function* <A, E, RR>(
			body: (ctx: Ctx<P>) => Effect.Effect<A, E, RR>,
			options?: RootOptions<P>,
		) {
			const services = yield* Effect.context<RR>();
			const run = runner(services);
			// `body`'s own failure, kept apart from what Chord rejects with (a closed host, an aborted context). Chord
			// marks the root's span failed for the rejection `run` gives it.
			const failed = yield* Ref.make(Option.none<Cause.Cause<E>>());
			const recorded = (ctx: Ctx<P>) => Effect.onError(body(ctx), (cause) => Ref.set(failed, Option.some(cause)));
			return yield* attempt(
				(context) => host.root((ctx) => run(recorded(ctx), ctx), context, options),
				(thrown) =>
					Effect.flatMap(
						Ref.get(failed),
						Option.match({
							onNone: (): Effect.Effect<never, E | ChordCallError> => rejection(thrown),
							onSome: Effect.failCause,
						}),
					),
			);
		}),
		exportHostData: (address) => fromIterable((context) => host.exportHostData(address, context), storeRejection),
		importHostData: <E, RR>(parts: Stream.Stream<unknown, E, RR>, options?: HostImportOptions) =>
			Effect.flatMap(toIterable(parts), (input) =>
				attempt((context) => host.importHostData(input.iterable, context, options), input.rejected(storeRejection)),
			),
		deleteHostData: (address, options) =>
			attempt((context) => host.deleteHostData(address, context, options), storeRejection),
	};
}
