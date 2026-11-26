// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only
// the imports differ (the README names the packages, this file its sources and a stand-in for the router's port),
// and the model is scripted.

import { complete } from "@effectified/pi-ai";
import { Harness, Registry, Storage } from "@effectified/pi-durable";
import { answer, ScriptedModels } from "@effectified/pi-durable/testing";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	BudgetEvents,
	BudgetedModels,
	continueStopped,
	Estimator,
	Lease,
	LeaseFenced,
	Prices,
	type PriceTable,
	refusalOf,
	Shares,
	Spend,
	stopOf,
} from "../src/index.ts";

// README: the lease
/** A product's lease. This one is a wallet in memory; a real one is a row the product fences and renews. */
const wallet = { left: 1_000_000n, held: new Map<string, bigint>(), fenced: false };

const WalletLease = Layer.succeed(Lease, {
	reserve: (estimate, request) =>
		Effect.suspend(() => {
			if (wallet.fenced) return Effect.fail(new LeaseFenced({ reason: "fenced" }));
			if (wallet.left < estimate) return Effect.fail(new LeaseFenced({ reason: "out_of_money" }));
			const token = `${request.provider}/${request.model}#${wallet.held.size + 1}`;
			wallet.left -= estimate;
			wallet.held.set(token, estimate);
			return Effect.succeed(token);
		}),
	settle: (token, settlement) =>
		Effect.sync(() => {
			// The reservation goes back and the real cost comes off, whether the request returned, failed or was aborted.
			wallet.left += (wallet.held.get(token) ?? 0n) - settlement.cost;
			wallet.held.delete(token);
		}),
});

// README: prices and the estimate
const table: PriceTable = {
	currency: "USD",
	// Per million tokens, in millionths of the currency: USD 3.00 in, USD 15.00 out.
	prices: [
		{
			provider: "faux",
			model: "faux-1",
			input: 3_000_000,
			output: 15_000_000,
			cacheRead: 300_000,
			cacheWrite: 3_750_000,
		},
	],
};

// What the product sets aside for one request: here always 5 cents.
const estimate = Estimator.fixed(50_000n);

// README: compose
const budget = Layer.mergeAll(WalletLease, estimate, Layer.orDie(Prices.layer(table)));

// The `Models` of this Layer is the budgeted one. The providers go underneath it.
const budgeted = BudgetedModels.layerWithShares.pipe(
	Layer.provideMerge(Shares.layer),
	Layer.provide(budget),
	Layer.provideMerge(ScriptedModels.layer()), // with real providers: Layer.provide(Models.layer([anthropicProvider()]))
);

const live = Shares.attach.pipe(
	Layer.provideMerge(Harness.layer()),
	Layer.provideMerge(budgeted),
	Layer.provide(Layer.orDie(Registry.layer([]))),
	Layer.provide(Storage.memory),
);

/** The scripted model as an agent, for the conversations of the examples below. */
const agent = ScriptedModels.use(({ model }) =>
	Effect.succeed({ model: { provider: model.provider, modelId: model.id } }),
);

/** How many requests reached the scripted provider. */
const requests = ScriptedModels.use((scripted) => scripted.callCount);

