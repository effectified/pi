// One request to an alias: its routes tried in order, each attempt limited, classified, priced and recorded.

import {
	type Api,
	type AssistantMessage,
	appendAssistantMessageDiagnostic,
	type Model,
	type ModelsSimpleStreamOptions,
	type MutableModels,
	type Context as PiContext,
	type ProviderResponse,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	emptyUsage,
	type ModelRequestError,
	Models,
	type RequestOptions,
	type ResponseEvent,
	streamSimple,
} from "@gunta/pi-ai-effect";
import { Clock, Effect, Result, Stream } from "effect";
import { AttemptSettlement, settledBy } from "./attempt-settlement.ts";
import { classify } from "./classify.ts";
import { type AttemptUnsettled, type RouteFailure, RoutesExhausted } from "./errors.ts";
import type { LimiterService } from "./limiter.ts";
import { priced, tokensOf } from "./price.ts";
import type { RouteEvent, RouteEventsService } from "./route-events.ts";
import type { Route } from "./route-table.ts";

/** What the attempts of a router work with. */
export interface AttemptServices {
	/** The id of the router's provider, for its events. */
	readonly router: string;
	/** Where the routes' providers and their credentials are. */
	readonly models: MutableModels;
	readonly limiter: LimiterService;
	readonly events: RouteEventsService;
}

/** One request to an alias, after resolution. */
export interface RoutedRequest {
	/** The number of this request in its router's events. */
	readonly request: number;
	/** The id of this request in its router's events: of this request and of no other, ever. */
	readonly id: string;
	/** The key of what it asks (`requestKey`); none without a provider session. */
	readonly key: string | undefined;
	readonly alias: string;
	/** The routes that may serve the request, in the order they are tried. */
	readonly routes: readonly [Route, ...Route[]];
	readonly context: PiContext;
	/** What goes on to the provider of each route: pi-ai's provider-neutral options. */
	readonly options: RequestOptions<ModelsSimpleStreamOptions>;
	/** Takes each event of the response the caller sees, in pi-ai's order, up to and including `done`. */
	readonly emit: (event: ResponseEvent) => Effect.Effect<void>;
}

/**
 * Serves `request` on the first of its routes that answers, and returns the final message.
 *
 * The next route is tried only when a route's provider or model is unavailable, or when its response failed with an
 * error pi-ai calls retryable (`classify`) before any of it had reached the caller. Any other failure ends the
 * request with that route's `ModelRequestError`: an error that is not retryable, an abort by the provider, and every
 * failure after output started. When no route is left the request fails with `RoutesExhausted`. Every attempt is
 * published as a route event before its outcome reaches the caller. Interrupting the fiber aborts the provider
 * request and records the attempt as aborted.
 *
 * Before the next route is tried, the `AttemptSettlement` of the fiber's context settles the attempt it takes over,
 * when that attempt cost something (`takenOver`). A settlement that fails ends the request with `AttemptUnsettled`.
 *
 * The message a request ends with, served or failed, carries the usage of the request's last attempt and of no
 * earlier one. So whatever wraps the router (a budget) is told the last attempt by the response. Every attempt before
 * it is told by its route event, which has `fallback: true`, and by the settlement when it cost something.
 */
export const serve = Effect.fnUntraced(function* (
	services: AttemptServices,
	request: RoutedRequest,
): Effect.fn.Return<AssistantMessage, ModelRequestError | RoutesExhausted | AttemptUnsettled> {
	const failures: RouteFailure[] = [];
	let response: AssistantMessage | undefined;
	for (const [index, route] of request.routes.entries()) {
		const outcome = yield* attempt(services, request, route, index + 1, failures);
		switch (outcome._tag) {
			case "Served":
				return outcome.message;
			case "Ended":
				return yield* Effect.fail(outcome.error);
			case "Next":
				failures.push({ provider: route.provider, model: route.model, message: outcome.message });
				// A route that was unavailable used nothing, and the response kept from before it must not repeat the
				// usage its own route event already told.
				response = outcome.response ?? (response === undefined ? undefined : { ...response, usage: emptyUsage() });
		}
	}
	return yield* Effect.fail(
		new RoutesExhausted({
			alias: request.alias,
			// There is at least one route, and every route that did not end the request added a failure.
			failures: failures as [RouteFailure, ...RouteFailure[]],
			response,
		}),
	);
});

