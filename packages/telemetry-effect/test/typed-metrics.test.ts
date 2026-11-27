import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";
import { Effect, Metric } from "effect";
import { describe, expect, it } from "vitest";
import { PiTelemetry, TypedMetrics } from "../src/index.ts";

const schema = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"example.reads": {
			kind: "counter",
			description: "Reads",
			unit: "{read}",
			attributes: { resource: { type: "string", required: true, description: "Resource kind" } },
		},
		"example.active": { kind: "upDownCounter", description: "Active reads", attributes: {} },
		"example.duration": {
			kind: "histogram",
			description: "Read duration",
			unit: "ms",
			boundaries: [10, 100],
			attributes: { resource: { type: "string", required: false, description: "Resource kind" } },
		},
	},
} as const);

/** Runs `program` with the adapter on a registry of its own, and gives the registry's series after it. */
async function measure(
	program: Effect.Effect<unknown, never, PiTelemetry>,
): Promise<readonly Metric.Metric.Snapshot[]> {
	const registry = new Map();
	await Effect.runPromise(
		program.pipe(Effect.provide(PiTelemetry.layer), Effect.provideService(Metric.MetricRegistry, registry)),
	);
	return Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)));
}

describe("TypedMetrics.make", () => {
	it("measures a schema's instruments as Effects, with the schema's description, unit and boundaries", async () => {
		const series = await measure(
			Effect.gen(function* () {
				const metrics = yield* TypedMetrics.make([schema]);
				yield* metrics.counter("example.reads").add(2, { resource: "account" });
				yield* metrics.upDownCounter("example.active").add(1);
				yield* metrics.upDownCounter("example.active").add(-1);
				yield* metrics.histogram("example.duration").record(50);
			}),
		);
		expect(series).toEqual([
			{
				id: "example.reads",
				type: "Counter",
				description: "Reads",
				attributes: { unit: "{read}", resource: "account" },
				state: { count: 2, incremental: true },
			},
			{
				id: "example.active",
				type: "Counter",
				description: "Active reads",
				attributes: undefined,
				state: { count: 0, incremental: false },
			},
			{
				id: "example.duration",
				type: "Histogram",
				description: "Read duration",
				attributes: { unit: "ms" },
				state: {
					buckets: [
						[10, 0],
						[100, 1],
					],
					count: 1,
					min: 50,
					max: 50,
					sum: 50,
				},
			},
		]);
	});

	it("measures nothing until its Effect runs", async () => {
		const series = await measure(
			Effect.gen(function* () {
				const metrics = yield* TypedMetrics.make([schema]);
				// Made, never run.
				const unrun = metrics.counter("example.reads").add(1, { resource: "account" });
				expect(Effect.isEffect(unrun)).toBe(true);
			}),
		);
		expect(series).toEqual([]);
	});

	it("types names, kinds and attributes by the schemas", () => {
		const typeOnly = Effect.gen(function* () {
			const metrics = yield* TypedMetrics.make([schema]);
			// @ts-expect-error a counter's required attribute is missing
			yield* metrics.counter("example.reads").add(1);
			return [
				// @ts-expect-error a histogram is not a counter
				metrics.counter("example.duration"),
				// @ts-expect-error a name no schema declares
				metrics.histogram("example.unknown"),
			];
		});
		expect(Effect.isEffect(typeOnly)).toBe(true);
	});
});
