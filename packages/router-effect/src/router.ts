// The router as a service: resolution and requests by alias in Effect terms, and the Layer that builds it.

import type {
	AssistantMessage,
	ModelsSimpleStreamOptions,
	Context as PiContext,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Models, type RequestOptions, type ResponseEvent } from "@gunta/pi-ai-effect";
import { Clock, Context, Effect, Layer, Queue, Random, Stream } from "effect";
import { AttemptSettlement } from "./attempt-settlement.ts";
import { type RoutedRequest, serve } from "./attempts.ts";
import { ConstraintSource, imposedBy } from "./constraint-source.ts";
import { type Constraints, constraintsFromMetadata, METADATA_KEY } from "./constraints.ts";
import type { InvalidConstraints, NoRouteAvailable, RouterError, RouteTableError, UnknownAlias } from "./errors.ts";
import { Limiter } from "./limiter.ts";
import * as PiProvider from "./provider.ts";
import { resolveRoutes } from "./resolve.ts";
import { RouteEvents } from "./route-events.ts";
import { type Route, type RouteTable, validateRouteTable } from "./route-table.ts";

/** What a router is built with, besides its table. */
export interface RouterOptions {
	/** The id of the router's provider in `Models`: the `provider` of an alias model. Default: `"router"`. */
	readonly id?: string;
	/** Display name of the provider. Default: `id`. */
	readonly name?: string;
}

/**
 * The options of a request to an alias: pi-ai's provider-neutral options, and the request's constraints. Without
 * `constraints` they are read from `metadata`, as for a request that comes through pi-ai.
 */
export type RouterRequestOptions = RequestOptions<ModelsSimpleStreamOptions> & {
	readonly constraints?: Constraints;
};

/** One router: a validated route table, its limiter, and its provider in `Models`. */
export interface RouterService {
	/** The id of the router's provider in `Models`. */
	readonly id: string;
	/** The router as a pi-ai provider. The Layer has already put it in `Models`. */
	readonly provider: Provider;
	/** The table the router was built from. */
	readonly table: RouteTable;
	/**
	 * The routes of `alias` that may serve a request with `constraints`, in the order they are tried. It asks no
	 * `ConstraintSource`: there is no request to ask about.
	 */
	readonly resolve: (
		alias: string,
		constraints?: Constraints,
	) => Effect.Effect<readonly [Route, ...Route[]], UnknownAlias | InvalidConstraints | NoRouteAvailable>;
	/**
	 * Streams one response of `alias`: pi-ai's events up to `done`, from the first route that answers. Fails with
	 * the typed reason no route served. Ending the Stream early, or interrupting its consumer, aborts the provider
	 * request.
	 */
	readonly stream: (
		alias: string,
		context: PiContext,
		options?: RouterRequestOptions,
	) => Stream.Stream<ResponseEvent, RouterError>;
	/** The final message of one response of `alias`, with the error and interruption rules of `stream`. */
	readonly complete: (
		alias: string,
		context: PiContext,
		options?: RouterRequestOptions,
	) => Effect.Effect<AssistantMessage, RouterError>;
}

/** Model routing over the providers in `Models`: aliases, fallback, limits, prices and a record of every attempt. */
export class Router extends Context.Service<Router, RouterService>()("@gunta/pi-router-effect/Router") {
	/**
	 * Validates `table` against `Models`, then puts the router's provider into `Models` until the scope closes, so
	 * `{ provider: id, modelId: alias }` names a model anything on `Models` can call. Fails with `RouteTableError`
	 * when the table cannot be used. Also provides `RouteEvents`, where every attempt is published. It takes the
	 * `ConstraintSource` and the `AttemptSettlement` of the context it is built in: provide the product's under this
	 * Layer.
	 */
	static layer(
		table: RouteTable,
		options?: RouterOptions,
	): Layer.Layer<Router | RouteEvents, RouteTableError, Models> {
		return Layer.provideMerge(Layer.effect(Router, make(table, options)), RouteEvents.layer);
	}
}