/** How one attempt ended, for the loop over the routes. */
type AttemptOutcome =
	| { readonly _tag: "Served"; readonly message: AssistantMessage }
	/** The request fails with this error: no other route is tried. */
	| { readonly _tag: "Ended"; readonly error: ModelRequestError | AttemptUnsettled }
	/** The route did not serve and the next one may; `response` is absent when nothing was sent. */
	| { readonly _tag: "Next"; readonly message: string; readonly response: AssistantMessage | undefined };

/** pi-ai's last event of a response that did not fail. */
type DoneEvent = Extract<ResponseEvent, { type: "done" }>;

/** What an attempt knows while it runs. Mutated in place, so the interruption handler sees the latest state. */
interface Progress {
	/** Clock time when the request went to the provider; undefined while waiting for the limiter. */
	sentAt: number | undefined;
	/** The response so far, as the provider's latest event carried it. */
	partial: AssistantMessage | undefined;
	/** The HTTP response the provider's adapter reported, when it reported one. */
	answer: ProviderResponse | undefined;
	/** pi-ai's `start` event, held back until the route proves it has output: a second `start` cannot be undone. */
	held: ResponseEvent | undefined;
	/** True once an event of this route reached the caller: from then on no other route may serve. */
	outputStarted: boolean;
	/** True once the attempt's route event is published, or will be before anything can interrupt the attempt. */
	recorded: boolean;
}

/** One attempt: a request on one of its routes. */
interface Attempt {
	readonly services: AttemptServices;
	readonly request: RoutedRequest;
	readonly route: Route;
	/** The position of the attempt in its request, from 1. */
	readonly number: number;
	/** The routes that failed before this one. */
	readonly failed: ReadonlyArray<RouteFailure>;
	/** Clock time when the attempt began. */
	readonly startedAt: number;
	readonly progress: Progress;
}

/** Runs attempt `number` of `request` on `route`. An interruption records the attempt as aborted. */
function attempt(
	services: AttemptServices,
	request: RoutedRequest,
	route: Route,
	number: number,
	failed: ReadonlyArray<RouteFailure>,
): Effect.Effect<AttemptOutcome> {
	return Effect.flatMap(Clock.currentTimeMillis, (startedAt) => {
		const progress: Progress = {
			sentAt: undefined,
			partial: undefined,
			answer: undefined,
			held: undefined,
			outputStarted: false,
			recorded: false,
		};
		const self: Attempt = { services, request, route, number, failed, startedAt, progress };
		return Effect.onInterrupt(run(self), () =>
			progress.recorded
				? Effect.void
				: record(self, "aborted", false, "Request was aborted", progress.partial?.usage),
		);
	});
}

/** Checks that the route can be sent a request, then sends it in a slot of the route's concurrency key. */
const run = Effect.fnUntraced(function* (self: Attempt): Effect.fn.Return<AttemptOutcome> {
	const { services, request, route } = self;
	const ready = yield* availability(services.models, route);
	if (ready._tag === "Unavailable") {
		yield* record(self, "unavailable", self.number < request.routes.length, ready.message, undefined);
		return { _tag: "Next", message: ready.message, response: undefined };
	}
	return yield* services.limiter.withPermit(route.concurrencyKey, send(self, ready.model));
});

/**
 * Sends the request to the route's model and ends the attempt with what came back. From a failure of the provider to
 * the record of the attempt nothing can interrupt it: a caller that gives up at that moment must not turn an attempt
 * that failed, and was billed, into one recorded as aborted and settled by nobody.
 */
const send = Effect.fnUntraced(function* (self: Attempt, model: Model<Api>): Effect.fn.Return<AttemptOutcome> {
	self.progress.sentAt = yield* Clock.currentTimeMillis;
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.flatMap(
			Effect.result(restore(forward(self.services.models, self.request, model, self.progress))),
			(result) => (Result.isSuccess(result) ? restore(served(self, result.success)) : failed(self, result.failure)),
		),
	);
});

