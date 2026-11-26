// What review-effect's verdict writes again of pi-ai's response, checked against pi-ai's own types. Type-only: nothing
// here runs. A failure names what moved upstream. Which fields of the reviewer's response its record takes is
// decided where the record is made (`model-review.ts`).

import type { Usage as PiUsage, StopReason } from "@earendil-works/pi-ai";
import type { StrictOmit } from "@effectified/pi-ai";
import type { Assert, Conform } from "../../../effect/conformance.ts";
import type { Call, Cost, Usage } from "../src/index.ts";

/** The record of the reviewer's request takes exactly pi-ai's stop reasons. */
export type StopReasonSame = Assert<Conform<Call["stopReason"], StopReason>>;

/** The cost of the reviewer's response is pi-ai's whole `usage.cost`, field for field. */
export type CostSame = Assert<Conform<Cost, PiUsage["cost"]>>;

/**
 * Its usage is pi-ai's, every count typed as pi-ai types it, with the cost as its total (`cost`) and whole (`costs`,
 * absent from a verdict stored before it was kept).
 */
export type UsageSame = Assert<
	Conform<Usage, StrictOmit<PiUsage, "cost"> & { readonly cost: number; readonly costs?: PiUsage["cost"] }>
>;
