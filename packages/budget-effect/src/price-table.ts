// The price table: what each model charges per million tokens, as data, and the exact cost of one response.

import { ModelId, ProviderId, TOKEN_KINDS, type TokenKind, type Usage } from "@effectified/pi-ai";
import { Array as Arr, Context, Effect, Layer, MutableHashMap, Order, Schema } from "effect";

/** A whole number, zero or more: a rate in micro units per million tokens, or a number of tokens. */
const Whole = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * An amount of money in integer micro units of the budget's currency (one millionth of a unit), zero or more: an
 * estimate, a cost, a cap, a total. Exact `bigint` arithmetic, as `@effectified/pi-router` keeps its costs.
 */
export const Micros = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));

/**
 * The rates of a large request, as pi-ai's `ModelCostTier`: a request whose input tokens (`input`, `cacheRead` and
 * `cacheWrite` together) are more than `inputTokensAbove` is charged at these rates for all of its tokens.
 */
export const PriceTier = Schema.Struct({
	inputTokensAbove: Whole,
	input: Whole,
	output: Whole,
	cacheRead: Whole,
	cacheWrite: Whole,
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
	provider: ProviderId,
	/** The id of the model within that provider. */
	model: ModelId,
	input: Whole,
	output: Whole,
	cacheRead: Whole,
	cacheWrite: Whole,
	tiers: Schema.optional(Schema.Array(PriceTier)),
});

/** What one model charges, per million tokens, in integer micro units. */
export type ModelPrice = typeof ModelPrice.Type;

/**
 * The prices of a budget, as data a product can store, load and review. Every amount of the budget is in `currency`.
 * A table written in code or loaded from a file is its `Encoded` form (plain ids), which `Prices.layer` decodes.
 */
export const PriceTable = Schema.Struct({
	/** A label the product chooses, such as an ISO 4217 code. The budget only carries it. */
	currency: Schema.String,
	prices: Schema.Array(ModelPrice),
});

/** The prices of a budget. */
export type PriceTable = typeof PriceTable.Type;

/**
 * The token counts of one response by kind, as pi-ai counts them and as the provider reported them: a fraction or a
 * negative count stays as it came (its cost counts it as `cost` says). `cacheWrite1h` is the part of `cacheWrite`
 * written with one hour of retention, when the provider reported it. The shape of `@effectified/pi-router`'s.
 */
export const TokenUsage = Schema.Struct({
	input: Schema.Finite,
	output: Schema.Finite,
	cacheRead: Schema.Finite,
	cacheWrite: Schema.Finite,
	cacheWrite1h: Schema.optionalKey(Schema.Finite),
});

/** The token counts of one response by kind. */
export type TokenUsage = typeof TokenUsage.Type;

/** A price table cannot be used: it is not the shape of one, or it prices a model twice. */
export class InvalidPriceTable extends Schema.TaggedError<InvalidPriceTable, { readonly brand: unique symbol }>()(
	"InvalidPriceTable",
	{ reason: Schema.String },
) {
	override get message(): string {
		return `The price table cannot be used: ${this.reason}`;
	}
}

/** The table has no price for this model, so a request to it cannot be budgeted. Nothing was sent. */
export class PriceMissing extends Schema.TaggedError<PriceMissing, { readonly brand: unique symbol }>()(
	"PriceMissing",
	{ provider: ProviderId, model: ModelId },
) {
	override get message(): string {
		return `The price table has no price for ${this.provider}/${this.model}`;
	}
}

/** The price table of a budget, indexed. */
export interface PricesService {
	/** The currency of every amount of the budget. */
	readonly currency: string;
	/** The price of a model. Fails with `PriceMissing` when the table does not list it. */
	readonly priceOf: (provider: ProviderId, model: ModelId) => Effect.Effect<ModelPrice, PriceMissing>;
	/** What `usage` costs at the price of a model, in micro units, rounded up once (see `cost`). */
	readonly cost: (provider: ProviderId, model: ModelId, usage: TokenUsage) => Effect.Effect<bigint, PriceMissing>;
}

/** The prices a budget charges at. A product provides them with `Prices.layer(table)`. */
export class Prices extends Context.Service<Prices, PricesService>()("@effectified/pi-budget/price-table/Prices") {
	/**
	 * The prices of `table`, a table written in code, loaded, or given by `priceRows` of `@effectified/pi-router`. The
	 * table is decoded here, which brands its ids and checks what its types cannot say: that a price is a whole number.
	 * Fails with `InvalidPriceTable` for a malformed table and for one that lists a model twice.
	 */
	static layer(table: typeof PriceTable.Encoded): Layer.Layer<Prices, InvalidPriceTable> {
		return Layer.effect(Prices, make(table));
	}
}