/** The route answered: its key recovers, the attempt is recorded, and the caller gets the end of the response. */
const served = Effect.fnUntraced(function* (self: Attempt, done: DoneEvent): Effect.fn.Return<AttemptOutcome> {
	const { services, request, progress } = self;
	yield* services.limiter.recover(self.route.concurrencyKey);
	if (self.failed.length > 0) {
		// The message keeps the provider and model of the route that served it. That it was not the first route is a
		// recovery, which is what pi-ai's diagnostics are for.
		appendAssistantMessageDiagnostic(done.message, {
			type: "route_fallback",
			timestamp: yield* Clock.currentTimeMillis,
			details: {
				router: services.router,
				alias: request.alias,
				attempt: self.number,
				failed: self.failed.map(({ provider, model }) => ({ provider, model })),
			},
		});
	}
	yield* record(self, "served", false, undefined, done.message.usage);
	if (progress.held !== undefined) yield* request.emit(progress.held);
	yield* request.emit(done);
	return { _tag: "Served", message: done.message };
});

/** The route failed: its key backs off after a rate limit, and the failure decides whether the next route may try. */
const failed = Effect.fnUntraced(function* (self: Attempt, error: ModelRequestError): Effect.fn.Return<AttemptOutcome> {
	const kind = classify(error.response, self.progress.answer, yield* Clock.currentTimeMillis);
	// The key backs off whether or not another route takes the request over.
	if (kind._tag === "RateLimited") {
		yield* self.services.limiter.backOff(self.route.concurrencyKey, kind.retryAfterMillis);
	}
	const next = kind._tag !== "Final" && !self.progress.outputStarted;
	const outcome = error.reason === "aborted" ? "aborted" : "failed";
	if (next && self.number < self.request.routes.length) return yield* takenOver(self, outcome, error);
	yield* record(self, outcome, false, error.message, error.response.usage);
	return next ? { _tag: "Next", message: error.message, response: error.response } : { _tag: "Ended", error };
});

/**
 * Ends an attempt the next route is about to take over. When it cost something, the product's `AttemptSettlement`
 * settles it first. A settlement that fails makes it the request's last attempt: it is recorded with
 * `fallback: false`, and the request ends with `AttemptUnsettled`, whose response has the attempt's usage. So an
 * attempt's usage is told once, by the port or by the message its request ends with, never by both and never by
 * neither. Uninterruptible from the port to the record.
 */
const takenOver = Effect.fnUntraced(function* (
	self: Attempt,
	outcome: RouteEvent["outcome"],
	error: ModelRequestError,
): Effect.fn.Return<AttemptOutcome> {
	self.progress.recorded = true;
	const event = yield* eventOf(self, outcome, true, error.message, error.response.usage);
	// An attempt that cost nothing has nothing to settle: most refused requests report no usage at all.
	if (event.cost.micros > 0n) {
		const settled = yield* Effect.result(settledBy(yield* AttemptSettlement, event, error.response));
		if (Result.isFailure(settled)) {
			yield* self.services.events.publish({ ...event, fallback: false });
			return { _tag: "Ended", error: settled.failure };
		}
	}
	yield* self.services.events.publish(event);
	return { _tag: "Next", message: error.message, response: error.response };
}, Effect.uninterruptible);

/**
 * Publishes the route event of an attempt. Uninterruptible: an attempt is recorded exactly once, also when the caller
 * gives up while it is written.
 */
function record(
	self: Attempt,
	outcome: RouteEvent["outcome"],
	fallback: boolean,
	errorMessage: string | undefined,
	reported: Usage | undefined,
): Effect.Effect<void> {
	return Effect.uninterruptible(
		Effect.suspend(() => {
			self.progress.recorded = true;
			return Effect.flatMap(eventOf(self, outcome, fallback, errorMessage, reported), self.services.events.publish);
		}),
	);
}