// README: prices behind a router
// From the product's route table: `yield* priceRows(routes)` of @effectified/pi-router, written out.
const routerRows: PriceTable = {
	currency: "USD",
	prices: [
		// Each route's model at the route's price: what a response is settled at.
		{
			provider: "openrouter",
			model: "anthropic/claude-haiku-5.5",
			input: 1_000_000,
			output: 5_000_000,
			cacheRead: 100_000,
			cacheWrite: 1_250_000,
		},
		{ provider: "local", model: "qwen-3-coder", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Each alias at the highest price of its routes for each kind of token: what a request is checked against.
		{
			provider: "router",
			model: "author",
			input: 1_000_000,
			output: 5_000_000,
			cacheRead: 100_000,
			cacheWrite: 1_250_000,
		},
	],
};

const routerPrices = Prices.layer(routerRows);

/**
 * A stand-in for the settlement port of `@effectified/pi-router`, which this package does not import: the fields of
 * a `RouteEvent` the README's code reads, and a `Context.Reference` with the port's signature and its default.
 */
interface RouteEvent {
	readonly requestId: string;
	readonly sessionId?: string | undefined;
	readonly requestKey?: string | undefined;
	readonly attempt: number;
	readonly route: { readonly provider: string; readonly model: string };
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

const AttemptSettlement = Context.Reference<{
	readonly settle: (event: RouteEvent) => Effect.Effect<unknown, unknown>;
}>("test/AttemptSettlement", { defaultValue: () => ({ settle: () => Effect.void }) });

describe("the README", () => {
	it("a request reserves, is sent, and settles; the events say so", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = false;
		// README: events
		const program = Effect.gen(function* () {
			const scripted = yield* ScriptedModels;
			yield* scripted.setResponses([answer("Hello.")]);
			const events = yield* BudgetEvents.use((hub) => hub.subscribe);
			const message = yield* complete(scripted.model, {
				messages: [{ role: "user", content: "Hello", timestamp: 0 }],
			});
			const [reserved, settled] = yield* Stream.runCollect(Stream.take(events, 2));
			return { message, reserved, settled, left: wallet.left };
		}).pipe(Effect.scoped);

		const seen = await Effect.runPromise(Effect.provide(program, budgeted));
		expect(seen.message.stopReason).toBe("stop");
		expect(seen.reserved).toMatchObject({ _tag: "Reserved", estimate: 50_000n, currency: "USD" });
		// "user:Hello" is 3 tokens in and "Hello." 2 out for the scripted provider: 3 * 3 + 2 * 15 micro units.
		expect(seen.settled).toMatchObject({ _tag: "Settled", cost: 39n, outcome: "returned" });
		expect(seen.left).toBe(1_000_000n - 39n);
	});

	it("a fenced lease stops a conversation with a typed reason, and it continues under a new lease", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = true;
		// README: stop and continue
		const program = Effect.gen(function* () {
			const scripted = yield* ScriptedModels;
			yield* scripted.setResponses([answer("Hello.")]);
			const root = yield* Harness.rootWith({ agent: yield* agent });

			// The lease is fenced: the request is not sent, and the run ends without an answer.
			const settled = yield* root.prompt("Hello");
			// Both read what Pi stored, so they say the same after a restart.
			const fromSubmission = yield* refusalOf(settled.detail);
			const stop = yield* stopOf(root.id);

			// The product renews its lease, then continues the conversation where it stopped.
			wallet.fenced = false;
			const continued = yield* continueStopped(root);
			return { settled, fromSubmission, stop, answered: yield* continued.wait, requests: yield* scripted.callCount };
		});

		const seen = await Effect.runPromise(Effect.provide(program, live));
		expect(seen.settled).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(Option.getOrThrow(seen.fromSubmission)).toMatchObject({ _tag: "LeaseFenced", reason: "fenced" });
		expect(Option.getOrThrow(seen.stop).refusal).toMatchObject({ _tag: "LeaseFenced", reason: "fenced" });
		expect(Option.getOrThrow(seen.stop).inputs).toEqual([seen.settled.id]);
		expect(seen.answered).toMatchObject({ status: "done" });
		expect(seen.requests).toBe(1);
	});

	it("a conversation with a cap stops at it while the root goes on", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = false;
		// README: shares
		const program = Effect.gen(function* () {
			const scripted = yield* ScriptedModels;
			yield* scripted.setResponses([answer("One."), answer("Two."), answer("Three.")]);
			const shares = yield* Shares;
			const root = yield* Harness.rootWith({ agent: yield* agent });
			const child = yield* Harness.createConversation({ ownership: { kind: "ownerless" }, agent: yield* agent });

			// The child may spend 20 micro units of the harness's lease.
			yield* shares.setCap(child.id, 20n);
			const first = yield* child.prompt("First");
			const second = yield* child.prompt("Second");
			const stop = yield* stopOf(child.id);
			const rootAnswer = yield* root.prompt("Hello");
			return { first, second, stop, rootAnswer, share: yield* shares.get(child.id) };
		});

		const seen = await Effect.runPromise(Effect.provide(program, live));
		expect(seen.first).toMatchObject({ status: "done" });
		expect(seen.second).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(Option.getOrThrow(seen.stop).refusal).toMatchObject({ _tag: "ShareExhausted", cap: 20n });
		expect(seen.rootAnswer).toMatchObject({ status: "done" });
		expect(Option.getOrThrow(seen.share).settled).toBeGreaterThanOrEqual(20n);
	});

	it("decodes the price rows of a route table and prices a route's response and an alias's request with them", async () => {
		const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
		const costs = await Effect.runPromise(
			Prices.use((prices) =>
				Effect.all([
					prices.cost("openrouter", "anthropic/claude-haiku-5.5", usage),
					prices.cost("local", "qwen-3-coder", usage),
					prices.cost("router", "author", usage),
				]),
			).pipe(Effect.provide(routerPrices)),
		);
		// 1000 x 1.0 + 100 x 5.0 micro units for the paid route and for the alias; the local route is free.
		expect(costs).toEqual([1_500n, 0n, 1_500n]);
	});

	it("settles the attempt a router hands to its port, inside the request, and fails the port on a fenced lease", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = false;
		const usage = { input: 1200, output: 0, cacheRead: 300, cacheWrite: 0 };
		const route = { provider: "faux", model: "faux-1" };
		// What a router hands over, as plain data: the first attempt of a request, which failed after it used tokens
		// and which another route is taking over; and the first attempt of that conversation's next request.
		const first: RouteEvent = { requestId: "lz4k2q9xw-1", sessionId: "session-7", attempt: 1, route, usage };
		const second: RouteEvent = { ...first, requestId: "lz4k2q9xw-2" };

		// README: spend the budget did not see
		/** Charges each attempt another route takes over to the budget, before that route is tried. */
		const SettleAttempts = Layer.effect(
			AttemptSettlement,
			Effect.gen(function* () {
				const spend = yield* Spend;
				return AttemptSettlement.of({
					settle: (event) =>
						spend.record({
							key: `${event.requestId}#${event.attempt}`,
							provider: event.route.provider,
							model: event.route.model,
							session: event.sessionId,
							requestKey: event.requestKey,
							usage: event.usage,
							outcome: "failed",
						}),
				});
			}),
		);

		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scripted = yield* ScriptedModels;
					yield* scripted.setResponses([answer("Hello.")]);
					const published = yield* BudgetEvents.use((hub) => hub.subscribe);
					const port = yield* AttemptSettlement;
					// The router waits for the port before the route that takes over is tried: the failed attempt first,
					// then the response of the route that served, which the budgeted `Models` settles itself.
					yield* port.settle(first);
					const afterAttempt = wallet.left;
					yield* complete(scripted.model, { messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
					const afterRequest = wallet.left;
					// The same attempt told again charges nothing.
					yield* port.settle(first);
					const events = yield* Stream.runCollect(Stream.take(published, 4));

					// The lease is fenced when the next request's first attempt is handed over: the port fails, which is
					// what makes the router end that request with this attempt as its last.
					wallet.fenced = true;
					const refused = yield* Effect.flip(port.settle(second));
					const afterRefusal = wallet.left;
					// Nothing was recorded, so the key is unused: under a new lease the same attempt is charged.
					wallet.fenced = false;
					yield* port.settle(second);
					return { afterAttempt, afterRequest, events, refused, afterRefusal };
				}).pipe(Effect.provide(SettleAttempts)),
			).pipe(Effect.provide(live)),
		);
		// 1200 x 3.0 + 300 x 0.3 micro units at the table's price of the route's own model.
		expect(seen.afterAttempt).toBe(1_000_000n - 3_690n);
		// The response that served costs 39 micro units (see the first test): each attempt is charged once.
		expect(seen.afterRequest).toBe(1_000_000n - 3_690n - 39n);
		expect(seen.events).toMatchObject([
			{ _tag: "Reserved", estimate: 3_690n, request: { ...route, session: "session-7", key: "lz4k2q9xw-1#1" } },
			{ _tag: "Settled", cost: 3_690n, outcome: "failed", usage, request: { key: "lz4k2q9xw-1#1" } },
			{ _tag: "Reserved", estimate: 50_000n, request: route },
			{ _tag: "Settled", cost: 39n, outcome: "returned" },
		]);
		expect(seen.events[2]).not.toHaveProperty("request.key");
		expect(seen.refused).toEqual(new LeaseFenced({ reason: "fenced" }));
		expect(seen.afterRefusal).toBe(seen.afterRequest);
		expect(wallet.left).toBe(seen.afterRequest - 3_690n);
		expect(wallet.held.size).toBe(0);
	});

	it("gives a conversation its cap in the commit that creates it", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = false;
		// README: a cap in the commit that creates a conversation
		const program = Effect.gen(function* () {
			const scripted = yield* ScriptedModels;
			yield* scripted.setResponses([answer("One."), answer("Two.")]);
			const shares = yield* Shares;
			const child = yield* Harness.createConversation({
				ownership: { kind: "ownerless" },
				agent: yield* agent,
				// Stored with the conversation or not at all: no child ever exists without its cap.
				init: (tx, conversation) => Effect.asVoid(shares.setCapIn(tx, conversation, 20n)),
			});
			const first = yield* child.prompt("First");
			const second = yield* child.prompt("Second");
			return { first, second, share: yield* shares.get(child.id) };
		});

		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* program;
				return { ...result, stop: yield* stopOf(result.first.conversationId), calls: yield* requests };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.first).toMatchObject({ status: "done" });
		expect(seen.second).toMatchObject({ status: "unanswered", reason: "model_error" });
		const spent = 1_000_000n - wallet.left;
		expect(spent).toBeGreaterThanOrEqual(20n);
		// The first request counted against the cap: the share holds exactly what the lease was told.
		expect(seen.share).toEqual(Option.some({ conversation: seen.first.conversationId, cap: 20n, settled: spent }));
		expect(Option.getOrThrow(seen.stop).refusal).toMatchObject({ _tag: "ShareExhausted", cap: 20n, settled: spent });
		expect(seen.calls).toBe(1);
	});

	it("reads what a conversation without a cap has spent", async () => {
		wallet.left = 1_000_000n;
		wallet.fenced = false;
		// README: what a conversation has spent
		const program = Effect.gen(function* () {
			const scripted = yield* ScriptedModels;
			yield* scripted.setResponses([answer("One."), answer("Two.")]);
			const shares = yield* Shares;
			const root = yield* Harness.rootWith({ agent: yield* agent });
			// Counted from here on, and never refused for it. In a creating commit: shares.trackIn(tx, conversation).
			yield* shares.track(root.id);
			yield* root.prompt("First");
			yield* root.prompt("Second");
			return yield* shares.get(root.id);
		});

		const share = Option.getOrThrow(await Effect.runPromise(Effect.provide(program, live)));
		const spent = 1_000_000n - wallet.left;
		expect(spent).toBeGreaterThan(0n);
		// The two responses, at the price table: what the lease was told, to the micro unit.
		expect(share).toEqual({ conversation: share.conversation, settled: spent });
	});
});
