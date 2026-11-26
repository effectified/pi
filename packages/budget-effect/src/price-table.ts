// The price table: what each model charges per million tokens, as data, and the exact cost of one response.

import type { Usage } from "@effectified/pi-ai";
import { TOKEN_KINDS, type TokenKind } from "@effectified/pi-ai";
import { Context, Effect, Layer, Option, Schema } from "effect";

const Micros = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The rates of a large request, as pi-ai's `ModelCostTier`: a request whose input tokens (`input`, `cacheRead` and
 * `cacheWrite` together) are more than `inputTokensAbove` is charged at these rates for all of its tokens.
 */
export const PriceTier = Schema.Struct({
	inputTokensAbove: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	input: Micros,
	output: Micros,
	cacheRead: Micros,
	cacheWrite: Micros,
});

/** The rates of a large request. */
export type PriceTier = typeof PriceTier.Type;

/**
 * What one model charges, per million tokens, in integer micro units of the table's currency (one millionth of a
 * unit: 3 per million tokens is 3000000). The four kinds are pi-ai's: `input` is the input neither read from nor
 * written to the cache, and `output` includes reasoning. Cache writes kept for one hour cost twice `input`, as pi-ai
 * charges them. `tiers`, as pi-ai's model costs have them: the tier with the highest threshold below a request's
 * input replaces the four rates for that request.
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
	tiers: Schema.optional(Schema.Array(PriceTier)),
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

/**
 * The token counts of one response by kind, as pi-ai counts them. `cacheWrite1h` is the part of `cacheWrite` written
 * with one hour of retention, when the provider reported it.
 */
export const TokenUsage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	cacheWrite1h: Schema.optionalKey(Schema.Number),
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
export class Prices extends Context.Service<Prices, PricesService>()("@effectified/pi-budget/Prices") {
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
	if (usage === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const { input, output, cacheRead, cacheWrite, cacheWrite1h } = usage;
	return { input, output, cacheRead, cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }) };
}

const PER_MILLION = 1_000_000n;

/**
 * What `usage` costs at `price`, in micro units, by pi-ai's rule (`calculateCost`): the rates of the price's highest
 * tier below the request's input, each count times its rate per million tokens, and the cache writes kept for one
 * hour at twice the input rate. Summed exactly, then rounded up to the next micro unit once, so a response is never
 * charged less than it cost and never rounded twice. It is total, because a settlement cannot fail: a count that is
 * not a whole number (wire input: a provider reports the counts) is rounded up, one that is not a positive number
 * counts as zero, and one-hour cache writes count at most all of `cacheWrite`.
 */
export function cost(price: ModelPrice, usage: TokenUsage): bigint {
	const counts = {
		input: whole(usage.input),
		output: whole(usage.output),
		cacheRead: whole(usage.cacheRead),
		cacheWrite: whole(usage.cacheWrite),
	} satisfies Record<TokenKind, bigint>;
	const rates = ratesAt(price, counts.input + counts.cacheRead + counts.cacheWrite);
	// pi-ai charges a cache write kept for one hour at twice the input rate, and the rest at the cache-write rate.
	const longWrites = min(whole(usage.cacheWrite1h ?? 0), counts.cacheWrite);
	let scaled = longWrites * 2n * BigInt(rates.input);
	counts.cacheWrite -= longWrites;
	for (const kind of TOKEN_KINDS) scaled += counts[kind] * BigInt(rates[kind]);
	return (scaled + PER_MILLION - 1n) / PER_MILLION;
}

/** `count` as a whole number of tokens: rounded up, and zero when it is not a positive number. */
function whole(count: number): bigint {
	return Number.isFinite(count) && count > 0 ? BigInt(Math.ceil(count)) : 0n;
}

function min(one: bigint, other: bigint): bigint {
	return one < other ? one : other;
}

/**
 * The rates of `price` for a request of `input` tokens (`input`, `cacheRead` and `cacheWrite` together): those of the
 * tier with the highest threshold below it, else the base rates. pi-ai's rule; of two tiers with one threshold, the
 * first.
 */
function ratesAt(price: ModelPrice, input: bigint): Pick<ModelPrice, TokenKind> {
	let rates: Pick<ModelPrice, TokenKind> = price;
	let above = -1n;
	for (const tier of price.tiers ?? []) {
		const threshold = BigInt(tier.inputTokensAbove);
		if (input > threshold && threshold > above) {
			rates = tier;
			above = threshold;
		}
	}
	return rates;
}
