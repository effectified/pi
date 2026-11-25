import {
	type AssistantMessageEvent,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	isRetryableAssistantError,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { complete, EffectProvider, getModel, Models } from "@gunta/pi-ai-effect";
import { runTest, ScriptedLanguageModel } from "@gunta/pi-ai-effect/testing";
import { Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	AttemptSettlement,
	type AttemptSettlementService,
	type ConstraintRequest,
	ConstraintSource,
	type ConstraintSourceService,
	type Constraints,
	ConstraintsUnavailable,
	constraintsToMetadata,
	type RouteEvent,
	RouteEvents,
	Router,
	type RouterOptions,
	type RouteTable,
	validateRouteTable,
} from "../src/index.ts";
import { context, failing, hanging, label, modelsLayer, PRICE, route, scripted, summary, table } from "./scripted.ts";

/** A router over `routes`, and the `Models` of `handles` it routes to. */
function routed(routes: RouteTable, handles: FauxProviderHandle[], options?: RouterOptions) {
	return Layer.provideMerge(Router.layer(routes, options), modelsLayer(...handles));
}

/** Three providers by what they may see: `open` (public, us), `cloud` (internal, eu) and `local` (secret, eu). */
function tiers() {
	const open = scripted("open");
	const cloud = scripted("cloud");
	const local = scripted("local");
	const routes = table([
		{
			alias: "author",
			routes: [
				route("open", { ceiling: "public", region: "us" }),
				route("cloud", { ceiling: "internal", region: "eu" }),
				route("local", { ceiling: "secret", region: "eu" }),
			],
		},
		{ alias: "fast", defaults: { classification: "public" }, routes: [route("open"), route("cloud")] },
	]);
	return { open, cloud, local, routes, layer: routed(routes, [open, cloud, local]) };
}

describe("Router.layer", () => {
	it("fails with the table's issues when the table cannot be used", async () => {
		const routes = table([{ alias: "fast", routes: [route("a"), route("nowhere")] }]);
		const error = await Effect.runPromise(Effect.scoped(Effect.flip(Layer.build(routed(routes, [scripted("a")])))));
		expect(error._tag).toBe("RouteTableError");
		expect(error.issues).toEqual([{ _tag: "UnknownProvider", alias: "fast", provider: "nowhere" }]);
	});

	it("puts the router's provider into Models until the scope closes", async () => {
		const a = scripted("a");
		const models = createModels();
		models.setProvider(a.provider);
		const routes = table([{ alias: "fast", routes: [route("a")] }]);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(Router.layer(routes).pipe(Layer.provide(Layer.succeed(Models, models))), scope);
				const during = models.getProviders().map((provider) => provider.id);
				const model = models.getModel("router", "fast");
				yield* Scope.close(scope, Exit.void);
				return { during, model: model?.id, after: models.getProviders().map((provider) => provider.id) };
			}),
		);
		expect(seen).toEqual({ during: ["a", "router"], model: "fast", after: ["a"] });
	});

	it("takes the provider's id and name from its options", async () => {
		const a = scripted("a");
		const routes = table([{ alias: "fast", routes: [route("a")] }]);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				const model = yield* getModel({ provider: "routes", modelId: "fast" });
				return { ids: [router.id, router.provider.id, router.provider.name, model.provider], table: router.table };
			}).pipe(Effect.provide(routed(routes, [a], { id: "routes", name: "Routes" }))),
		);
		expect(seen.ids).toEqual(["routes", "routes", "Routes", "routes"]);
		expect(seen.table).toEqual(routes);
	});
});

