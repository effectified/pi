import {
	type AssistantMessage,
	type AssistantMessageEvent,
	fauxAssistantMessage,
	normalizeContext,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRequestError, type ResponseEvent } from "@gunta/pi-ai-effect";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { AttemptUnsettled, NoRouteAvailable, type RouterError, RoutesExhausted } from "../src/index.ts";
import * as PiProvider from "../src/provider.ts";
import type { ValidRouteTable } from "../src/route-table.ts";
import { context, failing, route, scripted, table } from "./scripted.ts";

const transcript = normalizeContext(context);

/** The alias `fast` over two scripted models that differ in what they can do. */
function twoRoutes(): ValidRouteTable {
	const a = scripted("a", { contextWindow: 200_000, maxTokens: 8_000, reasoning: true, input: ["text", "image"] });
	const b = scripted("b", {
		contextWindow: 128_000,
		maxTokens: 16_000,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	});
	const entry = { alias: "fast", name: "Fast", routes: [route("a"), route("b")] };
	return { table: table([entry]), aliases: [{ entry, models: [a.getModel(), b.getModel()] }] };
}

type Run = PiProvider.ProviderOptions["run"];

/** A provider whose requests run `run`, alive until `scope` closes. */
function provide(run: Run, scope: Scope.Scope): Effect.Effect<Provider> {
	return Scope.provide(PiProvider.make({ id: "router", table: twoRoutes(), run }), scope);
}

/** Every event of one pi-ai request to the alias model of `provider`. */
async function request(provider: Provider, options?: SimpleStreamOptions): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of provider.streamSimple(provider.getModels()[0], transcript, options)) events.push(event);
	return events;
}

/** The events of a request to a provider whose requests run `run`. */
function requestWith(run: Run, options?: SimpleStreamOptions): Promise<AssistantMessageEvent[]> {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const provider = yield* provide(run, yield* Effect.scope);
				return yield* Effect.promise(() => request(provider, options));
			}),
		),
	);
}

/** A `run` that fails with `error` before any output. */
const failingWith =
	(error: RouterError): Run =>
	() =>
		Effect.fail(error);

/** The `start` and `done` events of `message`, as a route's provider sends them. */
function eventsOf(message: AssistantMessage): ResponseEvent[] {
	return [
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	];
}

