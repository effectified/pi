import type * as PiTelemetry from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What this package does with every value pi-telemetry exports: the list of what is left to put in Effect terms. */
const COVERAGE = {
	InMemoryTelemetryContext: replaced("PiTelemetry, whose spans, metrics and events are Effect's"),
	NOOP_TELEMETRY_CONTEXT: replaced("PiTelemetry: outside a span the handle starts root spans"),
	NOOP_TELEMETRY_METRICS: replaced("PiTelemetry: Pi metrics are Effect metrics"),
	NOOP_TELEMETRY_PROPAGATION: replaced("makeTelemetryContext: the carriers of Effect's current span"),
	telemetryNow: replaced("Effect's Clock"),
	createTypedMetrics: replaced(
		"TypedMetrics.make: the schema's instruments on PiTelemetry, each measurement an Effect",
	),
	createTypedSpanStarter: replaced("TypedSpans.make: withSpan runs an Effect in an Effect span of the schema's names"),
	defineTelemetrySchema: offered,
} satisfies Record<keyof typeof PiTelemetry, Coverage>;

describe("the coverage of pi-telemetry", () => {
	it("offers every value it records as offered, so the record stays true", () => {
		const ours = new Set(Object.keys(Package));
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !ours.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});