describe("a pi-ai request to an alias", () => {
	it("works end to end through Models.stream, and records the attempt", async () => {
		const { open, layer } = tiers();
		open.setResponses([fauxAssistantMessage("Hello world")]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const recorded = yield* (yield* RouteEvents).subscribe;
					const models = yield* Models;
					const model = yield* getModel({ provider: "router", modelId: "fast" });
					// pi-ai's own call, as a Pi harness makes it.
					const response = models.stream(model, context);
					const events = yield* Effect.promise(async () => {
						const seen: AssistantMessageEvent[] = [];
						for await (const event of response) seen.push(event);
						return seen;
					});
					const message = yield* Effect.promise(() => response.result());
					return { events, message, recorded: yield* Stream.runCollect(Stream.take(recorded, 1)) };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(result.events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.message.content).toEqual([{ type: "text", text: "Hello world" }]);
		// The message is the route's own: it names the provider and the model that answered.
		expect([result.message.provider, result.message.model, result.message.stopReason]).toEqual(["open", "m", "stop"]);
		expect(result.recorded.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "open/m",
				outcome: "served",
				fallback: false,
				errorMessage: undefined,
				usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
				micros: 51n,
			},
		]);
	});

	it("carries its constraints in metadata: the classification and the regions choose the route", async () => {
		const { open, cloud, local, layer } = tiers();
		cloud.setResponses([fauxAssistantMessage("from cloud")]);
		local.setResponses([fauxAssistantMessage("from local"), fauxAssistantMessage("from local again")]);
		const served = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* Models;
				const model = yield* getModel({ provider: "router", modelId: "author" });
				const ask = (metadata?: SimpleStreamOptions["metadata"]) =>
					Effect.promise(() => models.completeSimple(model, context, { metadata })).pipe(
						Effect.map((message) => message.provider),
					);
				return [
					yield* ask(constraintsToMetadata({ classification: "internal" })),
					yield* ask(constraintsToMetadata({ classification: "secret" })),
					// No classification is the highest one: only the route that may see everything.
					yield* ask(),
				];
			}).pipe(Effect.provide(layer)),
		);
		expect(served).toEqual(["cloud", "local", "local"]);
		expect(open.state.callCount).toBe(0);
	});

	it("reads its constraints from metadata only, whatever else its options hold", async () => {
		const { open, local, layer } = tiers();
		let forwarded: SimpleStreamOptions | undefined;
		local.setResponses([
			(_context, options) => {
				forwarded = options;
				return fauxAssistantMessage("from local");
			},
		]);
		const provider = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* Models;
				const model = yield* getModel({ provider: "router", modelId: "author" });
				// pi-ai lets a custom API take any option. This one is not how a request says its classification.
				const options = { constraints: { classification: "public" } };
				return (yield* Effect.promise(() => models.complete(model, context, options))).provider;
			}).pipe(Effect.provide(layer)),
		);
		expect(provider).toBe("local");
		expect(open.state.callCount).toBe(0);
		expect(Object.keys(forwarded ?? {})).not.toContain("constraints");
	});

	it("passes the caller's options on to the route's provider, without the router's own", async () => {
		const { open, layer } = tiers();
		let forwarded: SimpleStreamOptions | undefined;
		open.setResponses([
			(_context, options) => {
				forwarded = options;
				return fauxAssistantMessage("ok");
			},
		]);
		await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* Models;
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				yield* Effect.promise(() =>
					models.completeSimple(model, context, {
						apiKey: "a key for some other provider",
						deferred: true,
						reasoning: "high",
						maxTokens: 64,
						sessionId: "s1",
						headers: { "x-trace": "t1" },
						metadata: { user_id: "u1", ...constraintsToMetadata({ regions: ["us"] }) },
					}),
				);
			}).pipe(Effect.provide(layer)),
		);
		expect(forwarded).toMatchObject({
			reasoning: "high",
			maxTokens: 64,
			sessionId: "s1",
			headers: { "x-trace": "t1" },
			// The constraints stay with the router; the rest of the metadata is the provider's.
			metadata: { user_id: "u1" },
		});
		expect(forwarded?.apiKey).toBeUndefined();
		expect(forwarded?.deferred).toBeUndefined();
		expect(forwarded?.signal).toBeInstanceOf(AbortSignal);
	});

	it("ends in pi-ai's error, with nothing sent, when no route may serve it", async () => {
		const { open, cloud, local, layer } = tiers();
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				return yield* Effect.flip(
					complete(model, context, { metadata: constraintsToMetadata({ classification: "secret" }) }),
				);
			}).pipe(Effect.provide(layer)),
		);
		expect(error._tag).toBe("ModelRequestError");
		expect(error.message).toBe('No route of alias "fast" may serve content classified "secret" in any region');
		expect([error.response.provider, error.response.model, error.response.stopReason]).toEqual([
			"router",
			"fast",
			"error",
		]);
		expect([open.state.callCount, cloud.state.callCount, local.state.callCount]).toEqual([0, 0, 0]);
	});

	it("ends in pi-ai's error for constraints it cannot read, never with a default route", async () => {
		const { open, layer } = tiers();
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				return yield* Effect.flip(
					complete(model, context, { metadata: { "pi-router": { classification: "topsecret" } } }),
				);
			}).pipe(Effect.provide(layer)),
		);
		expect(error.message).toBe(
			'The constraints of a request to alias "fast" are not usable: "topsecret" is not a classification of the route table',
		);
		expect(open.state.callCount).toBe(0);
	});

	it("aborts the route's provider request when the caller is interrupted, and records it", async () => {
		const { open, layer } = tiers();
		const pending = hanging();
		open.setResponses([pending.response]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const recorded = yield* (yield* RouteEvents).subscribe;
					const model = yield* getModel({ provider: "router", modelId: "fast" });
					const fiber = yield* Effect.forkChild(complete(model, context));
					const signal = yield* Effect.promise(() => pending.signal);
					const abortedBefore = signal?.aborted;
					yield* Fiber.interrupt(fiber);
					const events = yield* Stream.runCollect(Stream.take(recorded, 1));
					return { signal, abortedBefore, outcomes: events.map((event) => event.outcome) };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(result.abortedBefore).toBe(false);
		expect(result.signal?.aborted).toBe(true);
		expect(result.outcomes).toEqual(["aborted"]);
	});
});

