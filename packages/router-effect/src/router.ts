// The router as a service: resolution and requests by alias in Effect terms, and the Layer that builds it.

import {
	type AssistantMessage,
	type ModelId,
	Models,
	type ModelsSimpleStreamOptions,
	type Context as PiContext,
	type Provider,
	ProviderId,
	type RequestOptions,
	type ResponseEvent,
	requestKey,
	SessionId,
} from "@effectified/pi-ai";
import { Array as Arr, Clock, Context, Effect, Layer, Option, Queue, Random, Record, Schema, Stream } from "effect";
import { AttemptSettlement } from "./attempt-settlement.ts";
import { type RoutedRequest, serve } from "./attempts.ts";
import { ConstraintSource, imposedBy } from "./constraint-source.ts";
import { type Constraints, constraintsFromMetadata, METADATA_KEY } from "./constraints.ts";
import type { InvalidConstraints, NoRouteAvailable, RouterError, RouteTableError, UnknownAlias } from "./errors.ts";
import { DEFAULT_ROUTER_ID, RouterRequestId } from "./ids.ts";
import { Limiter } from "./limiter.ts";
import * as PiProvider from "./provider.ts";
import { resolveRoutes } from "./resolve.ts";
import { RouteEvents } from "./route-events.ts";
import { type Route, type RouteTable, validateRouteTable } from "./route-table.ts";

/** What a router is built with, besides its table. */
export const RouterOptions = Schema.Struct({
	/** The id of the router's provider in `Models`: the `provider` of an alias model. Default: `"router"`. */
	id: Schema.optionalKey(ProviderId),
	/** Display name of the provider. Default: `id`. */
	name: Schema.optionalKey(Schema.String),
});

/** What a router is built with, besides its table. */
export type RouterOptions = typeof RouterOptions.Type;

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
	readonly id: ProviderId;
	/** The router as a pi-ai provider. The Layer has already put it in `Models`. */
	readonly provider: Provider;
	/** The table the router was built from, decoded. */
	readonly table: RouteTable;
	/**
	 * The routes of `alias` that may serve a request with `constraints`, in the order they are tried. It asks no
	 * `ConstraintSource`: there is no request to ask about.
	 */
	readonly resolve: (
		alias: ModelId,
		constraints?: Constraints,
	) => Effect.Effect<Arr.NonEmptyReadonlyArray<Route>, UnknownAlias | InvalidConstraints | NoRouteAvailable>;
	/**
	 * Streams one response of `alias`: pi-ai's events up to `done`, from the first route that answers. Fails with
	 * the typed reason no route served. Ending the Stream early, or interrupting its consumer, aborts the provider
	 * request.
	 */
	readonly stream: (
		alias: ModelId,
		context: PiContext,
		options?: RouterRequestOptions,
	) => Stream.Stream<ResponseEvent, RouterError>;
	/** The final message of one response of `alias`, with the error and interruption rules of `stream`. */
	readonly complete: (
		alias: ModelId,
		context: PiContext,
		options?: RouterRequestOptions,
	) => Effect.Effect<AssistantMessage, RouterError>;
}

/** Model routing over the providers in `Models`: aliases, fallback, limits, prices and a record of every attempt. */
export class Router extends Context.Service<Router, RouterService>()("@effectified/pi-router/router") {
	/**
	 * Validates `table` against `Models`, then puts the router's provider into `Models` until the scope closes, so
	 * `{ provider: id, modelId: alias }` names a model anything on `Models` can call. `table` is one written in code
	 * or stored (`typeof RouteTable.Encoded`), or a decoded one. Fails with `RouteTableError` when the table cannot be
	 * used. Also provides `RouteEvents`, where every attempt is published. It takes the `ConstraintSource` and the
	 * `AttemptSettlement` of the context it is built in: provide the product's under this Layer.
	 */
	static layer(
		table: typeof RouteTable.Encoded,
		options?: RouterOptions,
	): Layer.Layer<Router | RouteEvents, RouteTableError, Models> {
		return Layer.provideMerge(Layer.effect(Router, make(table, options)), RouteEvents.layer);
	}
}

