// pi-ai's token usage: the kinds of tokens it prices, and the usage of a response that used nothing.

import type { ModelCostRates, Usage } from "@earendil-works/pi-ai";

/**
 * The kinds of tokens pi-ai counts in a `Usage` and prices with a rate of a model's `cost` (the keys of
 * `ModelCostRates`), in pi-ai's order. Not kinds of their own: `cacheWrite1h` is the part of `cacheWrite` that pi-ai
 * prices at twice the input rate, `reasoning` is part of `output`, and `totalTokens` is the sum. The package's
 * conformance check fails to compile when pi-ai adds a kind, so a price table built on this list cannot miss one.
 */
export const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const satisfies ReadonlyArray<
	keyof ModelCostRates & keyof Usage & keyof Usage["cost"]
>;

/** One kind of tokens pi-ai prices: an element of `TOKEN_KINDS`. */
export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * The usage of a response that used nothing: every count and every cost zero, as pi-ai keeps it on a message it does
 * not price (an assistant message of the history, a response that failed before its first token). A new object each
 * time: pi-ai's `calculateCost` writes into the usage it prices.
 */
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