describe("make", () => {
	it("lists one chat model per alias, with what every route of the alias can do", async () => {
		const provider = await Effect.runPromise(
			Effect.scoped(
				Effect.flatMap(Effect.scope, (scope) =>
					provide(
						failingWith(
							new RoutesExhausted({ alias: "fast", failures: [{ provider: "a", model: "m", message: "x" }] }),
						),
						scope,
					),
				),
			),
		);
		expect([provider.id, provider.name]).toEqual(["router", "router"]);
		expect(provider.getModels()).toEqual([
			{
				id: "fast",
				name: "Fast",
				api: "pi-router",
				provider: "router",
				baseUrl: "pi-router://router",
				// One route does not reason and reads no images, so the alias promises neither.
				reasoning: false,
				input: ["text"],
				// pi-ai's catalog price of the first route; the scripted model is free.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// The smallest of the routes, so Pi compacts in time for any of them.
				contextWindow: 128_000,
				maxTokens: 8_000,
			},
		]);
	});

	it("runs a request with the alias, the transcript and the caller's options, and streams what is emitted", async () => {
		const message = fauxAssistantMessage("Hello");
		const calls: unknown[][] = [];
		const run: Run = (alias, given, options, emit) =>
			Effect.gen(function* () {
				calls.push([alias, given, options?.maxTokens, options?.metadata]);
				for (const event of eventsOf(message)) yield* emit(event);
				return message;
			});
		const events = await requestWith(run, { maxTokens: 64, metadata: { user_id: "u1" } });
		expect(calls).toEqual([["fast", transcript, 64, { user_id: "u1" }]]);
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(events[1].type === "done" && events[1].message).toBe(message);
	});

	it("serves both of pi-ai's entry points the same way", async () => {
		const message = fauxAssistantMessage("Hello");
		const run: Run = (_alias, _transcript, _options, emit) =>
			Effect.as(Effect.forEach(eventsOf(message), emit), message);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const provider = yield* provide(run, yield* Effect.scope);
					const model = provider.getModels()[0];
					return yield* Effect.promise(() => provider.stream(model, transcript, { temperature: 0 }).result());
				}),
			),
		);
		expect(result).toBe(message);
	});

	it("ends a request no route may serve in pi-ai's error event, as an empty message of the alias model", async () => {
		const error = new NoRouteAvailable({ alias: "fast", classification: "secret", excluded: [] });
		const events = await requestWith(failingWith(error));
		expect(events).toHaveLength(1);
		const last = events[0];
		expect(last.type === "error" && last.reason).toBe("error");
		expect(last.type === "error" && last.error).toMatchObject({
			role: "assistant",
			content: [],
			api: "pi-router",
			provider: "router",
			model: "fast",
			stopReason: "error",
			errorMessage: 'No route of alias "fast" may serve content classified "secret" in any region',
			usage: { input: 0, output: 0, totalTokens: 0 },
		});
	});

	it("passes the failed route's own message on unchanged", async () => {
		const response = failing("400 invalid request");
		const ended = await requestWith(failingWith(new ModelRequestError({ reason: "error", response })));
		expect(ended[0].type === "error" && ended[0].error).toBe(response);

		const gaveUp = failing("Request timed out", "aborted");
		const aborted = await requestWith(failingWith(new ModelRequestError({ reason: "aborted", response: gaveUp })));
		expect(aborted[0].type === "error" && [aborted[0].reason, aborted[0].error === gaveUp]).toEqual([
			"aborted",
			true,
		]);

		const failures = [{ provider: "a", model: "m", message: "overloaded" }] as const;
		const last = failing("overloaded");
		const exhausted = await requestWith(
			failingWith(new RoutesExhausted({ alias: "fast", failures, response: last })),
		);
		expect(exhausted[0].type === "error" && exhausted[0].error).toBe(last);
	});

	it("ends a request whose attempt could not be settled with that route's message, under the typed error's text", async () => {
		const response = failing("overloaded");
		const error = new AttemptUnsettled({
			alias: "fast",
			requestId: "router-a-1",
			attempt: 1,
			provider: "a",
			model: "m",
			reason: "the lease is fenced: 503 overloaded",
			response,
		});
		const events = await requestWith(failingWith(error));
		expect(events).toHaveLength(1);
		const [last] = events;
		expect(last.type === "error" && last.reason).toBe("error");
		// Everything of the route's message but its text: the usage is the request's last attempt's, and neither the
		// provider's words nor the port's reason reach Pi. (pi-ai adds a duration to the message it ends a stream with.)
		expect(last.type === "error" && last.error).toMatchObject({
			...response,
			stopReason: "error",
			errorMessage: 'Attempt 1 of a request to alias "fast" could not be settled, so no other route was tried',
		});
		expect(last.type === "error" && last.error.usage).toBe(response.usage);
	});

	it("says every failure when no route answered at all", async () => {
		const failures = [{ provider: "gone", model: "m", message: 'Provider "gone" is not registered' }] as const;
		const events = await requestWith(failingWith(new RoutesExhausted({ alias: "fast", failures })));
		expect(events[0].type === "error" && events[0].error.errorMessage).toBe(
			'Every route of alias "fast" failed: gone/m: Provider "gone" is not registered',
		);
	});

	it("interrupts the request when its signal aborts, and ends it as aborted with what the caller had seen", async () => {
		const partial = { ...fauxAssistantMessage("Hel"), stopReason: "pending" as const };
		const controller = new AbortController();
		let interrupted = false;
		const run: Run = (_alias, _transcript, _options, emit) =>
			Effect.gen(function* () {
				yield* emit({ type: "start", partial });
				yield* emit({ type: "text_start", contentIndex: 0, partial });
				return yield* Effect.never;
			}).pipe(
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			);
		const events = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const provider = yield* provide(run, yield* Effect.scope);
					const stream = provider.streamSimple(provider.getModels()[0], transcript, { signal: controller.signal });
					return yield* Effect.promise(async () => {
						const seen: AssistantMessageEvent[] = [];
						for await (const event of stream) {
							seen.push(event);
							if (event.type === "text_start") controller.abort();
						}
						return seen;
					});
				}),
			),
		);
		expect(interrupted).toBe(true);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "error"]);
		const last = events[2];
		expect(last.type === "error" && last.reason).toBe("aborted");
		expect(last.type === "error" && last.error).toMatchObject({
			content: [{ type: "text", text: "Hel" }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});
	});

	it("ends a request as aborted when its signal was aborted before it started", async () => {
		let ran = false;
		const run: Run = () =>
			Effect.sync(() => {
				ran = true;
				return fauxAssistantMessage("never");
			});
		const events = await requestWith(run, { signal: AbortSignal.abort() });
		expect(ran).toBe(false);
		expect(events.map((event) => event.type === "error" && [event.reason, event.error.model])).toEqual([
			["aborted", "fast"],
		]);
	});

	it("ends open requests as aborted when the scope closes, and later ones too", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const provider = yield* provide(() => Effect.never, scope);
				const open = request(provider);
				yield* Scope.close(scope, Exit.void);
				return { open: yield* Effect.promise(() => open), late: yield* Effect.promise(() => request(provider)) };
			}),
		);
		expect(result.open.map((event) => event.type === "error" && event.reason)).toEqual(["aborted"]);
		expect(result.late.map((event) => event.type === "error" && event.reason)).toEqual(["aborted"]);
	});

	it("ends a request whose run dies in pi-ai's error event, with the defect's text", async () => {
		const events = await requestWith(() => Effect.die(new Error("a broken provider")));
		expect(events.map((event) => event.type === "error" && [event.reason, event.error.errorMessage])).toEqual([
			["error", "a broken provider"],
		]);
	});
});