/**
 * The route event of an attempt that ends now, with `reported` at the route's price. It cannot fail, whatever counts
 * a provider reported (`priced`).
 */
const eventOf = Effect.fnUntraced(function* (
	self: Attempt,
	outcome: RouteEvent["outcome"],
	fallback: boolean,
	errorMessage: string | undefined,
	reported: Usage | undefined,
): Effect.fn.Return<RouteEvent> {
	const { services, request, route, progress } = self;
	const now = yield* Clock.currentTimeMillis;
	const usage = tokensOf(reported);
	return {
		router: services.router,
		request: request.request,
		requestId: request.id,
		...(request.options.sessionId === undefined ? {} : { sessionId: request.options.sessionId }),
		...(request.key === undefined ? {} : { requestKey: request.key }),
		alias: request.alias,
		route,
		attempt: self.number,
		outcome,
		fallback,
		...(errorMessage === undefined ? {} : { errorMessage }),
		usage,
		cost: priced(route.price, usage),
		startedAt: self.startedAt,
		waitedMillis: (progress.sentAt ?? now) - self.startedAt,
		durationMillis: progress.sentAt === undefined ? 0 : now - progress.sentAt,
	};
});

/** Whether a route can be sent a request now. */
type Availability =
	| { readonly _tag: "Ready"; readonly model: Model<Api> }
	| { readonly _tag: "Unavailable"; readonly message: string };

/**
 * Looks the route's model up in `Models` and asks pi-ai whether its provider has credentials (`checkAuth`). The
 * table was validated when the router was built, but providers and credentials can change while it runs.
 */
function availability(models: MutableModels, route: Route): Effect.Effect<Availability> {
	const unavailable = (message: string): Availability => ({ _tag: "Unavailable", message });
	return Effect.suspend(() => {
		if (models.getProvider(route.provider) === undefined) {
			return Effect.succeed(unavailable(`Provider "${route.provider}" is not registered`));
		}
		const model = models.getModel(route.provider, route.model);
		if (model === undefined) {
			return Effect.succeed(
				unavailable(`Provider "${route.provider}" does not list the chat model "${route.model}"`),
			);
		}
		return Effect.match(
			Effect.tryPromise({
				try: (signal) => models.checkAuth(route.provider, { signal }),
				// pi-ai rejects with an Error when the credential store or the key's own check fails.
				catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
			}),
			{
				onFailure: (reason) =>
					unavailable(`The credentials of provider "${route.provider}" cannot be read: ${reason}`),
				onSuccess: (auth): Availability =>
					auth === undefined
						? unavailable(`Provider "${route.provider}" is not configured`)
						: { _tag: "Ready", model },
			},
		);
	});
}

/**
 * Sends the request to `model` and passes the response on to the caller, except its `done` event, which is
 * returned: the attempt is recorded before the caller sees that it ended.
 */
function forward(
	models: MutableModels,
	request: RoutedRequest,
	model: Model<Api>,
	progress: Progress,
): Effect.Effect<DoneEvent, ModelRequestError> {
	let done: DoneEvent | undefined;
	const options: RoutedRequest["options"] = {
		...request.options,
		onResponse: (answer, answering) => {
			progress.answer = answer;
			return request.options.onResponse?.(answer, answering);
		},
	};
	return streamSimple(model, request.context, options).pipe(
		Stream.runForEach((event) => {
			if (event.type === "done") {
				progress.partial = event.message;
				done = event;
				return Effect.void;
			}
			progress.partial = event.partial;
			if (event.type === "start") {
				progress.held = event;
				return Effect.void;
			}
			const held = progress.held;
			progress.held = undefined;
			progress.outputStarted = true;
			return held === undefined ? request.emit(event) : Effect.andThen(request.emit(held), request.emit(event));
		}),
		Effect.provideService(Models, models),
		Effect.flatMap(() =>
			done === undefined
				? // pi-ai's protocol ends every response in `done` or `error`; anything else is a broken provider.
					Effect.die(new Error("pi-ai ended a response without a done or error event"))
				: Effect.succeed(done),
		),
	);
}