describe("the product's constraint source", () => {
	/** The tiers, with a source that answers by pi-ai session from `bySession`. */
	function sourced(constraintsOf: ConstraintSourceService["constraintsOf"]) {
		const world = tiers();
		return { ...world, layer: Layer.provide(world.layer, Layer.succeed(ConstraintSource, { constraintsOf })) };
	}

	it("constrains each conversation by its own state: the session of a request chooses its routes", async () => {
		const bySession = new Map<string, Constraints>([
			["session-public", { classification: "public" }],
			["session-internal", { classification: "internal" }],
			["session-eu", { classification: "public", regions: ["eu"] }],
		]);
		const asked: ConstraintRequest[] = [];
		const { open, cloud, layer } = sourced((request) =>
			Effect.sync(() => {
				asked.push(request);
				return bySession.get(request.sessionId ?? "") ?? {};
			}),
		);
		open.setResponses([fauxAssistantMessage("from open")]);
		cloud.setResponses([fauxAssistantMessage("from cloud"), fauxAssistantMessage("from cloud again")]);
		const served = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* Models;
				const model = yield* getModel({ provider: "router", modelId: "author" });
				// One harness: every conversation's request carries the same metadata, and its own session.
				const metadata = { user_id: "u1", ...constraintsToMetadata({ classification: "public" }) };
				const ask = (sessionId: string) =>
					Effect.promise(() => models.completeSimple(model, context, { sessionId, metadata })).pipe(
						Effect.map((message) => message.provider),
					);
				return [yield* ask("session-public"), yield* ask("session-internal"), yield* ask("session-eu")];
			}).pipe(Effect.provide(layer)),
		);
		expect(served).toEqual(["open", "cloud", "cloud"]);
		// The source is asked once per request, with what reached the router: the caller's metadata, whole.
		expect(asked).toEqual(
			["session-public", "session-internal", "session-eu"].map((sessionId) => ({
				alias: "author",
				sessionId,
				metadata: { user_id: "u1", "pi-router": { classification: "public" } },
			})),
		);
	});

	it("never widens what a request says: a request stricter than the source keeps its own classification", async () => {
		const { open, cloud, local, layer } = sourced(() => Effect.succeed({ classification: "internal" }));
		local.setResponses([fauxAssistantMessage("from local")]);
		const provider = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				return (yield* router.complete("author", context, { constraints: { classification: "secret" } })).provider;
			}).pipe(Effect.provide(layer)),
		);
		expect(provider).toBe("local");
		expect([open.state.callCount, cloud.state.callCount]).toEqual([0, 0]);
	});

	it("refuses a request it cannot answer for, with a typed error Pi does not retry, and sends nothing", async () => {
		const failure = new ConstraintsUnavailable({ alias: "fast", reason: "no grant: 503 overloaded" });
		const { open, cloud, layer } = sourced(() => Effect.fail(failure));
		const result = await runTest(
			Effect.gen(function* () {
				const recorded = yield* (yield* RouteEvents).subscribe;
				const router = yield* Router;
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				const typed = yield* Effect.flip(router.complete("fast", context));
				const throughPi = yield* Effect.flip(complete(model, context, { sessionId: "session-7" }));
				const first = yield* Effect.forkChild(Effect.timeoutOption(Stream.runHead(recorded), "1 hour"), {
					startImmediately: true,
				});
				yield* TestClock.adjust("1 hour");
				return { typed, throughPi, events: yield* Fiber.join(first) };
			}).pipe(Effect.provide(layer)),
		);
		expect(result.typed).toBe(failure);
		expect(result.throughPi._tag).toBe("ModelRequestError");
		expect(result.throughPi.message).toBe(
			'The constraints of a request to alias "fast" are not known, so it was not sent to any route',
		);
		expect([result.throughPi.response.provider, result.throughPi.response.stopReason]).toEqual(["router", "error"]);
		expect(isRetryableAssistantError(result.throughPi.response)).toBe(false);
		// No route was tried: no provider request and no route event.
		expect([open.state.callCount, cloud.state.callCount]).toEqual([0, 0]);
		expect(Option.isNone(result.events)).toBe(true);
	});

	it("refuses a request when the source dies, the same way", async () => {
		const { open, layer } = sourced(() => Effect.die(new Error("connection timed out")));
		const error = await Effect.runPromise(
			Effect.flip(Router.use((router) => router.complete("fast", context))).pipe(Effect.provide(layer)),
		);
		expect(error).toMatchObject({
			_tag: "ConstraintsUnavailable",
			alias: "fast",
			reason: "the constraint source died: connection timed out",
		});
		expect(open.state.callCount).toBe(0);
	});

	it("fails the request for a classification the table does not list", async () => {
		const { open, layer } = sourced(() => Effect.succeed({ classification: "topsecret" }));
		const error = await Effect.runPromise(
			Effect.flip(Router.use((router) => router.complete("fast", context))).pipe(Effect.provide(layer)),
		);
		expect(error).toMatchObject({
			_tag: "InvalidConstraints",
			reason: '"topsecret" is not a classification of the route table',
		});
		expect(open.state.callCount).toBe(0);
	});

	it("is not asked by Router.resolve, which has no request", async () => {
		const { layer } = sourced(() => Effect.die(new Error("never asked")));
		const routes = await Effect.runPromise(
			Router.use((router) => router.resolve("fast")).pipe(Effect.provide(layer)),
		);
		expect(routes.map((entry) => entry.provider)).toEqual(["open", "cloud"]);
	});
});

