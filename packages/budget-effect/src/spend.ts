// Spend the model boundary did not see as a response: usage a product learned of elsewhere, charged to the same budget.

import { Context, Effect, Schema, Semaphore } from "effect";
import { type Budget, payerOf, refuse, reserve, settle } from "./budget.ts";
import { type BudgetRequest, type LeaseFenced, Outcome } from "./lease.ts";
import { cost, type PriceMissing, TokenUsage } from "./price-table.ts";

/**
 * Usage a provider billed that reached the budget as no response: for example an attempt of a router that failed
 * after using tokens, and that another route then took over.
 */
export const SpentUsage = Schema.Struct({
	/**
	 * The caller's name for this spend, the same every time it is told: a spend recorded under a key is not recorded
	 * again. For a router's attempt: its request id and attempt number.
	 */
	key: Schema.String,
	/** The provider and model that were used: what the price table is asked for. */
	provider: Schema.String,
	model: Schema.String,
	/** pi-ai's `sessionId` of the request the usage belongs to; with it the spend counts against that conversation. */
	session: Schema.optional(Schema.String),
	/**
	 * The `requestKey` of the request the usage belongs to, given to the lease with the spend. For a router's attempt:
	 * its route event's. It is not the spend's name: `key` is.
	 */
	requestKey: Schema.optional(Schema.String),
	usage: TokenUsage,
	/** How the request that used it ended. A spend the wrapper did not see is `failed` or `aborted` as a rule. */
	outcome: Outcome,
});

/** Usage a provider billed that reached the budget as no response. */
export type SpentUsage = typeof SpentUsage.Type;

/** What recording a spend did. */
export type Recorded =
	/** The lease was told: `cost` is what the usage costs at the price table, in micro units. */
	| {
			readonly _tag: "Settled";
			readonly reservation: string;
			readonly cost: bigint;
			/** The conversation whose share the cost was added to; absent when the session has no share. */
			readonly conversation?: number;
	  }
	/** This process recorded the key before: nothing was charged now. */
	| { readonly _tag: "Duplicate" };

/** How a product charges usage the budgeted `Models` did not see. */
export interface SpendService {
	/**
	 * Charges `spent` to the budget: prices it at the price table, reserves exactly that cost on the lease and settles
	 * it at once, adds it to the share of the session's conversation, and publishes `Reserved` and `Settled`, whose
	 * request has kind `chat` and the spend's `key`.
	 *
	 * - **Once per key, in this process.** A key recorded before answers `Duplicate` and charges nothing.
	 * - **All or nothing.** It fails with `PriceMissing` for a model without a price, and with `LeaseFenced` when
	 *   the lease refuses the reservation. Then nothing was recorded: no settlement, no share, and the key is still
	 *   unused, so the same call can be made again under a new lease. A `Refused` event is published. The provider
	 *   was paid all the same: a refusal here undoes no spending.
	 * - **No cap stops it.** The money is spent, so a share takes the cost also when that carries it over its cap.
	 */
	readonly record: (spent: SpentUsage) => Effect.Effect<Recorded, PriceMissing | LeaseFenced>;
}

/**
 * The way to charge usage the model boundary did not see. Provided by `BudgetedModels.layer` and
 * `BudgetedModels.layerWithShares`, on the lease, the prices, the events and the shares of that budget.
 */
export class Spend extends Context.Service<Spend, SpendService>()("@effectified/pi-budget/Spend") {}

/** The `Spend` of `budget`. Its record of keys lives as long as the service does. */
export function make(budget: Budget): Effect.Effect<SpendService> {
	return Effect.sync(() => {
		const recorded = new Set<string>();
		// One spend at a time: the check of a key and the reservation that uses it up are one step.
		const turn = Semaphore.makeUnsafe(1);
		const record = Effect.fnUntraced(function* (
			spent: SpentUsage,
		): Effect.fn.Return<Recorded, PriceMissing | LeaseFenced> {
			if (recorded.has(spent.key)) return { _tag: "Duplicate" };
			const payer = yield* payerOf(budget, spent.session);
			const request: BudgetRequest = {
				kind: "chat",
				provider: spent.provider,
				model: spent.model,
				...(spent.session === undefined ? {} : { session: spent.session }),
				...(payer.share === undefined ? {} : { conversation: payer.share.conversation }),
				...(spent.requestKey === undefined ? {} : { requestKey: spent.requestKey }),
				key: spent.key,
			};
			const price = yield* Effect.catch(budget.prices.priceOf(spent.provider, spent.model), (missing) =>
				refuse(budget, request, missing),
			);
			const settlement = { usage: spent.usage, cost: cost(price, spent.usage), outcome: spent.outcome };
			return yield* Effect.uninterruptible(
				Effect.gen(function* () {
					// The cost is known, so it is the reservation: the lease holds it for no longer than this takes.
					const reserved = yield* reserve(budget, request, settlement.cost);
					// The lease has the money from here on: the key is used up, whatever its `settle` does.
					recorded.add(spent.key);
					yield* settle(budget, reserved, payer, settlement);
					return {
						_tag: "Settled" as const,
						reservation: reserved.reservation,
						cost: settlement.cost,
						...(payer.share === undefined ? {} : { conversation: payer.share.conversation }),
					};
				}),
			);
		});
		return { record: (spent) => Semaphore.withPermit(turn, record(spent)) };
	});
}
