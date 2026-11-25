import { NOOP_TELEMETRY_CONTEXT, type TelemetryMetrics } from "@earendil-works/pi-telemetry";
import { Context, Effect, Metric } from "effect";
import { describe, expect, it } from "vitest";
import { makeMetrics } from "../src/metrics.ts";

/** Pi's metric capability on a registry of its own, and a reader of that registry's series. */
function setup(): { metrics: TelemetryMetrics; series: (id: string) => readonly Metric.Metric.Snapshot[] } {
	const context = Context.make(Metric.MetricRegistry, new Map());
	return {
		metrics: makeMetrics(context),
		series: (id) => Metric.snapshotUnsafe(context).filter((snapshot) => snapshot.id === id),
	};
}

describe("counter", () => {
	it("adds to an incremental Effect counter, one series per attribute set", () => {
		const { metrics, series } = setup();
		const bytes = metrics.counter("network.bytes", { description: "Encoded bytes", unit: "By" });
		bytes.add(12, { direction: "out" });
		bytes.add(30, { direction: "out" });
		bytes.add(5, { direction: "in", missing: undefined });
		bytes.add(1);
		expect(series("network.bytes")).toEqual([
			{
				id: "network.bytes",
				type: "Counter",
				description: "Encoded bytes",
				attributes: { unit: "By", direction: "out" },
				state: { count: 42, incremental: true },
			},
			{
				id: "network.bytes",
				type: "Counter",
				description: "Encoded bytes",
				attributes: { unit: "By", direction: "in" },
				state: { count: 5, incremental: true },
			},
			{
				id: "network.bytes",
				type: "Counter",
				description: "Encoded bytes",
				attributes: { unit: "By" },
				state: { count: 1, incremental: true },
			},
		]);
	});

	it("updates the metric an Effect program reads under the same name", async () => {
		const registry = new Map();
		const context = Context.make(Metric.MetricRegistry, registry);
		makeMetrics(context).counter("pi.ai.tokens").add(7, { kind: "input" });
		const tokens = Metric.withAttributes(Metric.counter("pi.ai.tokens", { incremental: true }), { kind: "input" });
		const state = await Effect.runPromise(
			Metric.update(tokens, 3).pipe(
				Effect.andThen(Metric.value(tokens)),
				Effect.provideService(Metric.MetricRegistry, registry),
			),
		);
		expect(state).toEqual({ count: 10, incremental: true });
	});
});

describe("upDownCounter", () => {
	it("is an Effect counter that goes down as well as up", () => {
		const { metrics, series } = setup();
		const active = metrics.upDownCounter("tasks.active");
		active.add(1, { task: "run" });
		active.add(1, { task: "run" });
		active.add(-1, { task: "run" });
		expect(series("tasks.active")).toEqual([
			{
				id: "tasks.active",
				type: "Counter",
				description: undefined,
				attributes: { task: "run" },
				state: { count: 1, incremental: false },
			},
		]);
	});
});

describe("histogram", () => {
	it("records into the buckets Pi declared", () => {
		const { metrics, series } = setup();
		const boundaries = [1, 10];
		const options = { description: "Call duration", unit: "ms", boundaries };
		const duration = metrics.histogram("call.duration", options);
		// The instrument keeps what it was created with.
		boundaries.push(100);
		options.description = "Changed";
		duration.record(0.5, { method: "read" });
		duration.record(5, { method: "read" });
		duration.record(50, { method: "read" });
		expect(series("call.duration")).toEqual([
			{
				id: "call.duration",
				type: "Histogram",
				description: "Call duration",
				attributes: { unit: "ms", method: "read" },
				state: {
					buckets: [
						[1, 1],
						[10, 2],
					],
					count: 3,
					min: 0.5,
					max: 50,
					sum: 55.5,
				},
			},
		]);
	});

	it("uses the OpenTelemetry default buckets when Pi declares none", () => {
		const { metrics, series } = setup();
		metrics.histogram("pi.ai.request.duration").record(30);
		const [snapshot] = series("pi.ai.request.duration");
		if (snapshot?.type !== "Histogram") throw new Error("Expected one histogram series");
		expect(snapshot.state.buckets.map(([boundary]) => boundary)).toEqual([
			0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
		]);
		expect(snapshot.state.buckets.find(([boundary]) => boundary === 50)).toEqual([50, 1]);
		expect(snapshot.state.buckets.find(([boundary]) => boundary === 25)).toEqual([25, 0]);
	});

	it("records the same value with or without an exemplar context", () => {
		const { metrics, series } = setup();
		const histogram = metrics.histogram("exemplar", { boundaries: [10] });
		histogram.record(4, { method: "read" }, NOOP_TELEMETRY_CONTEXT);
		histogram.record(6, { method: "read" });
		expect(series("exemplar").map((snapshot) => snapshot.state)).toEqual([
			{ buckets: [[10, 2]], count: 2, min: 4, max: 6, sum: 10 },
		]);
	});
});
