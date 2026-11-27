// The record of routing: one event per attempt on a route, published to a hub a product subscribes to.

import { ModelId, ProviderId, RequestKey, SessionId } from "@effectified/pi-ai";
import { Context, Effect, Layer, PubSub, Schema, type Scope, Stream } from "effect";
import { RouterRequestId } from "./ids.ts";
import { Cost, TokenUsage } from "./price.ts";
import { Route } from "./route-table.ts";

/** A position counted from 1: a request of a router, an attempt of a request. */
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * One attempt to serve a request on one route, written when the attempt ended.
 *
 * - `served`: the route answered; its response went to the caller.
 * - `failed`: the provider ended the request in an error.
 * - `aborted`: the caller gave the request up, or the provider did (a timeout, a closed connection).
 * - `unavailable`: nothing was sent: the provider or the model is not registered, or the provider has no
 *   credentials.
 */
export const RouteEvent = Schema.Struct({
	/** The id of the router's provider. */
	router: ProviderId,
	/** Counts the requests of this router from 1; the attempts of one request share it. */
	request: Ordinal,
	/**
	 * The id of the request: the same for every attempt of one request, and of no other request, of this router or of
	 * another, in this process or a later one. With `attempt` it names one attempt for good.
	 */
	requestId: RouterRequestId,
	/** pi-ai's `sessionId` of the request, when it had one: Pi Durable sends a conversation's provider session. */
	sessionId: Schema.optional(SessionId),
	/**
	 * The key of what the request asks, when it had a session (`requestKey`): unlike `requestId`, the same for every
	 * send of one request of a conversation, a resend after a crash in a later process included, and the key the
	 * budget's reservation of the request has. It names no attempt: a request sent again is attempted again.
	 */
	requestKey: Schema.optional(RequestKey),
	alias: ModelId,
	route: Route,
	/** The position of this attempt in its request, from 1. */
	attempt: Ordinal,
	outcome: Schema.Literals(["served", "failed", "aborted", "unavailable"]),
	/**
	 * True when the next route is tried because of this outcome. The usage of such an attempt is told by this event
	 * alone; the usage of a request's last attempt (`fallback: false`) is also in the message the request ends with.
	 * An attempt the product's `AttemptSettlement` could not settle is taken over by no route, so it says false.
	 */
	fallback: Schema.Boolean,
	/** pi-ai's error text of a failed or aborted attempt, or why the route was unavailable. */
	errorMessage: Schema.optional(Schema.String),
	/** What the provider reported, also for a failed or aborted attempt; zeros when it reported nothing. */
	usage: TokenUsage,
	/**
	 * `usage` at the route's price, rounded up once. A count that is not a whole number is rounded up and one that is
	 * not a positive number counts as zero: the rule of `@effectified/pi-budget`.
	 */
	cost: Cost,
	/** Clock time in milliseconds when the attempt began, before any wait. */
	startedAt: Schema.Finite,
	/** Milliseconds spent waiting for a slot and for the backoff of the route's concurrency key. */
	waitedMillis: Schema.Finite,
	/** Milliseconds from sending the request to its outcome; zero when nothing was sent. */
	durationMillis: Schema.Finite,
});

/** One attempt to serve a request on one route. */
export type RouteEvent = typeof RouteEvent.Type;

/** Where route events go and where a product reads them. */
export interface RouteEventsService {
	/** Hands `event` to every current subscriber. Never waits and never drops: each subscriber has its own queue. */
	readonly publish: (event: RouteEvent) => Effect.Effect<void>;
	/** The events published from the moment the Stream starts running. */
	readonly stream: Stream.Stream<RouteEvent>;
	/** Subscribes now and returns the Stream of the events published from now on, until the scope closes. */
	readonly subscribe: Effect.Effect<Stream.Stream<RouteEvent>, never, Scope.Scope>;
}

/** The hub of a router's route events. A subscriber that stops reading keeps its unread events in memory. */
export class RouteEvents extends Context.Service<RouteEvents, RouteEventsService>()(
	"@effectified/pi-router/route-events/RouteEvents",
) {
	/** A fresh hub with no subscriber; closing the Layer's scope ends every subscriber's Stream. */
	static readonly layer: Layer.Layer<RouteEvents> = Layer.effect(
		RouteEvents,
		Effect.gen(function* () {
			const hub = yield* Effect.acquireRelease(PubSub.unbounded<RouteEvent>(), PubSub.shutdown);
			return {
				publish: (event) => Effect.asVoid(PubSub.publish(hub, event)),
				stream: Stream.fromPubSub(hub),
				subscribe: Effect.map(PubSub.subscribe(hub), Stream.fromSubscription),
			};
		}),
	);
}
