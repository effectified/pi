import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";
import { Effect, Metric, Option, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { PiTelemetry, TypedSpans } from "../src/index.ts";
import { failure, makeRecorder, type Recorder } from "./recording-tracer.ts";

const schema = defineTelemetrySchema({
	version: 1,
	spans: {
		"example.read": {
			description: "Read one resource",
			parents: { kind: "any" },
			startAttributes: { resource: { type: "string", required: true, description: "Resource kind" } },
			endAttributes: { count: { type: "number", description: "Items read" } },
			events: {
				"example.cache_miss": {
					description: "The cache had no entry",
					attributes: { key: { type: "string", required: true, description: "Cache key" } },
				},
				"example.retry": { description: "A retry", attributes: {} },
			},
			status: { default: "ok", errorWhen: "The read fails" },
		},
	},
} as const);

const spans = TypedSpans.make([schema]);

/** Runs `program` on a recording tracer, the adapter and the test clock. */
function run<A, E>(recorder: Recorder, program: Effect.Effect<A, E, PiTelemetry>): Promise<A> {
	return Effect.runPromise(
		program.pipe(
			Effect.provide(PiTelemetry.layer),
			Effect.provide(TestClock.layer()),
			Effect.provideService(Tracer.Tracer, recorder.tracer),
			Effect.provideService(Metric.MetricRegistry, new Map()),
		),
	);
}

describe("TypedSpans.make", () => {
	it("runs an Effect in a span of the schema's name, with its start and end attributes and its events", async () => {
		const recorder = makeRecorder();
		const result = await run(
			recorder,
			spans.withSpan("example.read", { resource: "account" }, (span) =>
				Effect.gen(function* () {
					yield* TestClock.adjust("5 millis");
					yield* span.addEvent("example.cache_miss", { key: "a" });
					yield* span.addEvent("example.retry");
					yield* span.setAttributes({ count: 3 });
					return "read";
				}),
			),
		);
		expect(result).toBe("read");
		const read = recorder.span("example.read");
		expect(Object.fromEntries(read.attributes)).toEqual({ resource: "account", count: 3 });
		expect(read.events).toEqual([
			["example.cache_miss", 5_000_000n, { key: "a" }],
			["example.retry", 5_000_000n, {}],
		]);
		expect(failure(read)).toBe("ok");
	});

	it("makes the Effects and the Pi spans of its body its children", async () => {
		const recorder = makeRecorder();
		await run(
			recorder,
			spans
				.withSpan("example.read", { resource: "account" }, () =>
					Effect.gen(function* () {
						yield* Effect.withSpan(Effect.void, "inner");
						const pi = yield* PiTelemetry.currentSpan;
						yield* Effect.promise(() => pi.startSpan({ name: "pi.call" }, () => {}));
					}),
				)
				.pipe(Effect.withSpan("outer")),
		);
		const read = recorder.span("example.read");
		expect(Option.getOrUndefined(read.parent)).toBe(recorder.span("outer"));
		expect(Option.getOrUndefined(recorder.span("inner").parent)).toBe(read);
		expect(Option.getOrUndefined(recorder.span("pi.call").parent)).toBe(read);
	});

	it("ends the span failed with its Effect's failure", async () => {
		const recorder = makeRecorder();
		const error = new Error("not found");
		await run(
			recorder,
			Effect.exit(spans.withSpan("example.read", { resource: "account" }, () => Effect.fail(error))),
		);
		expect(failure(recorder.span("example.read"))).toBe(error);
	});

	it("types names, attributes and events by the schemas", () => {
		const typeOnly = [
			// @ts-expect-error a required start attribute is missing
			spans.withSpan("example.read", {}, () => Effect.void),
			// @ts-expect-error a name no schema declares
			spans.withSpan("example.unknown", {}, () => Effect.void),
			spans.withSpan("example.read", { resource: "account" }, (span) =>
				Effect.gen(function* () {
					// @ts-expect-error an event's required attribute is missing
					yield* span.addEvent("example.cache_miss");
					// @ts-expect-error an attribute the schema does not declare for after the start
					yield* span.setAttributes({ resource: "other" });
				}),
			),
		];
		// @ts-expect-error two schemas declare one span name
		TypedSpans.make([schema, schema]);
		expect(typeOnly.every(Effect.isEffect)).toBe(true);
	});
});
