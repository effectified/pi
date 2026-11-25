import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type FauxProviderHandle,
	fauxAssistantMessage,
	isRetryableAssistantError,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { type AttemptServices, type RoutedRequest, serve } from "../src/attempts.ts";
import {
	AttemptSettlement,
	type AttemptSettlementService,
	Limiter,
	type LimiterOptions,
	type Route,
	type RouteEvent,
} from "../src/index.ts";
import {
	context,
	failing,
	hanging,
	label,
	PRICE,
	realTick,
	recording,
	route,
	scripted,
	summary,
	until,
} from "./scripted.ts";

/** The services of a router over `handles`, with a recording event hub. Every key has four slots unless given. */
const setup = Effect.fnUntraced(function* (handles: FauxProviderHandle[], options: LimiterOptions = { limits: {} }) {
	const models = createModels();
	for (const handle of handles) models.setProvider(handle.provider);
	const { seen, events } = recording();
	const limits = {
		...Object.fromEntries(handles.map((handle) => [handle.provider.id, { maxInFlight: 4 }])),
		...options.limits,
	};
	const limiter = yield* Limiter.make({ ...options, limits });
	const services: AttemptServices = { router: "router", models, limiter, events };
	return { services, seen, models };
});

/** Request 1 to alias `fast` over `routes`; what the caller sees goes to `emitted`. */
function request(
	routes: readonly [Route, ...Route[]],
	emitted: string[] = [],
	options: RoutedRequest["options"] = {},
): RoutedRequest {
	return {
		request: 1,
		id: "router-a-1",
		alias: "fast",
		routes,
		context,
		options,
		emit: (event) =>
			Effect.sync(() => {
				emitted.push(label(event));
			}),
	};
}

