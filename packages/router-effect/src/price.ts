// The cost of one response at a route's price, in integer micro units, with no float arithmetic: pi-ai's rule.

import type { Usage } from "@effectified/pi-ai";
import { TOKEN_KINDS, type TokenKind } from "@effectified/pi-ai";
import { Effect, Schema } from "effect";
import type { Price, Route } from "./route-table.ts";

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

/** An amount of money: `micros` millionths of one unit of `currency`. */
export const Cost = Schema.Struct({
	currency: Schema.String,
	micros: Schema.BigInt,
});

/** An amount of money in integer micro units. */
export type Cost = typeof Cost.Type;

/** The counts a cost reads: pi-ai's token kinds, and the part of the cache writes kept for one hour. */
const COUNTED = [...TOKEN_KINDS, "cacheWrite1h"] as const;

/** A token count that cannot be priced: it is not a whole number of tokens, zero or more. */
export class InvalidUsage extends Schema.TaggedError<InvalidUsage>()("InvalidUsage", {
	kind: Schema.Literals(COUNTED),
	count: Schema.Number,
}) {
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
 * tokens: the strict form, for a product's own figures. A route event is priced by `priced`, which never fails.
 */
export function cost(route: Pick<Route, "price">, usage: Counted): Effect.Effect<Cost, InvalidUsage> {
	// Suspended so that a price that is not a decoded `Price` (a fraction) is a defect of the Effect, not a throw here.
	return Effect.suspend(() => {
		for (const kind of COUNTED) {
			const count = usage[kind];
			if (count === undefined) continue;
			if (!Number.isSafeInteger(count) || count < 0) return Effect.fail(new InvalidUsage({ kind, count }));
		}
		return Effect.succeed(priced(route.price, usage));
	});
}

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
	const longWrites = min(whole(usage.cacheWrite1h ?? 0), counts.cacheWrite);
	let scaled = longWrites * 2n * BigInt(rates.input);
	counts.cacheWrite -= longWrites;
	for (const kind of TOKEN_KINDS) scaled += counts[kind] * BigInt(rates[kind]);
	return { currency: price.currency, micros: (scaled + PER_MILLION - 1n) / PER_MILLION };
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
function ratesAt(price: Price, input: bigint): Pick<Price, TokenKind> {
	let rates: Pick<Price, TokenKind> = price;
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

/** The token counts of a pi-ai usage, as a route event records them; zeros when the provider reported none. */
export function tokensOf(usage: Usage | undefined): TokenUsage {
	if (usage === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const { input, output, cacheRead, cacheWrite, cacheWrite1h } = usage;
	return { input, output, cacheRead, cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }) };
}
