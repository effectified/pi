// The cost of one response at a route's price, in integer micro units, with no float arithmetic.

import type { Usage } from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";
import type { Price, Route } from "./route-table.ts";

/** The token counts of one response by kind, as pi-ai counts them. */
export const TokenUsage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
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

/** A token count that cannot be priced: it is not a whole number of tokens, zero or more. */
export class InvalidUsage extends Schema.TaggedError<InvalidUsage>()("InvalidUsage", {
	kind: Schema.Literals(["input", "output", "cacheRead", "cacheWrite"]),
	count: Schema.Number,
}) {
	override get message(): string {
		return `The ${this.kind} token count ${this.count} is not a whole number of tokens`;
	}
}

const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * What `usage` costs at the price of `route`: each count times its price per million tokens, summed exactly, then
 * rounded up to the next micro unit once, so a response is never charged less than it cost and never rounded twice.
 * Fails with `InvalidUsage` when a count is not a whole number of tokens: the strict form, for a product's own
 * figures. A route event is priced by `priced`, which never fails.
 */
export function cost(
	route: Pick<Route, "price">,
	usage: Pick<Usage, keyof TokenUsage>,
): Effect.Effect<Cost, InvalidUsage> {
	// Suspended so that a price that is not a decoded `Price` (a fraction) is a defect of the Effect, not a throw here.
	return Effect.suspend(() => {
		for (const kind of KINDS) {
			const count = usage[kind];
			if (!Number.isSafeInteger(count) || count < 0) return Effect.fail(new InvalidUsage({ kind, count }));
		}
		return Effect.succeed(priced(route.price, usage));
	});
}

const PER_MILLION = 1_000_000n;

/**
 * What `usage` costs at `price`, for a route event: the arithmetic of `cost`, and total, because an attempt must be
 * recorded whatever a provider reported. A count that is not a whole number (wire input: a provider reports the
 * counts) is rounded up, and one that is not a positive number counts as zero. This is the rule of
 * `@gunta/pi-budget-effect`, so a budget that prices the same usage at the same price settles the same amount.
 */
export function priced(price: Price, usage: Pick<Usage, keyof TokenUsage>): Cost {
	let scaled = 0n;
	for (const kind of KINDS) {
		const count = usage[kind];
		if (Number.isFinite(count) && count > 0) scaled += BigInt(Math.ceil(count)) * BigInt(price[kind]);
	}
	return { currency: price.currency, micros: (scaled + PER_MILLION - 1n) / PER_MILLION };
}

/** The usage of a request that used nothing, as pi-ai writes it. A new object each time: pi-ai's messages are mutable. */
export function noUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
