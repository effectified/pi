import {
	type Api,
	type AssistantMessage,
	type ClassifierModel,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type ImageModel,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
	type MutableModels,
	type Provider,
	type Usage,
} from "@earendil-works/pi-ai";
import { complete, ModelRequestError, Models, stream } from "@effectified/pi-ai";
import { fauxAssistantMessage, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { BudgetedModels, Estimator, type ModelPrice, Prices, refusalOf } from "../src/index.ts";
import {
	type Budgeted,
	budgetedHarness,
	budgetedModels,
	ESTIMATE,
	expectedCost,
	PRICE,
	prices,
	root,
	TestLease,
	withEvents,
} from "./support.ts";

const HELLO = { messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }] };

/** Runs a test body on budgeted models over a scripted provider, whose table also lists `more`, on the test clock. */
const run = <A, E>(body: Effect.Effect<A, E, Budgeted | TestClock.TestClock>, more: ReadonlyArray<ModelPrice> = []) =>
	runTest(Effect.provide(body, budgetedModels({ prices: more })));

/** A chat model of a provider of this file. */
const UNREACHABLE: Model<Api> = {
	id: "unreachable-1",
	name: "Unreachable",
	api: "unreachable",
	provider: "unreachable",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

/** A provider whose requests fail before anything is sent: pi-ai ends them in an error without usage. */
function unreachableProvider(): Provider {
	const fail = (): never => {
		throw new Error("no route to host");
	};
	return createProvider({
		id: UNREACHABLE.provider,
		auth: { apiKey: { name: "none", resolve: () => Promise.resolve({ auth: {} }) } },
		models: [UNREACHABLE],
		api: { stream: fail, streamSimple: fail },
	});
}

/** A `Models` that breaks pi-ai's protocol: its responses end without a `done` or an `error` event. */
function brokenModels(): MutableModels {
	const models = createModels();
	models.setProvider(unreachableProvider());
	const silent = () => {
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => events.end());
		return events;
	};
	return Object.assign(models, { stream: silent, streamSimple: silent });
}

describe("a request that returns", () => {
	it("reserves before the provider sees it and settles after, at the exact cost of its usage", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([
					() => {
						lease.steps.push({ step: "provider" });
						return fauxAssistantMessage("Hi there");
					},
				]);
				const message = yield* complete(scripted.model, HELLO);
				// The scripted provider counts four characters a token: "user:Hello" is 3, "Hi there" is 2.
				expect(message.usage).toMatchObject({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
				const request = { kind: "chat", provider: scripted.model.provider, model: scripted.model.id };
				expect(lease.steps).toEqual([
					{ step: "reserve", token: "r1", estimate: ESTIMATE, request },
					{ step: "provider" },
					{
						step: "settle",
						token: "r1",
						settlement: {
							usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
							// 3 * 1.500001 + 2 * 15 = 34.500003 micro units, rounded up once.
							cost: 35n,
							outcome: "returned",
						},
					},
				]);
				expect(expectedCost(message.usage)).toBe(35n);
			}),
		));

	it("hands the provider's events on unchanged, the last one after the settlement", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([fauxAssistantMessage("Hi there")]);
				const seen: string[] = [];
				yield* Stream.runForEach(stream(scripted.model, HELLO), (event) =>
					Effect.sync(() => {
						seen.push(`${event.type}:${lease.steps.length}`);
					}),
				);
				// One step (the reservation) while the response streams, two (with the settlement) at `done`.
				expect(seen[0]).toBe("start:1");
				expect(seen.at(-1)).toBe("done:2");
				expect(seen.filter((entry) => entry.startsWith("text_delta")).length).toBeGreaterThan(0);
			}),
		));

	it("publishes the reservation and the settlement, with amounts and no content", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				yield* scripted.setResponses([fauxAssistantMessage("Hi there")]);
				const [, events] = yield* withEvents(2, complete(scripted.model, HELLO));
				const request = { kind: "chat", provider: scripted.model.provider, model: scripted.model.id };
				expect(events.map(({ at: _at, ...event }) => event)).toEqual([
					{ _tag: "Reserved", request, reservation: "r1", estimate: ESTIMATE, currency: "USD" },
					{
						_tag: "Settled",
						request,
						reservation: "r1",
						estimate: ESTIMATE,
						usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
						cost: 35n,
						outcome: "returned",
						currency: "USD",
					},
				]);
				expect(
					JSON.stringify(events, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
				).not.toMatch(/Hello|Hi there/);
			}),
		));

	it("holds a request that names a session until the shares are attached to a harness", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([fauxAssistantMessage("Hi there")]);
				// No harness is attached here: the budget cannot know the session's share yet, so nothing is sent.
				const fiber = yield* Effect.forkChild(complete(scripted.model, HELLO, { sessionId: "session-1" }), {
					startImmediately: true,
				});
				// No time releases it.
				yield* TestClock.adjust("1 hour");
				expect(lease.steps).toEqual([]);
				expect(yield* scripted.callCount).toBe(0);
				yield* Fiber.interrupt(fiber);
				expect(lease.steps).toEqual([]);
			}),
		));
});

