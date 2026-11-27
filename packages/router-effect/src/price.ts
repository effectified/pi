// The cost of one response at a route's price, in integer micro units, with no float arithmetic: pi-ai's rule.

import { TOKEN_KINDS, type TokenKind, type Usage } from "@effectified/pi-ai";
import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import type { Price, PriceTier, Route } from "./route-table.ts";

/**
 * The token counts of one response by kind, as pi-ai counts them and as the provider reported them: a fraction or a
 * negative count stays as it came. `cacheWrite1h` is the part of `cacheWrite` written with one hour of retention, when
 * the provider reported it.
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

/** An amount of money: `micros` millionths of one unit of `currency`, zero or more. */
export const Cost = Schema.Struct({
	currency: Schema.String,
	micros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
});

/** An amount of money in integer micro units. */
export type Cost = typeof Cost.Type;

/** The counts a cost reads: pi-ai's token kinds, and the part of the cache writes kept for one hour. */
const COUNTED = [...TOKEN_KINDS, "cacheWrite1h"] as const;

/** A token count that cannot be priced: it is not a whole number of tokens, zero or more. */
export class InvalidUsage extends Schema.TaggedError<InvalidUsage, { readonly brand: unique symbol }>()(
	"InvalidUsage",
	{
		kind: Schema.Literals(COUNTED),
		// @effect-diagnostics-next-line schemaNumber:off the rejected count as it was given, NaN and Infinity included
		count: Schema.Number,
	},
) {
	override get message(): string {
		return `The ${this.kind} token count ${this.count} is not a whole number of tokens`;
	}
}

/** The counts of a pi-ai usage a cost reads. */
type Counted = Pick<Usage, (typeof COUNTED)[number]>;

/**
 * What `usage` costs at the price of `route`, by pi-ai's rule (`calculateCost`): the rates of the price's highest
 * tier below the request's input, each count times its rate per million tokens, and the cache writes kept for one
 * hour at twice the input rate. Summed exactly, then rounded up to the next micro unit once, so a response is never
 * charged less than it cost and never rounded twice. Fails with `InvalidUsage` when a count is not a whole number of
 * tokens: the strict form, for a product's own figures. A route event is priced by `priced`, which never fails. A
 * price that is not a decoded `Price` (a fraction) is a defect of the Effect.
 */
export const cost: (route: Pick<Route, "price">, usage: Counted) => Effect.Effect<Cost, InvalidUsage> = Effect.fn(
	"Price.cost",
)(function* (route, usage) {
	const invalid = Arr.findFirst(COUNTED, (kind) => {
		const count = usage[kind];
		return count === undefined || (Number.isSafeInteger(count) && count >= 0)
			? Option.none()
			: Option.some(InvalidUsage.make({ kind, count }));
	});
	if (Option.isSome(invalid)) return yield* invalid.value;
	return priced(route.price, usage);
});

const PER_MILLION = 1_000_000n;

/**
 * What `usage` costs at `price`, for a route event: the arithmetic of `cost`, and total, because an attempt must be
 * recorded whatever a provider reported. A count that is not a whole number (wire input: a provider reports the
 * counts) is rounded up, one that is not a positive number counts as zero, and one-hour cache writes count at most
 * all of `cacheWrite`. This is the rule of `@effectified/pi-budget`, so a budget that prices the same usage at the
 * same price settles the same amount.
 */
export function priced(price: Price, usage: Counted): Cost {
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
	return { currency: price.currency, micros: (scaled + PER_MILLION - 1n) / PER_MILLION };
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
function ratesAt(price: Price, input: bigint): Pick<Price, TokenKind> {
	const applying = Arr.filter(price.tiers ?? [], (tier) => input > BigInt(tier.inputTokensAbove));
	return Arr.isArrayNonEmpty(applying) ? Arr.max(applying, byThreshold) : price;
}

/**
 * The token counts of a pi-ai usage, as a route event records them; zeros when the provider reported none. A count
 * that is not a finite number (wire input; JSON cannot carry one) is recorded as zero, which is what its cost counts it
 * as; every other count as it came.
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
