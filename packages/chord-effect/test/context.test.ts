import * as PiContext from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/context.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/context` does with every value Chord's `/context` exports. */
const COVERAGE = {
	BACKGROUND_CONTEXT: offered,
	TODO_CONTEXT: offered,
	createContextKey: offered,
	withContextValue: offered,
	withoutAbortSignal: offered,
	withTelemetry: offered,
	// Offered for a signal the caller has; ChordContext.scoped and ChordContext.timeout make the usual one.
	withAbortSignal: offered,
	withCancel: replaced("ChordContext.scoped: closing its scope is the cancel"),
	awaitWithContext: replaced("ChordContext.aborted, raced with the Effect that awaits"),
	traceIn: replaced(
		"Effect.withSpan: ChordContext.scoped and ChordContext.timeout carry the fiber's current span (with PiTelemetry)",
	),
} satisfies Record<keyof typeof PiContext, Coverage>;

describe("the coverage of Chord's /context", () => {
	it("offers every value it records as offered, Chord's own and not copies", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiContext;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});
});