describe("a request that is sent again", () => {
	/** Budgeted models without shares: a request that names a session is sent at once. */
	const unshared = () =>
		BudgetedModels.layer.pipe(
			Layer.provideMerge(Layer.mergeAll(TestLease.layer, Estimator.fixed(ESTIMATE))),
			Layer.provide(prices()),
			Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })),
		);
	/** The `requestKey` of each reservation the lease was asked for, in order, after `sends` were made. */
	const keys = (sends: ReadonlyArray<readonly [typeof HELLO, string | undefined]>) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses(sends.map(() => fauxAssistantMessage("Hi there")));
				for (const [asked, sessionId] of sends) {
					yield* complete(scripted.model, asked, sessionId === undefined ? {} : { sessionId });
				}
				return lease.steps.flatMap((step) => (step.step === "reserve" ? [step.request.requestKey] : []));
			}).pipe(Effect.provide(unshared())),
		);

	it("is reserved under the key of what it asks: every send of it has that key, also in a later process", async () => {
		// The context as Pi builds it again from storage: equal, but made anew, its keys in another order.
		const rebuilt = { messages: [{ timestamp: 0, content: "Hello", role: "user" as const }] };
		const more = { messages: [...HELLO.messages, { role: "user" as const, content: "And more", timestamp: 1 }] };
		const [sent, resent, asksMore, otherSession, noSession] = await keys([
			[HELLO, "session-1"],
			[rebuilt, "session-1"],
			[more, "session-1"],
			[HELLO, "session-2"],
			[HELLO, undefined],
		]);
		expect(sent).toMatch(/^[0-9a-f]{64}$/);
		expect(resent).toBe(sent);
		// A request that asks more, and one of another conversation, have keys of their own; one without a session none.
		expect(new Set([sent, asksMore, otherSession]).size).toBe(3);
		expect(noSession).toBeUndefined();
		// The budget of another process, as after a crash, makes the same key of the same request.
		expect(await keys([[rebuilt, "session-1"]])).toEqual([sent]);
	});

	it("is reserved under the key of the send that failed when Pi retries it after a provider error", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([
					fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
					fauxAssistantMessage("Hi there"),
				]);
				const conversation = yield* root;
				yield* conversation.submit({ type: "input", content: "Hello", requestId: "run" });
				yield* conversation.waitForIdle;
				const reserved = lease.steps.flatMap((step) => (step.step === "reserve" ? [step.request] : []));
				// Pi keeps the failed answer as an entry and leaves it out of what it sends: the retry asks the same,
				// and only the lease's own record (the first reservation is settled) tells it from a resend.
				expect(reserved.map((request) => request.session)).toEqual([reserved[0]?.session, reserved[0]?.session]);
				expect(reserved[0]?.requestKey).toMatch(/^[0-9a-f]{64}$/);
				expect(reserved[1]?.requestKey).toBe(reserved[0]?.requestKey);
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle", "reserve", "settle"]);
			}).pipe(Effect.provide(budgetedHarness({ harness: { settings: { retry: { baseDelayMs: 1 } } } }))),
		));
});

