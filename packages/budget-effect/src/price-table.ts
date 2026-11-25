// The price table: what each model charges per million tokens, as data, and the exact cost of one response.

import type { Usage } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Option, Schema } from "effect";

const Micros = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What one model charges, per million tokens, in integer micro units of the table's currency (one millionth of a
 * unit: 3 per million tokens is 3000000). The four kinds are pi-ai's: `input` is the input neither read from nor
 * written to the cache, and `output` includes reasoning.
 */
export const ModelPrice = Schema.Struct({
	/** The id of the model's provider in `Models`. */
	provider: Schema.String,
	/** The id of the model within that provider. */
	model: Schema.String,
	input: Micros,
	output: Micros,
	cacheRead: Micros,
	cacheWrite: Micros,
});

/** What one model charges, per million tokens, in integer micro units. */
export type ModelPrice = typeof ModelPrice.Type;

/** The prices of a budget, as data a product can store, load and review. Every amount of the budget is in `currency`. */
export const PriceTable = Schema.Struct({
	/** A label the product chooses, such as an ISO 4217 code. The budget only carries it. */
	currency: Schema.String,
	prices: Schema.Array(ModelPrice),
});

/** The prices of a budget. */
export type PriceTable = typeof PriceTable.Type;

/** The token counts of one response by kind, as pi-ai counts them. */
export const TokenUsage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
});

/** The token counts of one response by kind. */
export type TokenUsage = typeof TokenUsage.Type;

/** A price table cannot be used: it is not the shape of one, or it prices a model twice. */
export class InvalidPriceTable extends Schema.TaggedError<InvalidPriceTable>()("InvalidPriceTable", {
	reason: Schema.String,
}) {
	override get message(): string {
		return `The price table cannot be used: ${this.reason}`;
	}
}

/** The table has no price for this model, so a request to it cannot be budgeted. Nothing was sent. */
export class PriceMissing extends Schema.TaggedError<PriceMissing>()("PriceMissing", {
	provider: Schema.String,
	model: Schema.String,
}) {
	override get message(): string {
		return `The price table has no price for ${this.provider}/${this.model}`;
	}
}

/** The price table of a budget, indexed. */
export interface PricesService {
	/** The currency of every amount of the budget. */
	readonly currency: string;
	/** The price of a model. Fails with `PriceMissing` when the table does not list it. */
	readonly priceOf: (provider: string, model: string) => Effect.Effect<ModelPrice, PriceMissing>;
	/** What `usage` costs at the price of a model, in micro units, rounded up once (see `cost`). */
	readonly cost: (provider: string, model: string, usage: TokenUsage) => Effect.Effect<bigint, PriceMissing>;
}

/** The prices a budget charges at. A product provides them with `Prices.layer(table)`. */
export class Prices extends Context.Service<Prices, PricesService>()("@gunta/pi-budget-effect/Prices") {
	/**
	 * The prices of `table`. The table is checked against its schema here too, because the types of a table written in
	 * code cannot say that a price is a whole number. Fails with `InvalidPriceTable` for a malformed table and for one
	 * that lists a model twice.
	 */
	static layer(table: PriceTable): Layer.Layer<Prices, InvalidPriceTable> {
		return Layer.effect(
			Prices,
			Effect.gen(function* () {
				const { currency, prices } = yield* Effect.mapError(
					decodeTable(table),
					(error) => new InvalidPriceTable({ reason: error.message }),
				);
				const byModel = new Map<string, ModelPrice>();
				for (const price of prices) {
					const key = modelKey(price.provider, price.model);
					if (byModel.has(key)) {
						return yield* new InvalidPriceTable({ reason: `${price.provider}/${price.model} is priced twice` });
					}
					byModel.set(key, price);
				}
				const priceOf = (provider: string, model: string) =>
					Option.match(Option.fromUndefinedOr(byModel.get(modelKey(provider, model))), {
						onNone: () => Effect.fail(new PriceMissing({ provider, model })),
						onSome: Effect.succeed,
					});
				return {
					currency,
					priceOf,
					cost: (provider, model, usage) => Effect.map(priceOf(provider, model), (price) => cost(price, usage)),
				};
			}),
		);
	}
}

const decodeTable = Schema.decodeUnknownEffect(PriceTable);

/** A NUL cannot be part of either id, so two different models never share a key. */
function modelKey(provider: string, model: string): string {
	return `${provider}\0${model}`;
}

/** The token counts of a pi-ai usage; zeros when the provider reported none. */
export function tokensOf(usage: Usage | undefined): TokenUsage {
	return usage === undefined
		? NO_TOKENS
		: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
}

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const PER_MILLION = 1_000_000n;

/**
 * What `usage` costs at `price`, in micro units: each count times its price per million tokens, summed exactly, then
 * rounded up to the next micro unit once, so a response is never charged less than it cost and never rounded twice.
 * It is total, because a settlement cannot fail: a count that is not a whole number (wire input: a provider reports
 * the counts) is rounded up, and one that is not a positive number counts as zero.
 */
export function cost(price: ModelPrice, usage: TokenUsage): bigint {
	let scaled = 0n;
	for (const kind of KINDS) {
		const count = usage[kind];
		if (Number.isFinite(count) && count > 0) scaled += BigInt(Math.ceil(count)) * BigInt(price[kind]);
	}
	return (scaled + PER_MILLION - 1n) / PER_MILLION;
}