// pi-ai's scripted provider counts "user:hi" as 2 input tokens and four characters of output as one token.
const HELLO = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 };
const NOTHING_OUT = { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("serve", () => {
	it("serves from the first route and records one attempt", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([fauxAssistantMessage("Hello world")]);
		const emitted: string[] = [];
		const { message, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { message: yield* serve(services, request([route("a"), route("b")], emitted)), seen };
			}),
		);
		expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect([message.provider, message.model, message.stopReason]).toEqual(["a", "m", "stop"]);
		expect(message.diagnostics).toBeUndefined();
		expect(emitted).toEqual([
			"start",
			"text_start",
			"text_delta Hell",
			"text_delta o wo",
			"text_delta rld",
			"text_end",
			"done stop",
		]);
		expect(seen.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "a/m",
				outcome: "served",
				fallback: false,
				errorMessage: undefined,
				usage: HELLO,
				// 2 x 3.0 + 3 x 15.0 micro units.
				micros: 51n,
			},
		]);
		expect(seen[0].router).toBe("router");
		expect(seen[0].requestId).toBe("router-a-1");
		// The request carried no pi-ai session, so the event has none.
		expect(seen[0]).not.toHaveProperty("sessionId");
		expect(seen[0].alias).toBe("fast");
		expect(seen[0].route).toEqual(route("a"));
		expect(b.state.callCount).toBe(0);
	});

	it("falls back after a retryable failure and records both attempts in order", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const emitted: string[] = [];
		const { message, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { message: yield* serve(services, request([route("a"), route("b")], emitted)), seen };
			}),
		);
		expect(seen.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "a/m",
				outcome: "failed",
				fallback: true,
				errorMessage: "overloaded",
				// The failed attempt's usage is reported and priced too: 2 x 3.0 micro units.
				usage: NOTHING_OUT,
				micros: 6n,
			},
			{
				request: 1,
				attempt: 2,
				route: "b/m",
				outcome: "served",
				fallback: false,
				errorMessage: undefined,
				usage: HELLO,
				micros: 51n,
			},
		]);
		// The caller sees one response: the first route's `start` never reached it.
		expect(emitted.filter((event) => event === "start")).toHaveLength(1);
		expect(emitted[emitted.length - 1]).toBe("done stop");
		// The message names the route that served it, and says that it was a fallback.
		expect([message.provider, message.model]).toEqual(["b", "m"]);
		expect(message.diagnostics).toHaveLength(1);
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "route_fallback",
			details: { router: "router", alias: "fast", attempt: 2, failed: [{ provider: "a", model: "m" }] },
		});
	});

	it("does not fall back after a failure that is not retryable", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("400 invalid request: bad tool schema")]);
		const emitted: string[] = [];
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("b")], emitted))), seen };
			}),
		);
		expect(error._tag).toBe("ModelRequestError");
		expect(error.message).toBe("400 invalid request: bad tool schema");
		expect(seen.map((event) => [event.attempt, event.outcome, event.fallback])).toEqual([[1, "failed", false]]);
		expect(b.state.callCount).toBe(0);
		expect(emitted).toEqual([]);
	});

	it("does not fall back when the provider gave the request up", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("Request timed out", "aborted")]);
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("b")]))), seen };
			}),
		);
		expect(error._tag).toBe("ModelRequestError");
		expect(error._tag === "ModelRequestError" && error.reason).toBe("aborted");
		expect(seen.map((event) => [event.outcome, event.fallback, event.errorMessage])).toEqual([
			["aborted", false, "Request timed out"],
		]);
		expect(b.state.callCount).toBe(0);
	});

	it("does not fall back once output has reached the caller, even for a retryable failure", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage: "overloaded" })]);
		const emitted: string[] = [];
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("b")], emitted))), seen };
			}),
		);
		expect(error._tag).toBe("ModelRequestError");
		expect(error._tag === "ModelRequestError" && error.response.content).toEqual([
			{ type: "text", text: "partial answer" },
		]);
		expect(emitted).toEqual([
			"start",
			"text_start",
			"text_delta part",
			"text_delta ial ",
			"text_delta answ",
			"text_delta er",
			"text_end",
		]);
		expect(seen.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "a/m",
				outcome: "failed",
				fallback: false,
				errorMessage: "overloaded",
				// 2 x 3.0 + 4 x 15.0 micro units.
				usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
				micros: 66n,
			},
		]);
		expect(b.state.callCount).toBe(0);
	});

	it("fails with RoutesExhausted, and an event for each attempt, when every route failed", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		b.setResponses([failing("503 Service Unavailable")]);
		const emitted: string[] = [];
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("b")], emitted))), seen };
			}),
		);
		expect(error._tag).toBe("RoutesExhausted");
		expect(error).toMatchObject({
			alias: "fast",
			failures: [
				{ provider: "a", model: "m", message: "overloaded" },
				{ provider: "b", model: "m", message: "503 Service Unavailable" },
			],
		});
		expect(error.message).toBe('Every route of alias "fast" failed: a/m: overloaded; b/m: 503 Service Unavailable');
		// The response is pi-ai's message of the last route that answered.
		const response = error._tag === "RoutesExhausted" ? error.response : undefined;
		expect([response?.provider, response?.stopReason, response?.errorMessage]).toEqual([
			"b",
			"error",
			"503 Service Unavailable",
		]);
		expect(seen.map((event) => [event.attempt, event.route.provider, event.outcome, event.fallback])).toEqual([
			[1, "a", "failed", true],
			// No route is left, so this failure starts no fallback.
			[2, "b", "failed", false],
		]);
		expect(emitted).toEqual([]);
	});

	it("gives every attempt of a request the request's id and its pi-ai session", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				yield* serve(services, request([route("a"), route("b")], [], { sessionId: "session-7" }));
				return seen;
			}),
		);
		expect(seen.map((event) => [event.requestId, event.sessionId, event.attempt, event.fallback])).toEqual([
			["router-a-1", "session-7", 1, true],
			["router-a-1", "session-7", 2, false],
		]);
	});

	it("ends a request whose last route was unavailable with a response that repeats no earlier attempt's usage", async () => {
		const a = scripted("a");
		a.setResponses([failing("overloaded")]);
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("gone")]))), seen };
			}),
		);
		// The first attempt used tokens, and its event says so. It is not the request's last attempt.
		expect(
			seen.map((event) => [event.attempt, event.outcome, event.fallback, event.usage, event.cost.micros]),
		).toEqual([
			[1, "failed", true, NOTHING_OUT, 6n],
			[2, "unavailable", false, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0n],
		]);
		// The response keeps the first route's error text, for Pi's retry rules, and the last attempt's usage: none.
		const response = error._tag === "RoutesExhausted" ? error.response : undefined;
		expect([response?.provider, response?.errorMessage]).toEqual(["a", "overloaded"]);
		expect(response?.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("records an attempt whose provider reported a count that is not a whole number, priced by the budget's rule", async () => {
		const a = scripted("a");
		// A provider of its own: pi-ai's scripted one always counts whole tokens.
		const answer = (): AssistantMessageEventStream => {
			const message = fauxAssistantMessage("Hello world");
			const events = createAssistantMessageEventStream();
			events.push({
				type: "done",
				reason: "stop",
				message: {
					...message,
					usage: { ...message.usage, input: 1.5, output: Number.NaN, cacheRead: -4, cacheWrite: 0 },
				},
			});
			events.end();
			return events;
		};
		const { served, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen, models } = yield* setup([a]);
				models.setProvider(
					createProvider({
						id: "a",
						auth: { apiKey: { name: "none", resolve: () => Promise.resolve({ auth: {} }) } },
						models: a.models,
						api: { stream: answer, streamSimple: answer },
					}),
				);
				return { served: yield* serve(services, request([route("a")])), seen };
			}),
		);
		expect(served.stopReason).toBe("stop");
		// 1.5 input tokens are charged as 2, at 3.0 micro units each; the other counts are not positive numbers.
		expect(seen.map((event) => [event.outcome, event.cost])).toEqual([["served", { currency: "USD", micros: 6n }]]);
	});

	it("skips a route whose provider is gone or has no credentials, and records it as unavailable", async () => {
		const b = scripted("b");
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const keyless = scripted("keyless");
		const { message, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen, models } = yield* setup([b]);
				// The same models, behind an auth that resolves to nothing: pi-ai calls the provider unconfigured.
				models.setProvider(
					createProvider({
						id: "keyless",
						auth: { apiKey: { name: "none", resolve: () => Promise.resolve(undefined) } },
						models: keyless.models,
						api: { stream: keyless.provider.stream, streamSimple: keyless.provider.streamSimple },
					}),
				);
				const routes = [route("gone"), route("keyless"), route("b", { model: "other" }), route("b")] as const;
				return { message: yield* serve(services, request(routes)), seen };
			}),
		);
		expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(seen.map((event) => [event.attempt, event.outcome, event.fallback, event.errorMessage])).toEqual([
			[1, "unavailable", true, 'Provider "gone" is not registered'],
			[2, "unavailable", true, 'Provider "keyless" is not configured'],
			[3, "unavailable", true, 'Provider "b" does not list the chat model "other"'],
			[4, "served", false, undefined],
		]);
		// Nothing was sent, so there is nothing to price.
		expect(seen[0].usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(seen[0].cost).toEqual({ currency: "USD", micros: 0n });
		expect(keyless.state.callCount).toBe(0);
	});

	it("fails with RoutesExhausted and no response when no provider could be reached", async () => {
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const { services } = yield* setup([]);
				return yield* Effect.flip(serve(services, request([route("gone")])));
			}),
		);
		expect(error._tag).toBe("RoutesExhausted");
		expect(error._tag === "RoutesExhausted" && error.response).toBeUndefined();
		expect(error.message).toBe('Every route of alias "fast" failed: gone/m: Provider "gone" is not registered');
	});

	it("backs a rate-limited key off: the next attempt on it waits on the Clock, with no real waiting", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("429 Too Many Requests")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const started = performance.now();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b], {
					limits: { shared: { maxInFlight: 2 } },
					backoff: { baseMillis: 1_000, maxMillis: 60_000 },
				});
				const routes = [
					route("a", { concurrencyKey: "shared" }),
					route("b", { concurrencyKey: "shared" }),
				] as const;
				const fiber = yield* Effect.forkChild(serve(services, request(routes)));
				yield* until(() => seen.length === 1);
				yield* TestClock.adjust("999 millis");
				yield* realTick;
				const early = b.state.callCount;
				yield* TestClock.adjust("1 millis");
				const message = yield* Fiber.join(fiber);
				return { early, message, seen };
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(result.early).toBe(0);
		expect(result.message.provider).toBe("b");
		expect(
			result.seen.map((event) => [event.outcome, event.startedAt, event.waitedMillis, event.durationMillis]),
		).toEqual([
			["failed", 0, 0, 0],
			// The second attempt began at once and waited the base backoff of its key before it was sent.
			["served", 0, 1_000, 0],
		]);
		expect(performance.now() - started).toBeLessThan(800);
	});

	it("honours the retry-after the adapter reported, and still calls the caller's onResponse", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([
			async (_context, options, _state, model) => {
				// What an adapter does that reports error responses: the status and the headers of the refusal.
				await options?.onResponse?.({ status: 429, headers: { "retry-after": "7" } }, model);
				return failing("overloaded");
			},
		]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const reported: ProviderResponse[] = [];
		const waited = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b], { limits: { shared: { maxInFlight: 2 } } });
				const routes = [
					route("a", { concurrencyKey: "shared" }),
					route("b", { concurrencyKey: "shared" }),
				] as const;
				const options = { onResponse: (response: ProviderResponse) => void reported.push(response) };
				const fiber = yield* Effect.forkChild(serve(services, request(routes, [], options)));
				yield* until(() => seen.length === 1);
				yield* TestClock.adjust("7 seconds");
				yield* Fiber.join(fiber);
				return seen.map((event) => event.waitedMillis);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(waited).toEqual([0, 7_000]);
		// The scripted provider reports 200 before each response; the first route then reported its refusal.
		expect(reported.map((response) => response.status)).toEqual([200, 429, 200]);
	});

	it("does not hold back a route on another key", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("429 Too Many Requests")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const waited = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				// Never adjusted: a wait on the test clock would hang the test.
				yield* serve(services, request([route("a"), route("b")]));
				return seen.map((event) => [event.outcome, event.fallback, event.waitedMillis]);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(waited).toEqual([
			["failed", true, 0],
			["served", false, 0],
		]);
	});

	it("keeps at most maxInFlight requests of a key at the provider", async () => {
		const a = scripted("a");
		const gauge = { inFlight: 0, max: 0 };
		const slow = async (): Promise<AssistantMessage> => {
			gauge.inFlight += 1;
			gauge.max = Math.max(gauge.max, gauge.inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			gauge.inFlight -= 1;
			return fauxAssistantMessage("ok");
		};
		a.setResponses([slow, slow, slow, slow, slow, slow, slow]);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a], { limits: { a: { maxInFlight: 2 } } });
				yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7], () => serve(services, request([route("a")])), {
					concurrency: "unbounded",
				});
				return seen;
			}),
		);
		expect(gauge.max).toBe(2);
		expect(seen.map((event) => event.outcome)).toEqual(Array.from({ length: 7 }, () => "served"));
		expect(a.state.callCount).toBe(7);
	});

	it("aborts the provider request when its fiber is interrupted, and records the attempt as aborted", async () => {
		const a = scripted("a");
		const b = scripted("b");
		const pending = hanging();
		a.setResponses([pending.response]);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				const fiber = yield* Effect.forkChild(serve(services, request([route("a"), route("b")])));
				const signal = yield* Effect.promise(() => pending.signal);
				const abortedBefore = signal?.aborted;
				yield* Fiber.interrupt(fiber);
				return { signal, abortedBefore, exit: yield* Effect.exit(Fiber.join(fiber)), seen };
			}),
		);
		expect(result.abortedBefore).toBe(false);
		expect(result.signal?.aborted).toBe(true);
		expect(Exit.hasInterrupts(result.exit)).toBe(true);
		expect(result.seen.map((event) => [event.attempt, event.outcome, event.fallback, event.errorMessage])).toEqual([
			[1, "aborted", false, "Request was aborted"],
		]);
		expect(b.state.callCount).toBe(0);
	});

	it("records an attempt that is interrupted while it waits for its key, with nothing sent", async () => {
		const a = scripted("a");
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a]);
				yield* services.limiter.backOff("a");
				const fiber = yield* Effect.forkChild(serve(services, request([route("a")])));
				yield* realTick;
				yield* TestClock.adjust("400 millis");
				yield* Fiber.interrupt(fiber);
				return seen.map((event) => [event.outcome, event.waitedMillis, event.durationMillis]);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(result).toEqual([["aborted", 400, 0]]);
		expect(a.state.callCount).toBe(0);
	});
});

