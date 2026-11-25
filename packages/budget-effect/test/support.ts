// Test helper: an in-memory lease that records every reserve and settle, and the layers the suites build on.

import type { Usage } from "@earendil-works/pi-ai";
import type { Models } from "@gunta/pi-ai-effect";
import { conditions } from "@gunta/pi-ai-effect/testing";
import { type Conversation, type DurableError, Harness, Registry, Storage } from "@gunta/pi-durable-effect";
import { ScriptedModels } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
	type BudgetEvent,
	BudgetEvents,
	BudgetedModels,
	type BudgetRequest,
	Estimator,
	Lease,
	LeaseFenced,
	type ModelPrice,
	Prices,
	type Settlement,
	Shares,
	type Spend,
} from "../src/index.ts";

/** One thing the lease or the provider did, in the order it happened. */
export type Step =
	| { readonly step: "reserve"; readonly token: string; readonly estimate: bigint; readonly request: BudgetRequest }
	| { readonly step: "fenced"; readonly reason: string }
	| { readonly step: "provider" }
	| { readonly step: "settle"; readonly token: string; readonly settlement: Settlement };

/** The lease of a test, and its record. Tests change `fenced` and read `steps` directly. */
export interface TestLeaseState {
	/** Every reserve, refusal and settle, and every `provider` step a scripted response added, in order. */
	readonly steps: Step[];
	/** While set, every reserve fails with `LeaseFenced` and this reason. */
	fenced: string | undefined;
	/** While set, every reserve dies with this defect. */
	broken: Error | undefined;
	/** While set, every settle is recorded and then dies with this defect. */
	brokenSettle: Error | undefined;
	/** Succeeds once `holds` is true, asked now and after every reserve, refusal and settle. */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
}

/** The in-memory lease of a test: tokens `r1`, `r2`, and so on, in the order they were reserved. */
export class TestLease extends Context.Service<TestLease, TestLeaseState>()("test/TestLease") {
	/** A fresh lease, as the `Lease` the budget draws on and as the record a test reads. */
	static readonly layer: Layer.Layer<TestLease | Lease> = Layer.effectContext(
		Effect.sync(() => {
			const { when, changed } = conditions();
			const state: TestLeaseState = {
				steps: [],
				fenced: undefined,
				broken: undefined,
				brokenSettle: undefined,
				when,
			};
			let reservations = 0;
			return Context.make(TestLease, state).pipe(
				Context.add(Lease, {
					reserve: (estimate, request) =>
						Effect.suspend(() => {
							if (state.broken !== undefined) return Effect.die(state.broken);
							if (state.fenced !== undefined) {
								state.steps.push({ step: "fenced", reason: state.fenced });
								changed();
								return Effect.fail(new LeaseFenced({ reason: state.fenced }));
							}
							reservations += 1;
							const token = `r${reservations}`;
							state.steps.push({ step: "reserve", token, estimate, request });
							changed();
							return Effect.succeed(token);
						}),
					settle: (token, settlement) =>
						Effect.suspend(() => {
							state.steps.push({ step: "settle", token, settlement });
							changed();
							return state.brokenSettle === undefined ? Effect.void : Effect.die(state.brokenSettle);
						}),
				}),
			);
		}),
	);
}

/** The amount every test reservation sets aside, in micro units. */
export const ESTIMATE = 50_000n;

/** The price of the scripted model in every suite. Chosen so that a response's cost is not a whole micro unit. */
export const PRICE = { input: 1_500_001, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 } as const;

/** What `usage` costs at `PRICE`, worked out apart from the package: exact, rounded up once. */
export function expectedCost(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): bigint {
	const scaled =
		BigInt(usage.input) * BigInt(PRICE.input) +
		BigInt(usage.output) * BigInt(PRICE.output) +
		BigInt(usage.cacheRead) * BigInt(PRICE.cacheRead) +
		BigInt(usage.cacheWrite) * BigInt(PRICE.cacheWrite);
	return scaled / 1_000_000n + (scaled % 1_000_000n === 0n ? 0n : 1n);
}

