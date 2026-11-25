// What budget-effect writes again of pi-ai's token counts and prices, checked against pi-ai's own types. Type-only:
// nothing here runs. A failure names what moved upstream. Which members of pi-ai's `Models` are budgeted is decided
// where the wrapper is written (`budgeted-models.ts`).

import type { ModelCost, Usage } from "@earendil-works/pi-ai";
import type { StrictOmit } from "@gunta/pi-ai-effect";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { ModelPrice, TokenUsage } from "../src/index.ts";

/**
 * A settlement records every count of pi-ai's usage that a cost reads: the kinds pi-ai prices and the cache writes
 * kept for one hour. `reasoning` is part of `output`, `totalTokens` their sum, and `cost` pi-ai's own estimate.
 */
export type TokenUsageCovered = Assert<Covers<Usage, TokenUsage, "reasoning" | "totalTokens" | "cost">>;

/** The counts a settlement records are typed as pi-ai types them. */
export type TokenUsageSame = Assert<Conform<TokenUsage, Pick<Usage, keyof TokenUsage>>>;

/**
 * A model's price has pi-ai's rates and tiers, field for field (in integer micro units where pi-ai has units), so it
 * charges what pi-ai's `calculateCost` charges at the same rates.
 */
export type PriceSame = Assert<Conform<StrictOmit<ModelPrice, "provider" | "model">, ModelCost>>;