/** Builds one router: validates the table, makes its limiter, and registers its provider for the scope. */
const make = Effect.fn("Router.make")(function* (input: typeof RouteTable.Encoded, options: RouterOptions | undefined) {
	const id = options?.id ?? DEFAULT_ROUTER_ID;
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
	const run = Effect.fn("Router.request")(function* (
		alias: ModelId,
		context: PiContext,
		given: Effect.Effect<Option.Option<Constraints>, InvalidConstraints>,
		requestOptions: GivenOptions | undefined,
		emit: RoutedRequest["emit"],
	) {
		const constraints = yield* given;
		const { metadata } = requestOptions ?? {};
		// pi-ai's session id is a plain string: branded where it enters the router.
		const sessionId = requestOptions?.sessionId === undefined ? undefined : SessionId.make(requestOptions.sessionId);
		const imposed = yield* imposedBy(source, { alias, sessionId, metadata });
		const routes = yield* resolveRoutes(table, alias, Option.getOrUndefined(constraints), imposed);
		requests += 1;
		const options = forwarded(requestOptions);
		const key = sessionId === undefined ? undefined : yield* requestKey(sessionId, context);
		const requestId = RouterRequestId.make(`${instance}-${requests}`);
		const routed = { request: requests, id: requestId, key, alias, routes, context, options, emit };
		// The attempts read the settlement of their fiber, and a request runs in its caller's: the one this router was
		// built with is put there, so `Router.complete` and a pi-ai request settle through the same port.
		return yield* Effect.provideService(serve(services, routed), AttemptSettlement, settlement);
	});
	// A request that comes through pi-ai says its constraints in its metadata only.
	const fromPi: PiProvider.ProviderOptions["run"] = (alias, transcript, requestOptions, emit) =>
		run(alias, transcript, constraintsFromMetadata(alias, requestOptions?.metadata), requestOptions, emit);
	const direct = (
		alias: ModelId,
		context: PiContext,
		requestOptions: RouterRequestOptions | undefined,
		emit: RoutedRequest["emit"],
	) =>
		run(
			alias,
			context,
			requestOptions?.constraints === undefined
				? constraintsFromMetadata(alias, requestOptions?.metadata)
				: Effect.succeedSome(requestOptions.constraints),
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

/** The options a request comes with: pi-ai's, and the router's own `constraints` when it came through `Router`. */
type GivenOptions = ModelsSimpleStreamOptions & { readonly constraints?: Constraints };

/**
 * What follows a request to the route that serves it, per option of pi-ai's requests. The fiber owns cancellation
 * (`signal`). An `apiKey`, and `env`, from which pi-ai resolves a provider's credentials, would be one provider's
 * given to whichever route serves: each route's provider has its own in `Models`. A deferred response comes back with
 * a handle only the route's provider can fetch, so `deferred` is dropped and the response arrives in the request.
 * `metadata` follows without the router's key. The rest is about the request, not about one provider, and follows
 * it: `headers` too, the caller's own HTTP headers (a trace id), which pi-ai merges over each route's. An option
 * pi-ai adds fails to compile here until it is decided.
 */
const FORWARD = {
	signal: "drop",
	apiKey: "drop",
	env: "drop",
	deferred: "drop",
	metadata: "forward",
	headers: "forward",
	transformHeaders: "forward",
	identity: "forward",
	fetch: "forward",
	telemetry: "forward",
	onPayload: "forward",
	onResponse: "forward",
	onProviderStreamEvent: "forward",
	timeoutMs: "forward",
	maxRetries: "forward",
	maxRetryDelayMs: "forward",
	transport: "forward",
	websocketConnectTimeoutMs: "forward",
	sessionId: "forward",
	disableContinuation: "forward",
	cacheRetention: "forward",
	temperature: "forward",
	samplingParams: "forward",
	maxTokens: "forward",
	toolChoice: "forward",
	reasoning: "forward",
	thinkingBudgets: "forward",
} as const satisfies Record<keyof ModelsSimpleStreamOptions, "forward" | "drop">;

/** pi-ai's options that follow a request to its route. */
type Forwarded = {
	[K in keyof typeof FORWARD]: (typeof FORWARD)[K] extends "forward" ? K : never;
}[keyof typeof FORWARD];

function isForwarded(option: keyof typeof FORWARD): option is Forwarded {
	return FORWARD[option] === "forward";
}

/** The names of the options `FORWARD` forwards. */
const FORWARDED: ReadonlyArray<Forwarded> = Arr.filter(Record.keys(FORWARD), isForwarded);

/**
 * What goes on to the provider of a route: the caller's options that `FORWARD` forwards, with `metadata` without the
 * router's own key. An option no pi-ai type names (a value that is not of this version's options) is not passed on,
 * and neither is one the caller set to `undefined`.
 */
function forwarded(options: GivenOptions | undefined): RoutedRequest["options"] {
	const kept: Pick<ModelsSimpleStreamOptions, Forwarded> = {};
	if (options === undefined) return kept;
	for (const option of FORWARDED) if (options[option] !== undefined) copy(kept, options, option);
	if (options.metadata === undefined) return kept;
	// The constraints are for the router: a provider gets the rest of the caller's metadata.
	const { [METADATA_KEY]: _own, ...others } = options.metadata;
	return { ...kept, metadata: others };
}

function copy<K extends Forwarded>(
	to: Pick<ModelsSimpleStreamOptions, Forwarded>,
	from: GivenOptions,
	option: K,
): void {
	to[option] = from[option];
}