describe("a request that requires labels", () => {
	it("is served only by a route that carries them, through pi-ai's metadata and as an option", async () => {
		const plain = scripted("plain");
		const kept = scripted("kept");
		kept.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const routes = table([
			{
				alias: "fast",
				defaults: { classification: "public" },
				routes: [route("plain"), route("kept", { labels: ["zero-data-retention"] })],
			},
		]);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				const requires = ["zero-data-retention"];
				const viaPi = yield* complete(model, context, { metadata: constraintsToMetadata({ requires }) });
				const direct = yield* router.complete("fast", context, { constraints: { requires } });
				const none = yield* Effect.flip(router.complete("fast", context, { constraints: { requires: ["batch"] } }));
				return { served: [viaPi.provider, direct.provider], none };
			}).pipe(Effect.provide(routed(routes, [plain, kept]))),
		);
		expect(result.served).toEqual(["kept", "kept"]);
		expect(plain.state.callCount).toBe(0);
		expect(result.none).toMatchObject({
			_tag: "NoRouteAvailable",
			requires: ["batch"],
			excluded: [
				{ provider: "plain", model: "m", reason: "label", missing: ["batch"] },
				{ provider: "kept", model: "m", reason: "label", missing: ["batch"] },
			],
		});
	});
});

describe("Router.resolve", () => {
	it("gives the routes of the router's table that may serve, or the typed reason none may", async () => {
		const { layer } = tiers();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				return {
					routes: (yield* router.resolve("author", { classification: "internal" })).map((entry) => entry.provider),
					none: yield* Effect.flip(router.resolve("author", { classification: "secret", regions: ["us"] })),
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(result.routes).toEqual(["cloud", "local"]);
		expect(result.none._tag).toBe("NoRouteAvailable");
	});
});

describe("Router.stream and Router.complete", () => {
	it("stream the events of the route that answers and take constraints as an option", async () => {
		const { cloud, layer } = tiers();
		cloud.setResponses([fauxAssistantMessage("Hello world"), fauxAssistantMessage("again")]);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				const constraints = { classification: "internal" };
				const events = yield* Stream.runCollect(router.stream("author", context, { constraints }));
				// The option wins over what the metadata says.
				const metadata = constraintsToMetadata({ classification: "secret" });
				const message = yield* router.complete("author", context, { constraints, metadata });
				return { events: events.map(label), provider: message.provider };
			}).pipe(Effect.provide(layer)),
		);
		expect(result.events).toEqual([
			"start",
			"text_start",
			"text_delta Hell",
			"text_delta o wo",
			"text_delta rld",
			"text_end",
			"done stop",
		]);
		expect(result.provider).toBe("cloud");
	});

	it("fail with the typed reason no route served", async () => {
		const { layer } = tiers();
		const errors = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				return {
					alias: yield* Effect.flip(router.complete("nope", context)),
					none: yield* Effect.flip(router.complete("fast", context, { constraints: { regions: ["jp"] } })),
					label: yield* Effect.flip(
						Stream.runDrain(router.stream("fast", context, { constraints: { classification: "x" } })),
					),
					metadata: yield* Effect.flip(router.complete("fast", context, { metadata: { "pi-router": 7 } })),
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(errors.alias._tag).toBe("UnknownAlias");
		expect(errors.none._tag).toBe("NoRouteAvailable");
		expect(errors.none).toMatchObject({
			alias: "fast",
			classification: "public",
			regions: ["jp"],
			excluded: [
				{ provider: "open", model: "m", reason: "region" },
				{ provider: "cloud", model: "m", reason: "region" },
			],
		});
		expect(errors.label._tag).toBe("InvalidConstraints");
		expect(errors.metadata._tag).toBe("InvalidConstraints");
	});

	it("fail with RoutesExhausted when every route failed, with both attempts on record in order", async () => {
		const { open, cloud, layer } = tiers();
		open.setResponses([failing("overloaded")]);
		cloud.setResponses([failing("503 Service Unavailable")]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const recorded = yield* (yield* RouteEvents).subscribe;
					const error = yield* Effect.flip((yield* Router).complete("fast", context));
					return { error, recorded: yield* Stream.runCollect(Stream.take(recorded, 2)) };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(result.error._tag).toBe("RoutesExhausted");
		expect(result.error.message).toBe(
			'Every route of alias "fast" failed: open/m: overloaded; cloud/m: 503 Service Unavailable',
		);
		expect(
			result.recorded.map((event) => [event.attempt, event.route.provider, event.outcome, event.fallback]),
		).toEqual([
			[1, "open", "failed", true],
			[2, "cloud", "failed", false],
		]);
	});

	it("number the requests of a router, so the attempts of one request can be told from another's", async () => {
		const { open, cloud, layer } = tiers();
		open.setResponses([failing("overloaded"), fauxAssistantMessage("second")]);
		cloud.setResponses([fauxAssistantMessage("first")]);
		const recorded = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* (yield* RouteEvents).subscribe;
					const router = yield* Router;
					yield* router.complete("fast", context);
					yield* router.complete("fast", context);
					return yield* Stream.runCollect(Stream.take(events, 3));
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(recorded.map((event) => [event.request, event.attempt, event.route.provider, event.outcome])).toEqual([
			[1, 1, "open", "failed"],
			[1, 2, "cloud", "served"],
			[2, 1, "open", "served"],
		]);
	});

	it("give each request an id its attempts share, that no other request has, of this router or another", async () => {
		const ids = () => {
			const { open, cloud, layer } = tiers();
			open.setResponses([failing("overloaded"), fauxAssistantMessage("second")]);
			cloud.setResponses([fauxAssistantMessage("first")]);
			return Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const events = yield* (yield* RouteEvents).subscribe;
						const router = yield* Router;
						const model = yield* getModel({ provider: "router", modelId: "fast" });
						yield* router.complete("fast", context, { sessionId: "session-7" });
						// Through pi-ai, as a harness asks, and without a session.
						yield* complete(model, context);
						const recorded = yield* Stream.runCollect(Stream.take(events, 3));
						return recorded.map((event) => [event.requestId, event.sessionId, event.attempt] as const);
					}),
				).pipe(Effect.provide(layer)),
			);
		};
		const [first, again] = [await ids(), await ids()];
		const [failed, served, second] = first;
		expect(first.map(([, sessionId, attempt]) => [sessionId, attempt])).toEqual([
			["session-7", 1],
			["session-7", 2],
			[undefined, 1],
		]);
		expect(served[0]).toBe(failed[0]);
		expect(second[0]).not.toBe(failed[0]);
		// The id ends in the request's number, after what tells this router from every other.
		expect(failed[0]).toMatch(/^[0-9a-z]+-1$/);
		expect(second[0]).toMatch(/^[0-9a-z]+-2$/);
		// Another router, as after a restart, counts from one again and still shares no id with the first.
		expect(again.map(([id]) => id).filter((id) => first.some(([known]) => known === id))).toEqual([]);
	});

	it("give a request with a session the key of what it asks: every send of it has that key, in this router or a later one", async () => {
		// The context as Pi builds it again from storage: equal, but every object made anew, its keys in another order.
		const rebuilt: typeof context = { messages: [{ timestamp: 1, content: "hi", role: "user" }] };
		const more: typeof context = {
			messages: [...context.messages, { role: "user", content: "and more", timestamp: 2 }],
		};
		const keys = (sends: ReadonlyArray<readonly [typeof context, string | undefined]>) => {
			const { open, cloud, layer } = tiers();
			// The first send fails on its first route, which the second takes over: two attempts of one request.
			open.setResponses([failing("overloaded"), ...sends.slice(1).map(() => fauxAssistantMessage("fine"))]);
			cloud.setResponses([fauxAssistantMessage("first")]);
			return Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const events = yield* (yield* RouteEvents).subscribe;
						const model = yield* getModel({ provider: "router", modelId: "fast" });
						for (const [asked, sessionId] of sends) {
							yield* complete(model, asked, sessionId === undefined ? {} : { sessionId });
						}
						const recorded = yield* Stream.runCollect(Stream.take(events, sends.length + 1));
						return recorded.map((event) => [event.requestId, event.requestKey] as const);
					}),
				).pipe(Effect.provide(layer)),
			);
		};
		const first = await keys([
			[context, "session-7"],
			[rebuilt, "session-7"],
			[more, "session-7"],
			[context, "session-8"],
			[context, undefined],
		]);
		const [failed, served, resent, asksMore, otherSession, noSession] = first;
		// Both attempts of the request, and the request sent again, have its key: a SHA-256 in hexadecimal.
		expect(failed?.[1]).toMatch(/^[0-9a-f]{64}$/);
		expect([served?.[1], resent?.[1]]).toEqual([failed?.[1], failed?.[1]]);
		// The request id still names each send: the resent request is a request of its own.
		expect(resent?.[0]).not.toBe(failed?.[0]);
		// A request that asks more, and one of another conversation, have keys of their own; one without a session none.
		expect(new Set([failed?.[1], asksMore?.[1], otherSession?.[1]]).size).toBe(3);
		expect(noSession?.[1]).toBeUndefined();
		// Another router, as in the process that sends the request again after a crash, makes the same key of it.
		const later = await keys([[rebuilt, "session-7"]]);
		expect(later[0]?.[1]).toBe(failed?.[1]);
	});

	it("abort the provider request when the Stream ends early", async () => {
		const { open, layer } = tiers();
		let signal: AbortSignal | undefined;
		open.setResponses([
			(_context, options) => {
				signal = options?.signal;
				return fauxAssistantMessage("Hello world, this is a long answer");
			},
		]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const recorded = yield* (yield* RouteEvents).subscribe;
					const router = yield* Router;
					const events = yield* Stream.runCollect(Stream.take(router.stream("fast", context), 3));
					const outcomes = yield* Stream.runCollect(Stream.take(recorded, 1));
					return { events: events.map(label), outcomes: outcomes.map((event) => event.outcome) };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(result.events).toEqual(["start", "text_start", "text_delta Hell"]);
		expect(signal?.aborted).toBe(true);
		expect(result.outcomes).toEqual(["aborted"]);
	});
});