/** The price table of a suite: the scripted provider's first model at `PRICE`, and `more`. */
export function prices(more: ReadonlyArray<ModelPrice> = []): Layer.Layer<Prices, never, ScriptedModels> {
	return Layer.unwrap(
		ScriptedModels.use(({ model }) =>
			Effect.succeed(
				Layer.orDie(
					Prices.layer({
						currency: "USD",
						prices: [{ provider: model.provider, model: model.id, ...PRICE }, ...more],
					}),
				),
			),
		),
	);
}

/** What the budgeted models of a suite provide. */
export type Budgeted = Models | BudgetEvents | Spend | Shares | TestLease | ScriptedModels;

/**
 * Budgeted `Models` over a scripted provider, with the test lease, a fixed estimate, the suite's price table and
 * shares, and the `Spend` of that budget. `Models` is the budgeted one; `ScriptedModels` scripts and counts what
 * reaches the provider.
 */
export function budgetedModels(options?: {
	readonly prices?: ReadonlyArray<ModelPrice>;
	readonly provider?: Parameters<typeof ScriptedModels.layer>[0];
}): Layer.Layer<Budgeted> {
	return BudgetedModels.layerWithShares.pipe(
		Layer.provideMerge(Layer.mergeAll(Shares.layer, TestLease.layer, Estimator.fixed(ESTIMATE))),
		Layer.provide(prices(options?.prices)),
		Layer.provideMerge(ScriptedModels.layer(options?.provider ?? { api: "scripted" })),
	);
}

/** Options of `budgetedHarness`. */
export interface HarnessOptions<E, R> {
	/** Default: `Storage.memory`. Give a SQLite storage to test a close and a reopen. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage, E, R>;
	/** Default: a registry with no extension. */
	readonly registry?: Layer.Layer<Registry.Registry>;
	readonly harness?: Harness.Options;
	/** Options of the scripted provider. Default: the api name `scripted`. */
	readonly provider?: Parameters<typeof ScriptedModels.layer>[0];
	/** Prices the table lists beside the scripted model's. */
	readonly prices?: ReadonlyArray<ModelPrice>;
}

/** A harness opened on the budgeted models of `budgetedModels`, with the shares attached to it. */
export function budgetedHarness<E = never, R = never>(
	options: HarnessOptions<E, R> = {},
): Layer.Layer<Budgeted | Harness.Harness, E | DurableError, R> {
	return Shares.attach.pipe(
		Layer.provideMerge(Harness.layer(options.harness)),
		Layer.provideMerge(
			Layer.mergeAll(
				budgetedModels({ provider: options.provider, prices: options.prices }),
				options.registry ?? EMPTY_REGISTRY,
				options.storage ?? Storage.memory,
			),
		),
	);
}

const EMPTY_REGISTRY = Layer.orDie(Registry.layer([]));

/** The root conversation of the harness, created on the scripted model on first use. */
export const root: Effect.Effect<Conversation.Conversation, DurableError, Harness.Harness | ScriptedModels> =
	ScriptedModels.use(({ model }) =>
		Harness.rootWith({ agent: { model: { provider: model.provider, modelId: model.id } } }),
	);

/**
 * Runs `effect` and gives, beside its value, the `count` budget events published meanwhile, in order. Fails when a
 * further event arrives within an hour of the test clock: the count is exact.
 */
export function withEvents<A, E, R>(
	count: number,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [A, ReadonlyArray<BudgetEvent>], E, R | BudgetEvents | TestClock.TestClock> {
	return Effect.scoped(
		Effect.gen(function* () {
			const published = yield* BudgetEvents.use((hub) => hub.subscribe);
			const value = yield* effect;
			const events = yield* Stream.runCollect(Stream.take(published, count));
			const further = yield* Effect.forkChild(Effect.timeoutOption(Stream.runHead(published), "1 hour"), {
				startImmediately: true,
			});
			yield* TestClock.adjust("1 hour");
			const extra = yield* Fiber.join(further);
			if (Option.isSome(Option.flatten(extra)))
				return yield* Effect.die(new Error(`More than ${count} budget events`));
			return [value, events] as const;
		}),
	);
}
