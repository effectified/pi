// What recorder-effect's records write again of pi-ai's response and Pi Durable's diagnostics, checked against their
// own types. Type-only: nothing here runs. A failure names what moved upstream. Which fields of a message a record
// takes is decided where the record is made (`from-entry.ts`).

import type { StopReason, Usage } from "@earendil-works/pi-ai";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import type { Assert, Conform } from "../../../effect/conformance.ts";
import type { Records } from "../src/index.ts";

/** pi-ai's usage without its cost, each field it may leave out as `null`: what a record keeps of it. */
type Counts = {
	readonly [K in keyof Omit<Usage, "cost">]-?: undefined extends Usage[K]
		? Exclude<Usage[K], undefined> | null
		: Usage[K];
};

/** A record keeps every count of pi-ai's usage, typed as pi-ai types it, a count pi-ai may leave out as `null`. */
export type UsageSame = Assert<Conform<Records.Usage, Counts>>;

/** A record keeps every cost of pi-ai's usage; `totalFromProvider`, which pi-ai may leave out, as `fromProvider`. */
export type CostSame = Assert<
	Conform<Records.Cost, Omit<Usage["cost"], "totalFromProvider"> & { readonly fromProvider: boolean }>
>;

/** A model call record takes exactly pi-ai's stop reasons. */
export type StopReasonSame = Assert<Conform<Records.ModelCall["stopReason"], StopReason>>;

/** A diagnostic of a tool result takes exactly Pi Durable's severities. */
export type SeveritySame = Assert<Conform<Records.Diagnostic["severity"], ToolDiagnostic["severity"]>>;