describe("OpenRouter", () => {
	it("is a provider a table can name: a route to pi-ai's own provider validates, with no request made", async () => {
		const openrouter = openrouterProvider();
		const model = openrouter.getModels()[0];
		const routes = table([{ alias: "fast", routes: [route("openrouter", { model: model.id })] }]);
		const valid = await Effect.runPromise(
			validateRouteTable(routes).pipe(Effect.provide(Models.layer([openrouter]))),
		);
		expect(valid.aliases[0].models).toEqual([model]);
		expect(model.provider).toBe("openrouter");
	});

	it("is routed side by side with an effect/ai model: one fails over to the other", async () => {
		// Scripted stand-ins under the ids a product would use: pi-ai's OpenRouter provider, and an EffectProvider
		// such as one over @effect/ai-openrouter.
		const openrouter = scripted("openrouter");
		openrouter.setResponses([failing("Provider returned error"), fauxAssistantMessage("from pi-ai's OpenRouter")]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const effect = yield* EffectProvider.make({
						id: "effect-openrouter",
						models: [{ id: "m", contextWindow: 100_000, maxTokens: 4_000 }],
						layer: ScriptedLanguageModel.layer([
							Effect.succeed([
								{ type: "text", text: "from effect/ai" },
								{
									type: "finish",
									reason: "stop",
									usage: { inputTokens: { total: 10 }, outputTokens: { total: 4 } },
								},
							]),
						]),
					});
					const routes = table([
						{
							alias: "fast",
							defaults: { classification: "public" },
							routes: [
								route("openrouter"),
								route("effect-openrouter", { price: { ...PRICE, output: 1_000_000 } }),
							],
						},
					]);
					const layer = Router.layer(routes).pipe(Layer.provideMerge(Models.layer([openrouter.provider, effect])));
					return yield* Effect.gen(function* () {
						const recorded = yield* (yield* RouteEvents).subscribe;
						const model = yield* getModel({ provider: "router", modelId: "fast" });
						// The first request falls back to the effect/ai model; the second is served by OpenRouter.
						const first = yield* complete(model, context);
						const second = yield* complete(model, context);
						return { model, first, second, recorded: yield* Stream.runCollect(Stream.take(recorded, 3)) };
					}).pipe(Effect.provide(layer));
				}),
			),
		);
		expect([result.first.provider, result.first.content]).toEqual([
			"effect-openrouter",
			[{ type: "text", text: "from effect/ai" }],
		]);
		expect([result.second.provider, result.second.content]).toEqual([
			"openrouter",
			[{ type: "text", text: "from pi-ai's OpenRouter" }],
		]);
		// The alias promises the smaller context window of its two routes.
		expect([result.model.contextWindow, result.model.maxTokens]).toEqual([100_000, 4_000]);
		expect(result.recorded.map(summary)).toEqual([
			{
				request: 1,
				attempt: 1,
				route: "openrouter/m",
				outcome: "failed",
				fallback: true,
				errorMessage: "Provider returned error",
				usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
				micros: 6n,
			},
			{
				request: 1,
				attempt: 2,
				route: "effect-openrouter/m",
				outcome: "served",
				fallback: false,
				errorMessage: undefined,
				// At the second route's own price: 10 x 3.0 + 4 x 1.0 micro units.
				usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
				micros: 34n,
			},
			{
				request: 2,
				attempt: 1,
				route: "openrouter/m",
				outcome: "served",
				fallback: false,
				errorMessage: undefined,
				// "from pi-ai's OpenRouter" is 23 characters: 6 tokens. 2 x 3.0 + 6 x 15.0 micro units.
				usage: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
				micros: 96n,
			},
		]);
	});
});

