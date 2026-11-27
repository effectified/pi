import { createTypedSpanStarter, defineTelemetrySchema, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Data, Effect, Layer, Metric, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { PiTelemetry } from "../src/index.ts";
import { failure, makeRecorder, type Recorder } from "./recording-tracer.ts";

/** Runs `program` with the adapter Layer on a recording tracer and a metric registry of its own. */
function run<A>(recorder: Recorder, program: Effect.Effect<A, never, PiTelemetry>): Promise<A> {
	return Effect.runPromise(
		program.pipe(
			Effect.provide(PiTelemetry.layer),
			Effect.provideService(Tracer.Tracer, recorder.tracer),
			Effect.provideService(Metric.MetricRegistry, new Map()),
		),
	);
}

/** A Pi call's rejection, in the error channel of the Effect that made the call. */
class PiCallRejected extends Data.TaggedError("PiCallRejected")<{ readonly cause: unknown }> {}

/** Pi code under test: it takes the span of its caller, as a Chord context carries it, and starts its own below. */
function piCall(telemetry: TelemetrySpan): Promise<string> {
	return telemetry.startSpan({ name: "pi.ai.request", attributes: { provider: "scripted" } }, async (span) => {
		span.addEvent("pi.ai.first_chunk");
		telemetry.addEvent("pi.durable.entry", { "entry.id": "e1" });
		return "answer";
	});
}

describe("PiTelemetry", () => {
	it("gives the TelemetryContext a host hands to Pi, with every capability", async () => {
		const recorder = makeRecorder();
		const registry = new Map();
		const telemetry = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* PiTelemetry;
			}).pipe(
				Effect.provide(PiTelemetry.layer),
				Effect.provideService(Tracer.Tracer, recorder.tracer),
				Effect.provideService(Metric.MetricRegistry, registry),
			),
		);

		// The value outlives the Layer's scope: the contract has no shutdown step, so nothing was closed.
		const schema = defineTelemetrySchema({
			version: 1,
			spans: {
				"example.read": {
					description: "Read one resource",
					parents: { kind: "any" },
					startAttributes: { resource: { type: "string", required: true, description: "Resource kind" } },
					endAttributes: { count: { type: "number", description: "Items read" } },
					status: { default: "ok", errorWhen: "The read throws" },
				},
			},
		} as const);
		await createTypedSpanStarter(telemetry, [schema])("example.read", { resource: "account" }, (span) =>
			span.setAttributes({ count: 3 }),
		);
		telemetry.metrics?.counter("example.reads").add(2, { resource: "account" });

		expect(Object.fromEntries(recorder.span("example.read").attributes)).toEqual({ resource: "account", count: 3 });
		expect(telemetry.propagation?.extract(undefined)).toBe(telemetry);
		const reads = Metric.withAttributes(Metric.counter("example.reads", { incremental: true }), {
			resource: "account",
		});
		expect(
			await Effect.runPromise(Metric.value(reads).pipe(Effect.provideService(Metric.MetricRegistry, registry))),
		).toEqual({ count: 2, incremental: true });
	});

	it("builds one adapter per Layer build", async () => {
		const recorder = makeRecorder();
		const [first, second] = await run(
			recorder,
			Effect.gen(function* () {
				return [yield* PiTelemetry, yield* PiTelemetry] as const;
			}),
		);
		expect(first).toBe(second);
		expect(first.metrics).toBe(second.metrics);
	});
});

