// What telemetry-effect copies of pi-telemetry's types field by field, checked against pi-telemetry's own types.
// Type-only: nothing here runs. The handles and metrics list every member of pi-telemetry's interfaces where they are
// written (`Required<TelemetrySpan>`, `Required<TelemetryMetrics>`); what is copied by name is checked here.

import type { HistogramOptions, InstrumentOptions, SpanStatus } from "@earendil-works/pi-telemetry";
import type { Assert, Conform } from "../../../effect/conformance.ts";

/** `metrics.ts` reads exactly these options of an instrument: an option pi-telemetry adds fails here. */
export type InstrumentOptionsRead = Assert<Conform<"description" | "unit", keyof InstrumentOptions>>;

/** `metrics.ts` reads exactly these options of a histogram. */
export type HistogramOptionsRead = Assert<Conform<"description" | "unit" | "boundaries", keyof HistogramOptions>>;

/** `toExit` copies exactly these fields of an error status's detail into the exit of the span. */
export type SpanFailureCopied = Assert<
	Conform<"name" | "message", keyof NonNullable<Extract<SpanStatus, { status: "error" }>["error"]>>
>;