/** Builds one router: validates the table, makes its limiter, and registers its provider for the scope. */
const make = Effect.fnUntraced(function* (input: RouteTable, options: RouterOptions | undefined) {
	const id = options?.id ?? "router";
	const valid = yield* validateRouteTable(input);
	const { table } = valid;
	const models = yield* Models;
	const limiter = yield* Limiter.make({ limits: table.limits, backoff: table.backoff });
	const services = { router: id, models, limiter, events: yield* RouteEvents };
	const source = yield* ConstraintSource;
	const settlement = yield* AttemptSettlement;
	// What makes a request id of this router differ from every other router's, in this process or a later one: when
	// it was built, and a number of Effect's `Random`.
	const builtAt = yield* Clock.currentTimeMillis;
	const nonce = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
	const instance = `${builtAt.toString(36)}${nonce.toString(36)}`;
	let requests = 0;
	const run = Effect.fnUntraced(function* (
		alias: string,
		context: PiContext,
		given: Effect.Effect<Constraints | undefined, InvalidConstraints>,
		requestOptions: (SimpleStreamOptions & { readonly constraints?: Constraints }) | undefined,
		emit: RoutedRequest["emit"],
	) {
		const constraints = yield* given;
		const { sessionId, metadata } = requestOptions ?? {};
		const routes = yield* resolveRoutes(
			table,
			alias,
			constraints,
			yield* imposedBy(source, { alias, sessionId, metadata }),
		);
		requests += 1;
		const options = forwarded(requestOptions);
		const routed = { request: requests, id: `${instance}-${requests}`, alias, routes, context, options, emit };
		// The attempts read the settlement of their fiber, and a request runs in its caller's: the one this router was
		// built with is put there, so `Router.complete` and a pi-ai request settle through the same port.
		return yield* Effect.provideService(serve(services, routed), AttemptSettlement, settlement);
	});
	// A request that comes through pi-ai says its constraints in its metadata only.
	const fromPi: PiProvider.ProviderOptions["run"] = (alias, transcript, requestOptions, emit) =>
		run(alias, transcript, constraintsFromMetadata(alias, requestOptions?.metadata), requestOptions, emit);
	const direct = (
		alias: string,
		context: PiContext,
		requestOptions: RouterRequestOptions | undefined,
		emit: RoutedRequest["emit"],
	) =>
		run(
			alias,
			context,
			requestOptions?.constraints === undefined
				? constraintsFromMetadata(alias, requestOptions?.metadata)
				: Effect.succeed(requestOptions.constraints),
			requestOptions,
			emit,
		);
	const provider = yield* PiProvider.make({ id, name: options?.name, table: valid, run: fromPi });
	yield* Effect.acquireRelease(
		Effect.sync(() => models.setProvider(provider)),
		() =>
			Effect.sync(() => {
				// Another provider may have taken the id since; that one is not ours to remove.
				if (models.getProvider(id) === provider) models.deleteProvider(id);
			}),
	);
	return Router.of({
		id,
		provider,
		table,
		resolve: (alias, constraints) => resolveRoutes(table, alias, constraints),
		stream: (alias, context, requestOptions) =>
			Stream.callback<ResponseEvent, RouterError>(
				(queue) =>
					Effect.andThen(
						direct(alias, context, requestOptions, (event) => Effect.asVoid(Queue.offer(queue, event))),
						Queue.end(queue),
					),
				// One event ahead of the consumer at most: a response is read from its provider as fast as it is
				// consumed, so ending the Stream early stops a request that is still running.
				{ bufferSize: 1, strategy: "suspend" },
			),
		complete: (alias, context, requestOptions) => direct(alias, context, requestOptions, () => Effect.void),
	});
});

/**
 * What goes on to the provider of a route: the caller's options without the ones that are the router's own or that
 * cannot follow a request to another provider. The fiber owns cancellation (`signal`). An `apiKey` would be the key
 * of one provider sent to whichever route serves. A deferred response comes back with a handle only the route's
 * provider can fetch, so `deferred` is dropped and the response arrives in the request.
 */
function forwarded(
	options: (SimpleStreamOptions & { readonly constraints?: Constraints }) | undefined,
): RoutedRequest["options"] {
	const {
		signal: _signal,
		apiKey: _apiKey,
		deferred: _deferred,
		constraints: _constraints,
		metadata,
		...rest
	} = options ?? {};
	if (metadata === undefined) return rest;
	// The constraints are for the router: a provider gets the rest of the caller's metadata.
	const { [METADATA_KEY]: _own, ...others } = metadata;
	return { ...rest, metadata: others };
}
