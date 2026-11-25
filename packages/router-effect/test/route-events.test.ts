import { Context, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { RouteEvent, RouteEvents } from "../src/index.ts";
import { route } from "./scripted.ts";

/** A route event of attempt `attempt`, as the router writes one. */
function event(attempt: number): RouteEvent {
	return {
		router: "router",
		request: 1,
		requestId: "router-a-1",
		alias: "fast",
		route: route("a"),
		attempt,
		outcome: "served",
		fallback: false,
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
		cost: { currency: "USD", micros: 51n },
		startedAt: 0,
		waitedMillis: 0,
		durationMillis: 12,
	};
}

describe("RouteEvents", () => {
	it("gives a subscriber every event published after it subscribed, in order", async () => {
		const attempts = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* RouteEvents;
					yield* events.publish(event(1));
					const subscribed = yield* events.subscribe;
					yield* events.publish(event(2));
					yield* events.publish(event(3));
					return yield* Stream.runCollect(Stream.take(subscribed, 2));
				}),
			).pipe(Effect.provide(RouteEvents.layer)),
		);
		expect(attempts.map((seen) => seen.attempt)).toEqual([2, 3]);
	});

	it("gives every subscriber every event", async () => {
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* RouteEvents;
					const first = yield* events.subscribe;
					const second = yield* events.subscribe;
					yield* events.publish(event(1));
					yield* events.publish(event(2));
					const take = (stream: Stream.Stream<RouteEvent>) =>
						Effect.map(Stream.runCollect(Stream.take(stream, 2)), (taken) => taken.map((one) => one.attempt));
					return [yield* take(first), yield* take(second)];
				}),
			).pipe(Effect.provide(RouteEvents.layer)),
		);
		expect(seen).toEqual([
			[1, 2],
			[1, 2],
		]);
	});

	it("starts `stream` when it is run: it sees what is published from then on", async () => {
		const attempts = await Effect.runPromise(
			Effect.gen(function* () {
				const events = yield* RouteEvents;
				yield* events.publish(event(1));
				// Started at once, the Stream has subscribed when the fork returns.
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream, 2)), {
					startImmediately: true,
				});
				yield* events.publish(event(2));
				yield* events.publish(event(3));
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(RouteEvents.layer)),
		);
		expect(attempts.map((seen) => seen.attempt)).toEqual([2, 3]);
	});

	it("ends a subscriber's Stream when the Layer's scope closes", async () => {
		const attempts = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const hub = yield* Scope.make();
					const services = yield* Layer.buildWithScope(RouteEvents.layer, hub);
					const events = Context.get(services, RouteEvents);
					const subscribed = yield* events.subscribe;
					yield* events.publish(event(1));
					const fiber = yield* Effect.forkChild(Stream.runCollect(subscribed), { startImmediately: true });
					yield* Scope.close(hub, Exit.void);
					return yield* Fiber.join(fiber);
				}),
			),
		);
		expect(attempts.map((seen) => seen.attempt)).toEqual([1]);
	});
});

describe("RouteEvent", () => {
	it("is the schema of what the router publishes", async () => {
		const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(RouteEvent)(event(1)));
		expect(decoded).toEqual(event(1));
	});

	it("carries the request's id always, and its pi-ai session and the route's labels when there are any", async () => {
		const decode = Schema.decodeUnknownEffect(RouteEvent);
		const full = { ...event(1), sessionId: "session-7", route: route("a", { labels: ["zero-data-retention"] }) };
		expect(await Effect.runPromise(decode(full))).toEqual(full);
		const { requestId: _requestId, ...anonymous } = event(1);
		const error = await Effect.runPromise(Effect.flip(decode(anonymous)));
		expect(error.message).toContain('["requestId"]');
	});

	it("rejects an outcome the router does not have", async () => {
		const error = await Effect.runPromise(
			Effect.flip(Schema.decodeUnknownEffect(RouteEvent)({ ...event(1), outcome: "retried" })),
		);
		expect(error.message).toContain('["outcome"]');
	});
});
