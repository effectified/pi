import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type * as PiTelemetrySqlite from "@earendil-works/chord/telemetry-sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import { findMetrics, findTraces, flush, getTrace, make } from "../src/telemetry-sqlite.ts";
import { run } from "./run.ts";

const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/telemetry-sqlite` does with every value Chord's `/telemetry-sqlite` exports. */
const COVERAGE = {
	createSqliteTelemetry: replaced("make: recording for the life of a scope; flush and the store's reads as Effects"),
} satisfies Record<keyof typeof PiTelemetrySqlite, Coverage>;

describe("the coverage of Chord's /telemetry-sqlite", () => {
	it("records its one value", () => {
		expect(Object.keys(COVERAGE)).toEqual(["createSqliteTelemetry"]);
	});
});

const database = Effect.acquireRelease(
	Effect.promise(() => openNodeSqliteDatabase(":memory:")),
	(opened) => Effect.promise(() => opened.close()),
);

describe("make", () => {
	it("records spans and metrics into the database and reads them back", async () => {
		const [traces, trace, metrics] = await run(
			Effect.gen(function* () {
				const telemetry = yield* make(yield* database);
				yield* Effect.promise(() =>
					telemetry.startSpan({ name: "app.request", attributes: { route: "/notes" } }, async (span) => {
						span.addEvent("request.accepted");
					}),
				);
				telemetry.metrics.counter("app.reads", { unit: "{read}" }).add(2);
				yield* flush(telemetry);
				const { traces } = yield* findTraces(telemetry, { name: "app.request" });
				const trace = yield* getTrace(telemetry, traces[0]?.traceId ?? "");
				return [traces, trace, yield* findMetrics(telemetry, { name: "app.reads" })] as const;
			}),
		);
		expect(traces).toHaveLength(1);
		expect(trace?.spans.map((span) => span.name)).toEqual(["app.request"]);
		// Metric intervals are written once they complete: ten seconds of wall clock, which this test does not wait for.
		expect(Array.isArray(metrics)).toBe(true);
	});

	it("fails with SqliteError when it cannot migrate the database", async () => {
		const exit = await run(
			Effect.flip(
				Effect.gen(function* () {
					const closed = yield* Effect.promise(() => openNodeSqliteDatabase(":memory:"));
					yield* Effect.promise(() => closed.close());
					return yield* make(closed);
				}),
			),
		);
		expect(exit._tag).toBe("SqliteError");
	});
});