describe("a request the provider fails", () => {
	it("settles the usage the provider reported, as failed, and ends as the provider ended it", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([
					fauxAssistantMessage("Half an ans", { stopReason: "error", errorMessage: "boom" }),
				]);
				const error = yield* Effect.flip(complete(scripted.model, HELLO));
				expect(error).toBeInstanceOf(ModelRequestError);
				expect(error.reason).toBe("error");
				expect(error.response.errorMessage).toBe("boom");
				// "Half an ans" is 11 characters: 3 tokens of output the provider billed before it failed.
				expect(error.response.usage).toMatchObject({ input: 3, output: 3 });
				expect(lease.steps.slice(1)).toEqual([
					{
						step: "settle",
						token: "r1",
						settlement: {
							usage: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
							// 3 * 1.500001 + 3 * 15 = 49.500003.
							cost: 50n,
							outcome: "failed",
						},
					},
				]);
			}),
		));

	it("settles zero when the provider reported no usage", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const models = yield* Models;
				models.setProvider(unreachableProvider());
				const message = yield* Effect.promise(() => models.complete(UNREACHABLE, HELLO));
				expect(message.stopReason).toBe("error");
				expect(message.errorMessage).toBe("no route to host");
				expect(lease.steps.slice(1)).toEqual([
					{
						step: "settle",
						token: "r1",
						settlement: {
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							cost: 0n,
							outcome: "failed",
						},
					},
				]);
			}),
			[{ provider: UNREACHABLE.provider, model: UNREACHABLE.id, ...PRICE }],
		));

	it("settles a defect of the wrapped Models as failed, once", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const models = yield* Models;
				const message = yield* Effect.promise(() => models.complete(UNREACHABLE, HELLO));
				expect(message.stopReason).toBe("error");
				expect(message.errorMessage).toBe("pi-ai ended a response without a done or error event");
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				expect(lease.steps[1]).toMatchObject({ token: "r1", settlement: { cost: 0n, outcome: "failed" } });
			}).pipe(
				Effect.provide(
					BudgetedModels.layer.pipe(
						Layer.provideMerge(TestLease.layer),
						Layer.provide(Estimator.fixed(ESTIMATE)),
						Layer.provide(
							Layer.orDie(
								Prices.layer({
									currency: "USD",
									prices: [{ provider: UNREACHABLE.provider, model: UNREACHABLE.id, ...PRICE }],
								}),
							),
						),
						Layer.provide(Layer.sync(Models, brokenModels)),
					),
				),
			),
		));
});

describe("a request that is given up", () => {
	it("settles an abort by the caller as aborted, with the usage seen so far", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				const controller = new AbortController();
				const sent = Latch.makeUnsafe();
				yield* scripted.setResponses([
					(_context, options) =>
						new Promise<AssistantMessage>((resolve) => {
							options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("Never")), {
								once: true,
							});
							sent.openUnsafe();
						}),
				]);
				const events = models.stream(scripted.model, HELLO, { signal: controller.signal });
				yield* sent.await;
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve"]);
				controller.abort();
				const message = yield* Effect.promise(() => events.result());
				expect(message.stopReason).toBe("aborted");
				expect(message.errorMessage).toBe("Request was aborted");
				expect(lease.steps.slice(1)).toEqual([
					{
						step: "settle",
						token: "r1",
						settlement: {
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							cost: 0n,
							outcome: "aborted",
						},
					},
				]);
				expect(yield* scripted.callCount).toBe(1);
			}),
		));

	it("reserves nothing for a request that arrives aborted", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				yield* scripted.setResponses([fauxAssistantMessage("Never")]);
				const message = yield* Effect.promise(() =>
					models.complete(scripted.model, HELLO, { signal: AbortSignal.abort() }),
				);
				expect(message.stopReason).toBe("aborted");
				expect(lease.steps).toEqual([]);
				expect(yield* scripted.callCount).toBe(0);
			}),
		));

	it("settles an interrupted fiber as aborted and aborts the provider request", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				let aborted = false;
				const sent = Latch.makeUnsafe();
				yield* scripted.setResponses([
					(_context, options) =>
						new Promise<AssistantMessage>((resolve) => {
							options?.signal?.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve(fauxAssistantMessage("Never"));
								},
								{ once: true },
							);
							sent.openUnsafe();
						}),
				]);
				const fiber = yield* Effect.forkChild(complete(scripted.model, HELLO));
				yield* sent.await;
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve"]);
				const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
				expect(Exit.hasInterrupts(exit)).toBe(true);
				yield* lease.when(() => lease.steps.length === 2);
				expect(aborted).toBe(true);
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				expect(lease.steps[1]).toMatchObject({ token: "r1", settlement: { cost: 0n, outcome: "aborted" } });
			}),
		));

	it("settles the requests in flight when the scope of the Layer closes", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { lease, result } = yield* Effect.gen(function* () {
					const scripted = yield* ScriptedModels;
					const lease = yield* TestLease;
					const models = yield* Models;
					const sent = Latch.makeUnsafe();
					yield* scripted.setResponses([
						() => {
							sent.openUnsafe();
							return new Promise<AssistantMessage>(() => {});
						},
					]);
					const result = models.complete(scripted.model, HELLO);
					yield* sent.await;
					expect(lease.steps.map(({ step }) => step)).toEqual(["reserve"]);
					return { lease, result };
				}).pipe(Effect.provide(budgetedModels()), Effect.scoped);
				const message = yield* Effect.promise(() => result);
				expect(message.stopReason).toBe("aborted");
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				expect(lease.steps[1]).toMatchObject({ token: "r1", settlement: { outcome: "aborted" } });
			}),
		));
});