/** A settlement that keeps the attempts it is handed, and fails for those `refuses` names, with its reason. */
function settling(refuses: (event: RouteEvent) => string | undefined = () => undefined) {
	const handed: RouteEvent[] = [];
	const port: AttemptSettlementService = {
		settle: (event) =>
			Effect.suspend(() => {
				handed.push(event);
				const reason = refuses(event);
				return reason === undefined ? Effect.void : Effect.fail(new Error(reason));
			}),
	};
	return { handed, port };
}

describe("serve, with the product's settlement of the attempts another route takes over", () => {
	it("has each such attempt settled, in order, before the next route is sent anything and before the caller sees the end", async () => {
		const [a, b, c] = [scripted("a"), scripted("b"), scripted("c")];
		// One log for the providers, the port, the record and the caller: its order is the order things happened in.
		const log: string[] = [];
		const asked = (name: string, response: AssistantMessage) => () => {
			log.push(`${name}: request`);
			return response;
		};
		a.setResponses([asked("a", failing("overloaded"))]);
		b.setResponses([asked("b", failing("503 Service Unavailable"))]);
		c.setResponses([asked("c", fauxAssistantMessage("Hello world"))]);
		const handed: RouteEvent[] = [];
		const port: AttemptSettlementService = {
			settle: (event) =>
				Effect.gen(function* () {
					log.push(`port: settle #${event.attempt}`);
					handed.push(event);
					// A port that takes its time, as a lease does: the router waits for it.
					yield* Effect.sleep("5 millis");
					log.push(`port: settled #${event.attempt}`);
				}),
		};
		const { message, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b, c]);
				const logged: AttemptServices = {
					...services,
					events: {
						...services.events,
						publish: (event) =>
							Effect.andThen(
								Effect.sync(() => log.push(`record: #${event.attempt} ${event.outcome} ${event.fallback}`)),
								services.events.publish(event),
							),
					},
				};
				const message = yield* serve(logged, request([route("a"), route("b"), route("c")], log));
				log.push("caller: has the message");
				return { message, seen };
			}).pipe(Effect.provideService(AttemptSettlement, port)),
		);
		expect(log).toEqual([
			"a: request",
			"port: settle #1",
			"port: settled #1",
			"record: #1 failed true",
			"b: request",
			"port: settle #2",
			"port: settled #2",
			"record: #2 failed true",
			"c: request",
			"start",
			"text_start",
			"text_delta Hell",
			"text_delta o wo",
			"text_delta rld",
			"text_end",
			"record: #3 served false",
			"done stop",
			"caller: has the message",
		]);
		expect(message.provider).toBe("c");
		// Once each, with the attempt's own route event: the one that is published.
		expect(handed).toEqual([seen[0], seen[1]]);
		expect(handed.map((event) => [event.requestId, event.attempt, event.fallback, event.cost.micros])).toEqual([
			["router-a-1", 1, true, 6n],
			["router-a-1", 2, true, 6n],
		]);
	});

	it("never hands over a request's last attempt: its usage is in the message the request ends with", async () => {
		/** The attempts handed over and recorded when `routes` are tried against `script`. */
		const tried = (routes: readonly [Route, ...Route[]], script: Record<string, AssistantMessage>) => {
			const handles = Object.entries(script).map(([id, response]) => {
				const handle = scripted(id);
				handle.setResponses([response]);
				return handle;
			});
			const { handed, port } = settling();
			return Effect.runPromise(
				Effect.gen(function* () {
					const { services, seen } = yield* setup(handles);
					const exit = yield* Effect.exit(serve(services, request(routes)));
					return {
						ended: Exit.isSuccess(exit) ? "served" : "failed",
						handed: handed.map((event) => event.attempt),
						recorded: seen.map((event) => [event.attempt, event.outcome, event.fallback, event.cost.micros]),
					};
				}).pipe(Effect.provideService(AttemptSettlement, port)),
			);
		};
		const pair = [route("a"), route("b")] as const;
		// The attempt that served.
		expect(await tried(pair, { a: fauxAssistantMessage("Hello world") })).toEqual({
			ended: "served",
			handed: [],
			recorded: [[1, "served", false, 51n]],
		});
		// The served attempt of a fallback: the failed one is handed over, the one that served is not.
		expect(await tried(pair, { a: failing("overloaded"), b: fauxAssistantMessage("Hello world") })).toEqual({
			ended: "served",
			handed: [1],
			recorded: [
				[1, "failed", true, 6n],
				[2, "served", false, 51n],
			],
		});
		// A failure that ends the request: not retryable, or given up by the provider.
		expect(await tried(pair, { a: failing("400 invalid request"), b: fauxAssistantMessage("never") })).toEqual({
			ended: "failed",
			handed: [],
			recorded: [[1, "failed", false, 6n]],
		});
		expect(
			await tried(pair, { a: failing("Request timed out", "aborted"), b: fauxAssistantMessage("never") }),
		).toEqual({ ended: "failed", handed: [], recorded: [[1, "aborted", false, 6n]] });
		// The last route's failure, when every route failed.
		expect(await tried(pair, { a: failing("overloaded"), b: failing("503 Service Unavailable") })).toEqual({
			ended: "failed",
			handed: [1],
			recorded: [
				[1, "failed", true, 6n],
				[2, "failed", false, 6n],
			],
		});
	});

	it("hands over no attempt that cost nothing: a route that was unavailable, and one that is free", async () => {
		const free = scripted("free");
		const b = scripted("b");
		free.setResponses([failing("overloaded")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const { handed, port } = settling();
		const recorded = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([free, b]);
				const nothing = { ...PRICE, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				yield* serve(services, request([route("gone"), route("free", { price: nothing }), route("b")]));
				return seen.map((event) => [
					event.attempt,
					event.outcome,
					event.fallback,
					event.usage.input,
					event.cost.micros,
				]);
			}).pipe(Effect.provideService(AttemptSettlement, port)),
		);
		// Both were taken over, and neither has anything to settle.
		expect(recorded).toEqual([
			[1, "unavailable", true, 0, 0n],
			[2, "failed", true, 2, 0n],
			[3, "served", false, 2, 51n],
		]);
		expect(handed).toEqual([]);
	});

	it("ends the request with AttemptUnsettled when the port fails: the next route is sent nothing, and the attempt is the request's last", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const { handed, port } = settling(() => "The budget lease is fenced: 503 overloaded");
		const emitted: string[] = [];
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				const routes = [route("a"), route("b")] as const;
				return { error: yield* Effect.flip(serve(services, request(routes, emitted))), seen };
			}).pipe(Effect.provideService(AttemptSettlement, port)),
		);
		expect(error._tag).toBe("AttemptUnsettled");
		expect(error).toMatchObject({
			alias: "fast",
			requestId: "router-a-1",
			attempt: 1,
			provider: "a",
			model: "m",
			reason: "The budget lease is fenced: 503 overloaded",
		});
		expect(b.state.callCount).toBe(0);
		expect(emitted).toEqual([]);
		// The port was handed the attempt as one being taken over. It was not, and the record says so.
		expect(handed.map((event) => [event.attempt, event.fallback])).toEqual([[1, true]]);
		expect(seen.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "a/m",
				outcome: "failed",
				fallback: false,
				errorMessage: "overloaded",
				usage: NOTHING_OUT,
				micros: 6n,
			},
		]);
		// The request ends with the failed route's own answer: the usage of its last attempt, for whatever wraps it.
		const response = error._tag === "AttemptUnsettled" ? error.response : undefined;
		expect([response?.provider, response?.model, response?.errorMessage]).toEqual(["a", "m", "overloaded"]);
		expect([response?.usage.input, response?.usage.output]).toEqual([2, 0]);
		// Pi sends a request again for an error text pi-ai calls retryable. The provider's was, and so is the port's
		// reason; the error's own text is not, and it holds neither.
		expect(error.message).toBe(
			'Attempt 1 of a request to alias "fast" could not be settled, so no other route was tried',
		);
		expect(isRetryableAssistantError(failing(error.message))).toBe(false);
		expect(isRetryableAssistantError(failing("overloaded"))).toBe(true);
		expect(isRetryableAssistantError(failing("The budget lease is fenced: 503 overloaded"))).toBe(true);
	});

	it("ends the request the same way when the port dies", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		const port: AttemptSettlementService = { settle: () => Effect.die(new Error("ledger down")) };
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b]);
				return { error: yield* Effect.flip(serve(services, request([route("a"), route("b")]))), seen };
			}).pipe(Effect.provideService(AttemptSettlement, port)),
		);
		expect(error).toMatchObject({
			_tag: "AttemptUnsettled",
			attempt: 1,
			reason: "the settlement port died: ledger down",
		});
		expect(seen.map((event) => [event.attempt, event.outcome, event.fallback])).toEqual([[1, "failed", false]]);
		expect(b.state.callCount).toBe(0);
	});

	it("leaves an earlier attempt settled when a later one cannot be: that one ends the request", async () => {
		const [a, b, c] = [scripted("a"), scripted("b"), scripted("c")];
		a.setResponses([failing("overloaded")]);
		b.setResponses([failing("503 Service Unavailable")]);
		const { handed, port } = settling((event) => (event.attempt === 2 ? "the lease expired" : undefined));
		const { error, seen } = await Effect.runPromise(
			Effect.gen(function* () {
				const { services, seen } = yield* setup([a, b, c]);
				const routes = [route("a"), route("b"), route("c")] as const;
				return { error: yield* Effect.flip(serve(services, request(routes))), seen };
			}).pipe(Effect.provideService(AttemptSettlement, port)),
		);
		expect(error).toMatchObject({ _tag: "AttemptUnsettled", attempt: 2, provider: "b", reason: "the lease expired" });
		expect(handed.map((event) => event.attempt)).toEqual([1, 2]);
		// The first attempt was settled by the port and taken over; the second is the request's last.
		expect(seen.map((event) => [event.attempt, event.outcome, event.fallback])).toEqual([
			[1, "failed", true],
			[2, "failed", false],
		]);
		const response = error._tag === "AttemptUnsettled" ? error.response : undefined;
		expect([response?.provider, response?.errorMessage]).toEqual(["b", "503 Service Unavailable"]);
		expect(c.state.callCount).toBe(0);
	});

	it("settles an ended attempt also when the caller gives up meanwhile, and then tries no other route", async () => {
		const a = scripted("a");
		const b = scripted("b");
		a.setResponses([failing("overloaded")]);
		b.setResponses([fauxAssistantMessage("Hello world")]);
		const state = { entered: false, settled: false };
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ledger = yield* Deferred.make<void>();
				const port: AttemptSettlementService = {
					settle: () =>
						Effect.gen(function* () {
							state.entered = true;
							yield* Deferred.await(ledger);
							state.settled = true;
						}),
				};
				const { services, seen } = yield* setup([a, b]);
				const fiber = yield* Effect.forkChild(
					serve(services, request([route("a"), route("b")])).pipe(Effect.provideService(AttemptSettlement, port)),
				);
				yield* until(() => state.entered);
				// The interruption waits for the fiber, so it is asked for from a fiber of its own.
				const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
				yield* realTick;
				const meanwhile = {
					settled: state.settled,
					ended: fiber.pollUnsafe() !== undefined,
					recorded: seen.length,
				};
				yield* Deferred.succeed(ledger, undefined);
				yield* Fiber.join(interruption);
				return { meanwhile, exit: yield* Fiber.await(fiber), seen };
			}).pipe(Effect.provide(TestClock.layer())),
		);
		// The caller's interruption waits for the port: nothing is recorded and nothing ends before it has settled.
		expect(result.meanwhile).toEqual({ settled: false, ended: false, recorded: 0 });
		expect(state.settled).toBe(true);
		expect(Exit.hasInterrupts(result.exit)).toBe(true);
		// The attempt is on record once, as what it was: failed and settled. The next route was sent nothing.
		expect(result.seen.map((event) => [event.attempt, event.outcome, event.fallback, event.cost.micros])).toEqual([
			[1, "failed", true, 6n],
		]);
		expect(b.state.callCount).toBe(0);
	});
});