/** One model of one provider: the key of the index, compared by value. */
interface PricedModel {
	readonly provider: ProviderId;
	readonly model: ModelId;
}

/** Decodes `table` and indexes its prices by model. */
const make = Effect.fn("Prices.make")(function* (table: typeof PriceTable.Encoded) {
	const { currency, prices } = yield* Effect.mapError(decodeTable(table), (error) =>
		InvalidPriceTable.make({ reason: error.message }),
	);
	const byModel = MutableHashMap.empty<PricedModel, ModelPrice>();
	for (const price of prices) {
		const key: PricedModel = { provider: price.provider, model: price.model };
		if (MutableHashMap.has(byModel, key)) {
			return yield* InvalidPriceTable.make({ reason: `${price.provider}/${price.model} is priced twice` });
		}
		MutableHashMap.set(byModel, key, price);
	}
	const priceOf = Effect.fn("Prices.priceOf")(function* (provider: ProviderId, model: ModelId) {
		return yield* Effect.mapError(Effect.fromOption(MutableHashMap.get(byModel, { provider, model })), () =>
			PriceMissing.make({ provider, model }),
		);
	});
	const service: PricesService = {
		currency,
		priceOf,
		cost: Effect.fn("Prices.cost")(function* (provider, model, usage) {
			const price = yield* priceOf(provider, model);
			return cost(price, usage);
		}),
	};
	return service;
});

const decodeTable = Schema.decodeUnknownEffect(PriceTable);

/**
 * The token counts of a pi-ai usage, as a settlement records them; zeros when the provider reported none. A count
 * that is not a finite number (wire input; JSON cannot carry one) is recorded as zero, which is what its cost counts
 * it as; every other count as it came. `@effectified/pi-router` records a route event's counts by the same rule.
 */
export function tokensOf(usage: Usage | undefined): TokenUsage {
	if (usage === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const { input, output, cacheRead, cacheWrite, cacheWrite1h } = usage;
	return {
		input: finite(input),
		output: finite(output),
		cacheRead: finite(cacheRead),
		cacheWrite: finite(cacheWrite),
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h: finite(cacheWrite1h) }),
	};
}

function finite(count: number): number {
	return Number.isFinite(count) ? count : 0;
}

const PER_MILLION = 1_000_000n;

/**
 * What `usage` costs at `price`, in micro units, by pi-ai's rule (`calculateCost`): the rates of the price's highest
 * tier below the request's input, each count times its rate per million tokens, and the cache writes kept for one
 * hour at twice the input rate. Summed exactly, then rounded up to the next micro unit once, so a response is never
 * charged less than it cost and never rounded twice. It is total, because a settlement cannot fail: a count that is
 * not a whole number (wire input: a provider reports the counts) is rounded up, one that is not a positive number
 * counts as zero, and one-hour cache writes count at most all of `cacheWrite`. The arithmetic of `priced` in
 * `@effectified/pi-router`, so a route event and a settlement of the same usage at the same price agree.
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
	const longWrites = Order.min(Order.BigInt)(whole(usage.cacheWrite1h ?? 0), counts.cacheWrite);
	const charged = { ...counts, cacheWrite: counts.cacheWrite - longWrites };
	const scaled = Arr.reduce(
		TOKEN_KINDS,
		longWrites * 2n * BigInt(rates.input),
		(sum, kind) => sum + charged[kind] * BigInt(rates[kind]),
	);
	return (scaled + PER_MILLION - 1n) / PER_MILLION;
}

/** `count` as a whole number of tokens: rounded up, and zero when it is not a positive number. */
function whole(count: number): bigint {
	return Number.isFinite(count) && count > 0 ? BigInt(Math.ceil(count)) : 0n;
}

/** Tiers by their threshold. `Array.max` keeps the first of two equal ones, as pi-ai does. */
const byThreshold: Order.Order<PriceTier> = Order.mapInput(Order.Number, (tier: PriceTier) => tier.inputTokensAbove);

/**
 * The rates of `price` for a request of `input` tokens (`input`, `cacheRead` and `cacheWrite` together): those of the
 * tier with the highest threshold below it, else the base rates. pi-ai's rule; of two tiers with one threshold, the
 * first.
 */
function ratesAt(price: ModelPrice, input: bigint): Pick<ModelPrice, TokenKind> {
	const applying = Arr.filter(price.tiers ?? [], (tier) => input > BigInt(tier.inputTokensAbove));
	return Arr.isArrayNonEmpty(applying) ? Arr.max(applying, byThreshold) : price;
}
