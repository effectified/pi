// The examples of README.md that a test can run, as tests. The code under each "README:" comment is the README's,
// line for line; only the imports differ (the README names the packages, this file the sources and stand-ins), and
// the providers are scripted.

import { type AssistantMessage, complete, getModel, Models } from "@effectified/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@effectified/pi-ai/testing";
import { Context, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	AttemptSettlement,
	ConstraintSource,
	type Constraints,
	ConstraintsUnavailable,
	cost,
	priceRows,
	RouteEvents,
	Router,
	type RouteTable,
} from "../src/index.ts";
import { context, failing } from "./scripted.ts";

// README: the route table
const table: RouteTable = {
	// The product's labels, lowest to highest. The router has none of its own.
	classifications: ["public", "internal", "secret"],
	// Every concurrency key a route names: how many requests may be in flight on it.
	limits: { openrouter: { maxInFlight: 8 }, local: { maxInFlight: 2 } },
	// Optional. After a rate limit a key waits baseMillis, doubled for each one in a row, at most maxMillis.
	backoff: { baseMillis: 1_000, maxMillis: 60_000 },
	aliases: [
		{
			alias: "author",
			// Optional: the constraints of a request that carries none.
			defaults: { classification: "internal" },
			// Tried in this order.
			routes: [
				{
					provider: "openrouter", // the id of a provider in Models
					model: "anthropic/claude-haiku-5.5", // a chat model that provider lists
					region: "us",
					ceiling: "public", // the highest classification this route may see
					// Per million tokens, in millionths of the currency: USD 1.00 in, USD 5.00 out.
					price: {
						currency: "USD",
						input: 1_000_000,
						output: 5_000_000,
						cacheRead: 100_000,
						cacheWrite: 1_250_000,
					},
					concurrencyKey: "openrouter",
				},
				{
					provider: "local",
					model: "qwen-3-coder",
					region: "eu",
					ceiling: "secret",
					price: { currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					concurrencyKey: "local",
					// Optional: what the product says of the route. A request can require labels.
					labels: ["zero-data-retention"],
				},
			],
		},
	],
};

/** Scripted providers under the ids and models the README's table names. */
function providers() {
	const openrouter = fauxProvider({ provider: "openrouter", models: [{ id: "anthropic/claude-haiku-5.5" }] });
	const local = fauxProvider({ provider: "local", models: [{ id: "qwen-3-coder" }] });
	return { openrouter, local, models: Models.layer([openrouter.provider, local.provider]) };
}

/** A stand-in for the `Spend` of `@effectified/pi-budget`, which this package does not import: its signature. */
interface Spent {
	readonly key: string;
	readonly provider: string;
	readonly model: string;
	readonly session?: string | undefined;
	readonly requestKey?: string | undefined;
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
	readonly outcome: "returned" | "failed" | "aborted";
}

class Spend extends Context.Service<Spend, { readonly record: (spent: Spent) => Effect.Effect<unknown, Error> }>()(
	"test/Spend",
) {}

/**
 * The README's table with a price on its free route, so that only being a request's last attempt keeps an attempt
 * that served on it away from the budget.
 */
function pricedTable(): RouteTable {
	const [author] = table.aliases;
	const [first, second] = author.routes;
	return { ...table, aliases: [{ ...author, routes: [first, { ...second, price: first.price }] }] };
}

/** The router of the README's section "With a budget", over what a test gives it under the README's names. */
function routedWithBudget(table: RouteTable, providers: Layer.Layer<Models>, budgeted: Layer.Layer<Spend>) {
	// README: with a budget
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

	const routed = Router.layer(table).pipe(
		// The settlement gets the budget's `Spend` and nothing else of it: the router stays on the providers' `Models`.
		Layer.provide(Layer.provide(SettleAttempts, budgeted)),
		Layer.provide(providers),
	);
	return routed;
}

describe("the README", () => {
	it("resolves the routes of its table by classification, region and label", async () => {
		const { models } = providers();
		const resolved = await Effect.runPromise(
			Effect.gen(function* () {
				const names = (routes: ReadonlyArray<{ readonly provider: string }>) =>
					routes.map((route) => route.provider);
				// README: Router.resolve
				const router = yield* Router;
				const everything = yield* router.resolve("author", { classification: "public" }); // both routes, in table order
				const secret = yield* router.resolve("author", { classification: "secret" }); // the local route only
				const kept = yield* router.resolve("author", {
					classification: "public",
					requires: ["zero-data-retention"],
				}); // the local route
				const nowhere = yield* Effect.flip(router.resolve("author", { classification: "secret", regions: ["us"] })); // fails: NoRouteAvailable
				return { everything: names(everything), secret: names(secret), kept: names(kept), nowhere };
			}).pipe(Effect.provide(Layer.provideMerge(Router.layer(table), models))),
		);
		expect(resolved.everything).toEqual(["openrouter", "local"]);
		expect(resolved.secret).toEqual(["local"]);
		expect(resolved.kept).toEqual(["local"]);
		expect(resolved.nowhere).toMatchObject({
			_tag: "NoRouteAvailable",
			excluded: [
				{ provider: "openrouter", model: "anthropic/claude-haiku-5.5", reason: "classification" },
				{ provider: "local", model: "qwen-3-coder", reason: "region" },
			],
		});
	});

	it("constrains each conversation through the product's source, and refuses a session it does not know", async () => {
		const { openrouter, local, models } = providers();
		local.setResponses([fauxAssistantMessage("from local"), fauxAssistantMessage("from local again")]);

		// README: constraints of a conversation
		// The product's own state: what it decided about each conversation, by the conversation's provider session.
		const bySession = new Map<string, Constraints>();
		bySession.set("0197-session-of-a-public-thread", { classification: "public" });
		bySession.set("0197-session-of-an-eu-thread", { classification: "internal", regions: ["eu"] });

		const PerConversation = Layer.succeed(ConstraintSource, {
			constraintsOf: ({ alias, sessionId }) =>
				// A session the product does not know is not served: the request is refused.
				Effect.mapError(
					Effect.fromNullishOr(sessionId === undefined ? undefined : bySession.get(sessionId)),
					() => new ConstraintsUnavailable({ alias, reason: `no constraints for session ${sessionId}` }),
				),
		});

		const live = Router.layer(table).pipe(Layer.provide(PerConversation), Layer.provideMerge(models));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const model = yield* getModel({ provider: "router", modelId: "author" });
				// The alias's default says `internal`. Neither request says anything of itself.
				const ask = (sessionId: string) => complete(model, context, { sessionId });
				return {
					// The source says `internal` and the EU: the stricter classification, the regions both allow.
					eu: (yield* ask("0197-session-of-an-eu-thread")).provider,
					// The source says `public`, the alias `internal`: the stricter one holds, so not the public route.
					public: (yield* ask("0197-session-of-a-public-thread")).provider,
					unknown: yield* Effect.flip(ask("0197-some-other-session")),
				};
			}).pipe(Effect.provide(live)),
		);
		expect([result.eu, result.public]).toEqual(["local", "local"]);
		expect(result.unknown.message).toBe(
			'The constraints of a request to alias "author" are not known, so it was not sent to any route',
		);
		expect(openrouter.state.callCount).toBe(0);
	});

	it("settles through the product's port the attempt another route takes over, before that route is tried, and never the one that served", async () => {
		const { openrouter, local, models } = providers();
		// One log for the providers and the budget: its order is the order things happened in.
		const log: string[] = [];
		const asked = (name: string, response: AssistantMessage) => () => {
			log.push(`${name}: request`);
			return response;
		};
		openrouter.setResponses([
			asked("openrouter", failing("overloaded")),
			asked("openrouter", fauxAssistantMessage("served by the first route")),
		]);
		local.setResponses([asked("local", fauxAssistantMessage("taken over"))]);
		const recorded: Spent[] = [];
		/** The budget's Layer, as far as the settlement needs it: its `Spend`. */
		const budgeted = Layer.succeed(Spend, {
			record: (spent) =>
				Effect.sync(() => {
					log.push(`spend: ${spent.key.replace(/^.*-/, "request ")}`);
					recorded.push(spent);
				}),
		});
		const routed = routedWithBudget(pricedTable(), models, budgeted);

		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* RouteEvents.use((hub) => hub.subscribe);
					const router = yield* Router;
					const constraints = { classification: "public" };
					// The first route fails and the second takes over; then the first route serves a request alone.
					yield* router.complete("author", context, { constraints, sessionId: "0197-session-of-a-public-thread" });
					log.push("caller: has the first message");
					yield* router.complete("author", context, { constraints });
					return yield* Stream.runCollect(Stream.take(events, 3));
				}),
			).pipe(Effect.provide(routed)),
		);
		expect(seen.map((event) => [event.attempt, event.outcome, event.fallback, event.cost.micros > 0n])).toEqual([
			[1, "failed", true, true],
			[2, "served", false, true],
			[1, "served", false, true],
		]);
		// One spend: the failed attempt, under its request's id and its number, with the session it came with and the
		// key of what its request asked. Neither attempt that served, though each cost something.
		expect(seen[0].requestKey).toMatch(/^[0-9a-f]{64}$/);
		expect(recorded).toEqual([
			{
				key: `${seen[0].requestId}#1`,
				provider: "openrouter",
				model: "anthropic/claude-haiku-5.5",
				session: "0197-session-of-a-public-thread",
				requestKey: seen[0].requestKey,
				usage: seen[0].usage,
				outcome: "failed",
			},
		]);
		// It was told to the budget inside its request: before the route that took it over was asked.
		expect(log).toEqual([
			"openrouter: request",
			"spend: request 1#1",
			"local: request",
			"caller: has the first message",
			"openrouter: request",
		]);
	});

	it("can still forward the same attempts from the stream of route events, beside their requests", async () => {
		const { openrouter, local, models } = providers();
		openrouter.setResponses([failing("overloaded")]);
		local.setResponses([fauxAssistantMessage("taken over")]);
		const forwarded = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					// The stream form the README names. No settlement is provided, and the default settles nothing.
					const events = yield* RouteEvents.use((hub) => hub.subscribe);
					const taken = Stream.filter(events, (event) => event.fallback && event.cost.micros > 0n);
					yield* Router.use((router) =>
						router.complete("author", context, { constraints: { classification: "public" } }),
					);
					return yield* Stream.runCollect(Stream.take(taken, 1));
				}),
			).pipe(Effect.provide(Layer.provideMerge(Router.layer(pricedTable()), models))),
		);
		expect(forwarded.map((event) => [event.attempt, event.route.provider, event.outcome])).toEqual([
			[1, "openrouter", "failed"],
		]);
	});

	it("prices a usage exactly, and gives its table's prices as rows for a budget", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// README: prices
				// 1,234 input and 567 output tokens at USD 3 and USD 15 per million.
				const price = { currency: "USD", input: 3_000_000, output: 15_000_000, cacheRead: 0, cacheWrite: 0 };
				// { currency: "USD", micros: 12207n }
				const charged = yield* cost({ price }, { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 });

				// From 200,000 input tokens on, twice the price of every token.
				const large = {
					inputTokensAbove: 200_000,
					input: 6_000_000,
					output: 30_000_000,
					cacheRead: 0,
					cacheWrite: 0,
				};
				const tiered = { ...price, tiers: [large] };
				// { currency: "USD", micros: 1230000n }
				const tieredCharge = yield* cost(
					{ price: tiered },
					{ input: 205_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				);

				// README: prices for a budget
				// { currency: "USD", prices: [{ provider, model, input, output, cacheRead, cacheWrite }, ...] }
				const rows = yield* priceRows(table); // or priceRows(table, "routes") for a router built with { id: "routes" }
				return { charged, tieredCharge, rows };
			}),
		);
		expect(result.charged).toEqual({ currency: "USD", micros: 12207n });
		expect(result.tieredCharge).toEqual({ currency: "USD", micros: 1_230_000n });
		expect(result.rows).toEqual({
			currency: "USD",
			prices: [
				{
					provider: "openrouter",
					model: "anthropic/claude-haiku-5.5",
					input: 1_000_000,
					output: 5_000_000,
					cacheRead: 100_000,
					cacheWrite: 1_250_000,
				},
				{ provider: "local", model: "qwen-3-coder", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// The alias, at the highest price of its two routes for each kind of token.
				{
					provider: "router",
					model: "author",
					input: 1_000_000,
					output: 5_000_000,
					cacheRead: 100_000,
					cacheWrite: 1_250_000,
				},
			],
		});
	});
});