describe("PiTelemetry.currentSpan", () => {
	it("makes the spans Pi starts children of the current Effect span", async () => {
		const recorder = makeRecorder();
		const answer = await run(
			recorder,
			Effect.gen(function* () {
				const span = yield* PiTelemetry.currentSpan;
				return yield* Effect.promise(() => piCall(span));
			}).pipe(Effect.withSpan("outer"), Effect.withSpan("request")),
		);

		expect(answer).toBe("answer");
		expect(recorder.spans.map((span) => span.name)).toEqual(["request", "outer", "pi.ai.request"]);
		const outer = recorder.span("outer");
		const request = recorder.span("pi.ai.request");
		expect(Option.getOrUndefined(request.parent)).toBe(outer);
		expect(request.traceId).toBe(recorder.span("request").traceId);
		expect(Object.fromEntries(request.attributes)).toEqual({ provider: "scripted" });
		expect(request.events.map(([name]) => name)).toEqual(["pi.ai.first_chunk"]);
		// What Pi records on its caller's span lands on the Effect span.
		expect(outer.events.map(([name, , attributes]) => [name, attributes])).toEqual([
			["pi.durable.entry", { "entry.id": "e1" }],
		]);
		expect(failure(outer)).toBe("ok");
		expect(failure(request)).toBe("ok");
	});

	it("gives each Effect span its own handle, so sibling Pi calls do not share a parent", async () => {
		const recorder = makeRecorder();
		const call = (name: string) =>
			Effect.flatMap(PiTelemetry.currentSpan, (span) => Effect.promise(() => piCall(span))).pipe(
				Effect.withSpan(name),
			);
		await run(recorder, Effect.all([call("left"), call("right")], { concurrency: 2 }));

		const requests = recorder.spans.filter((span) => span.name === "pi.ai.request");
		const parents = requests.map((span) => Option.getOrUndefined(span.parent));
		expect(parents).toHaveLength(2);
		expect(parents).toContain(recorder.span("left"));
		expect(parents).toContain(recorder.span("right"));
		expect(requests).toHaveLength(2);
		expect(requests[0]?.traceId).not.toBe(requests[1]?.traceId);
	});

	it("continues an external parent the Effect program runs under", async () => {
		const recorder = makeRecorder();
		const external = Tracer.externalSpan({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" });
		await run(
			recorder,
			Effect.flatMap(PiTelemetry.currentSpan, (span) =>
				Effect.promise(() => span.startSpan({ name: "pi.span" }, () => {})),
			).pipe(Effect.withParentSpan(external)),
		);
		expect(Option.getOrUndefined(recorder.span("pi.span").parent)).toBe(external);
	});

	it("starts root spans outside any Effect span", async () => {
		const recorder = makeRecorder();
		await run(
			recorder,
			Effect.flatMap(PiTelemetry.currentSpan, (span) =>
				Effect.promise(() => span.startSpan({ name: "pi.span" }, () => {})),
			),
		);
		expect(recorder.spans.map((span) => span.name)).toEqual(["pi.span"]);
		expect(Option.isNone(recorder.span("pi.span").parent)).toBe(true);
	});

	it("marks the Effect span failed when the Pi call rejects, through Effect's own error channel", async () => {
		const recorder = makeRecorder();
		const error = new Error("provider down");
		const exit = await run(
			recorder,
			Effect.gen(function* () {
				const span = yield* PiTelemetry.currentSpan;
				return yield* Effect.tryPromise({
					try: () =>
						span.startSpan({ name: "pi.span" }, () => {
							throw error;
						}),
					catch: (cause) => new PiCallRejected({ cause }),
				});
			}).pipe(Effect.withSpan("outer"), Effect.exit),
		);

		expect(exit._tag).toBe("Failure");
		expect(failure(recorder.span("pi.span"))).toEqual({ name: "Error", message: "provider down" });
		const outer = failure(recorder.span("outer"));
		expect(outer).toBeInstanceOf(PiCallRejected);
		// The adapter passed the thrown error on unchanged.
		expect(outer instanceof PiCallRejected ? outer.cause : undefined).toBe(error);
	});

	it("uses the adapter a Layer provides, also when the Layer is built inside a span", async () => {
		const recorder = makeRecorder();
		const layer = Layer.provide(PiTelemetry.layer, Layer.succeed(Tracer.Tracer, recorder.tracer));
		await Effect.runPromise(
			Effect.gen(function* () {
				const telemetry = yield* PiTelemetry;
				yield* Effect.promise(() => telemetry.startSpan({ name: "pi.root" }, () => {}));
			}).pipe(Effect.provide(layer), Effect.withSpan("app")),
		);
		expect(Option.isNone(recorder.span("pi.root").parent)).toBe(true);
	});
});