describe("a request that is refused", () => {
	it("lets nothing reach the provider on a fenced lease, with a typed reason Pi does not retry", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([fauxAssistantMessage("Never")]);
				// A reason that reads like errors pi-ai retries and compacts for.
				lease.fenced = "timeout 503 overloaded: prompt is too long";
				const request = { kind: "chat", provider: scripted.model.provider, model: scripted.model.id };
				const [error, events] = yield* withEvents(1, Effect.flip(complete(scripted.model, HELLO)));
				expect(error.reason).toBe("error");
				expect(error.response.usage).toMatchObject({ input: 0, output: 0 });
				expect(isRetryableAssistantError(error.response)).toBe(false);
				expect(isContextOverflow(error.response, scripted.model.contextWindow)).toBe(false);
				expect(error.response.errorMessage).toMatch(
					/^Budget: the lease is fenced, so the request was not sent\. \[budget:[0-9a-f]+\]$/,
				);
				const refusal = Option.getOrThrow(yield* refusalOf(error.response.errorMessage));
				expect(refusal).toMatchObject({
					_tag: "LeaseFenced",
					reason: "timeout 503 overloaded: prompt is too long",
				});
				expect(lease.steps).toEqual([{ step: "fenced", reason: "timeout 503 overloaded: prompt is too long" }]);
				expect(yield* scripted.callCount).toBe(0);
				expect(yield* scripted.pendingResponseCount).toBe(1);
				expect(events.map(({ at: _at, ...event }) => event)).toEqual([{ _tag: "Refused", request, refusal }]);
			}),
		));

	it("refuses a model without a price before the lease is asked", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				models.setProvider(unreachableProvider());
				const [message, events] = yield* withEvents(
					1,
					Effect.promise(() => models.complete(UNREACHABLE, HELLO)),
				);
				expect(message.stopReason).toBe("error");
				expect(isRetryableAssistantError(message)).toBe(false);
				const refusal = Option.getOrThrow(yield* refusalOf(message.errorMessage));
				expect(refusal).toMatchObject({ _tag: "PriceMissing", provider: "unreachable", model: "unreachable-1" });
				expect(lease.steps).toEqual([]);
				expect(events).toMatchObject([{ _tag: "Refused", refusal: { _tag: "PriceMissing" } }]);
				expect(yield* scripted.callCount).toBe(0);
			}),
		));

	it("sends nothing when the lease itself breaks", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([fauxAssistantMessage("Never")]);
				lease.broken = new Error("the ledger is unreachable");
				const error = yield* Effect.flip(complete(scripted.model, HELLO));
				expect(error.response.errorMessage).toBe("the ledger is unreachable");
				expect(lease.steps).toEqual([]);
				expect(yield* scripted.callCount).toBe(0);
			}),
		));
});