describe("the product's settlement of an attempt another route takes over", () => {
	/** The tiers, with `settle` as the settlement the router is built with. */
	function settled(settle: AttemptSettlementService["settle"]) {
		const world = tiers();
		return { ...world, layer: Layer.provide(world.layer, Layer.succeed(AttemptSettlement, { settle })) };
	}

	it("is the one the router was built with, for a pi-ai request and for Router.complete, whatever the caller holds", async () => {
		const handed: RouteEvent[] = [];
		const { open, cloud, layer } = settled((event) =>
			Effect.sync(() => {
				handed.push(event);
			}),
		);
		open.setResponses([failing("overloaded"), failing("overloaded")]);
		cloud.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const served = await Effect.runPromise(
			Effect.gen(function* () {
				const router = yield* Router;
				const model = yield* getModel({ provider: "router", modelId: "fast" });
				// Through pi-ai, as a harness asks, and directly: the caller's own settlement is never asked.
				const viaPi = yield* complete(model, context, { sessionId: "session-7" });
				const direct = yield* router
					.complete("fast", context)
					.pipe(Effect.provideService(AttemptSettlement, { settle: () => Effect.die(new Error("never asked")) }));
				return [viaPi.provider, direct.provider];
			}).pipe(Effect.provide(layer)),
		);
		expect(served).toEqual(["cloud", "cloud"]);
		expect(
			handed.map((event) => [event.request, event.sessionId, event.attempt, event.route.provider, event.fallback]),
		).toEqual([
			[1, "session-7", 1, "open", true],
			[2, undefined, 1, "open", true],
		]);
	});

	it("ends a pi-ai request in an error Pi does not retry, with the usage of the attempt it could not settle", async () => {
		const { open, cloud, layer } = settled(() => Effect.fail(new Error("the lease is fenced: 503 overloaded")));
		open.setResponses([failing("overloaded")]);
		cloud.setResponses([fauxAssistantMessage("never")]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const recorded = yield* (yield* RouteEvents).subscribe;
					const model = yield* getModel({ provider: "router", modelId: "fast" });
					const error = yield* Effect.flip(complete(model, context));
					return { error, recorded: yield* Stream.runCollect(Stream.take(recorded, 1)) };
				}),
			).pipe(Effect.provide(layer)),
		);
		const { response } = result.error;
		expect(result.error._tag).toBe("ModelRequestError");
		expect(response.errorMessage).toBe(
			'Attempt 1 of a request to alias "fast" could not be settled, so no other route was tried',
		);
		expect(isRetryableAssistantError(response)).toBe(false);
		// The message is the failed route's own, under the router's text: it names the route and has what it used, so
		// a budget around the router settles this attempt with the request it belongs to.
		expect([response.provider, response.model, response.stopReason]).toEqual(["open", "m", "error"]);
		expect([response.usage.input, response.usage.output]).toEqual([2, 0]);
		expect(cloud.state.callCount).toBe(0);
		expect(result.recorded.map((event) => [event.attempt, event.outcome, event.fallback])).toEqual([
			[1, "failed", false],
		]);
	});

	it("ends Router.complete with the typed error that names the attempt", async () => {
		const { open, cloud, layer } = settled(() => Effect.fail(new Error("the lease is fenced")));
		open.setResponses([failing("overloaded")]);
		const error = await Effect.runPromise(
			Effect.flip(Router.use((router) => router.complete("fast", context))).pipe(Effect.provide(layer)),
		);
		expect(error).toMatchObject({
			_tag: "AttemptUnsettled",
			alias: "fast",
			attempt: 1,
			provider: "open",
			model: "m",
			reason: "the lease is fenced",
		});
		expect(error._tag === "AttemptUnsettled" && error.requestId).toMatch(/^[0-9a-z]+-1$/);
		expect(cloud.state.callCount).toBe(0);
	});
});