describe("a settlement that breaks", () => {
	it("is asked once, ends the request in an error, and publishes no settlement", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([fauxAssistantMessage("Hi there")]);
				lease.brokenSettle = new Error("the ledger is unreachable");
				const [error, events] = yield* withEvents(1, Effect.flip(complete(scripted.model, HELLO)));
				expect(error.response.errorMessage).toBe("the ledger is unreachable");
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				expect(events.map((event) => event._tag)).toEqual(["Reserved"]);
				expect(yield* scripted.callCount).toBe(1);
			}),
		));
});

describe("the other provider requests", () => {
	it("budgets a deferred response: the request that defers it, and each fetch of it", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				yield* scripted.setResponses([fauxAssistantMessage("Hi there")]);
				const deferred = yield* Effect.promise(() =>
					models.completeSimple(scripted.model, HELLO, { deferred: true }),
				);
				expect(deferred.stopReason).toBe("deferred");
				const handle = deferred.deferred;
				if (handle === undefined) throw new Error("a deferred handle");
				const message = yield* Effect.promise(() => models.fetchDeferred(scripted.model, handle));
				expect(message.stopReason).toBe("stop");
				expect(lease.steps.map((step) => (step.step === "reserve" ? step.request.kind : step.step))).toEqual([
					"chat",
					"settle",
					"deferred",
					"settle",
				]);
				// The provider reports the usage with the finished response, so the fetch is what costs.
				expect(lease.steps.flatMap((step) => (step.step === "settle" ? [step.settlement] : []))).toEqual([
					{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0n, outcome: "returned" },
					{ usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 35n, outcome: "returned" },
				]);

				lease.fenced = "expired";
				const refused = yield* Effect.promise(() => models.fetchDeferred(scripted.model, handle));
				expect(Option.getOrThrow(yield* refusalOf(refused.errorMessage))).toMatchObject({ _tag: "LeaseFenced" });
			}).pipe(Effect.provide(budgetedModels({ provider: { api: "scripted", deferred: { pendingFetches: 0 } } }))),
		));

	it("budgets image generation and classification, and refuses them as results that carry the refusal", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const models = yield* Models;
				models.setProvider(oneShotProvider());
				const images = yield* Effect.promise(() => models.generateImages(PAINTER, { input: [] }));
				const verdict = yield* Effect.promise(() => models.classify(JUDGE, { state: {}, questions: {} }));
				expect(images.stopReason).toBe("stop");
				expect(verdict.stopReason).toBe("error");
				expect(lease.steps).toEqual([
					{
						step: "reserve",
						token: "r1",
						estimate: ESTIMATE,
						request: { kind: "images", provider: "studio", model: "painter-1" },
					},
					{
						step: "settle",
						token: "r1",
						// 1000 * 1.500001 + 10 * 15 = 1650.001.
						settlement: {
							usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
							cost: 1651n,
							outcome: "returned",
						},
					},
					{
						step: "reserve",
						token: "r2",
						estimate: ESTIMATE,
						request: { kind: "classifier", provider: "studio", model: "judge-1" },
					},
					{
						step: "settle",
						token: "r2",
						// A result without usage settles zero; this one failed.
						settlement: {
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							cost: 0n,
							outcome: "failed",
						},
					},
				]);

				lease.fenced = "expired";
				const noImages = yield* Effect.promise(() => models.generateImages(PAINTER, { input: [] }));
				const noVerdict = yield* Effect.promise(() => models.classify(JUDGE, { state: {}, questions: {} }));
				expect(noImages).toMatchObject({ provider: "studio", model: "painter-1", output: [], stopReason: "error" });
				expect(noVerdict).toMatchObject({ provider: "studio", model: "judge-1", answers: {}, stopReason: "error" });
				expect(Option.getOrThrow(yield* refusalOf(noImages.errorMessage))).toMatchObject({ reason: "expired" });
				expect(Option.getOrThrow(yield* refusalOf(noVerdict.errorMessage))).toMatchObject({ reason: "expired" });
				expect(lease.steps.slice(4).map(({ step }) => step)).toEqual(["fenced", "fenced"]);
			}),
			[
				{ provider: "studio", model: "painter-1", ...PRICE },
				{ provider: "studio", model: "judge-1", ...PRICE },
			],
		));

	it("settles a response at the price of the model it names, when the table lists it", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				// A provider that routes: its response names the scripted model as the one that answered.
				models.setProvider(relayProvider(scripted.model));
				const message = yield* Effect.promise(() => models.complete(UNREACHABLE, HELLO));
				expect(message.provider).toBe(scripted.model.provider);
				expect(lease.steps[0]).toMatchObject({ request: { provider: "unreachable", model: "unreachable-1" } });
				// 1000 input tokens: 1501 at the scripted model's price, 1000 at the relay's own.
				expect(lease.steps[1]).toMatchObject({ settlement: { cost: 1501n, outcome: "returned" } });
			}),
			[RELAY_PRICE],
		));

	it("settles a request that was cut off at the price of the model that what arrived of it names", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const models = yield* Models;
				// A provider that routes, whose response starts, names the scripted model, and never ends.
				models.setProvider(relayProvider(scripted.model, "stalls"));
				const controller = new AbortController();
				const events = models.stream(UNREACHABLE, HELLO, { signal: controller.signal });
				// The response's start, with its usage, has passed the budget on its way to the caller.
				yield* Effect.promise(() => events[Symbol.asyncIterator]().next());
				controller.abort();
				const message = yield* Effect.promise(() => events.result());
				expect([message.stopReason, message.provider]).toEqual(["aborted", scripted.model.provider]);
				// 1000 input tokens had been reported: 1501 at the scripted model's price, not 1000 at the relay's.
				expect(lease.steps[1]).toMatchObject({
					settlement: { usage: { input: 1000, output: 0 }, cost: 1501n, outcome: "aborted" },
				});
			}),
			[RELAY_PRICE],
		));
});

/** The relay's own price, under the id a request to it is checked against: 1.0 micro units per input token. */
const RELAY_PRICE: ModelPrice = {
	provider: "unreachable",
	model: "unreachable-1",
	input: 1_000_000,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const PAINTER: ImageModel<string> = {
	type: "image",
	id: "painter-1",
	name: "Painter",
	api: "studio-images",
	provider: "studio",
	baseUrl: "http://localhost:0",
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const JUDGE: ClassifierModel<string> = {
	type: "classifier",
	id: "judge-1",
	name: "Judge",
	api: "studio-classifier",
	provider: "studio",
	baseUrl: "http://localhost:0",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
};

/** A provider of one image model, which reports usage, and one classifier, which fails without any. */
function oneShotProvider(): Provider {
	return createProvider({
		id: "studio",
		auth: { apiKey: { name: "none", resolve: () => Promise.resolve({ auth: {} }) } },
		models: [PAINTER, JUDGE],
		images: {
			"studio-images": {
				generateImages: (model) =>
					Promise.resolve({
						api: model.api,
						provider: model.provider,
						model: model.id,
						output: [],
						usage: usageOf(1000, 10),
						stopReason: "stop",
						timestamp: 0,
					}),
			},
		},
		classifiers: {
			"studio-classifier": {
				classify: (model) =>
					Promise.resolve({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {},
						stopReason: "error",
						errorMessage: "the judge is out",
						timestamp: 0,
					}),
			},
		},
	});
}

/**
 * A provider under the id of `UNREACHABLE` whose response says `served` answered, with 1000 input tokens. One that
 * `stalls` starts its response and never ends it.
 */
function relayProvider(served: Model<Api>, how: "answers" | "stalls" = "answers"): Provider {
	const respond = () => {
		const events = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			...fauxAssistantMessage("Relayed"),
			api: served.api,
			provider: served.provider,
			model: served.id,
			usage: usageOf(1000, 0),
		};
		queueMicrotask(() => {
			if (how === "stalls") return events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		});
		return events;
	};
	return createProvider({
		id: UNREACHABLE.provider,
		auth: { apiKey: { name: "none", resolve: () => Promise.resolve({ auth: {} }) } },
		models: [UNREACHABLE],
		api: { stream: respond, streamSimple: respond },
	});
}

function usageOf(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
