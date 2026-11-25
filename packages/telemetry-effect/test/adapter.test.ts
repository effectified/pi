import {
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "@earendil-works/pi-telemetry/testing";
import { Context, Effect, Layer, Logger, Metric, Option, References, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { makeTelemetryContext, spanHandle } from "../src/adapter.ts";
import { failure, makeRecorder, type Recorder, traceparent } from "./recording-tracer.ts";

/** An adapter on a recording tracer, with a metric registry of its own. */
async function setup(): Promise<{ telemetry: TelemetryContext; recorder: Recorder }> {
	const recorder = makeRecorder();
	const telemetry = await Effect.runPromise(
		makeTelemetryContext.pipe(
			Effect.provideService(Tracer.Tracer, recorder.tracer),
			Effect.provideService(Metric.MetricRegistry, new Map()),
		),
	);
	return { telemetry, recorder };
}

/** The span handle a `startSpan` callback received, kept after the span has settled. */
async function settledSpan(telemetry: TelemetryContext, name: string): Promise<TelemetrySpan> {
	return telemetry.startSpan({ name }, (span) => span);
}

// The fixture supplies no `metrics`: the suite's metric cases read a log of single measurements with their exemplar
// span, and Effect metrics keep aggregates only. Those cases therefore return at once; `metrics.test.ts` checks the
// values Effect holds. The capability case still checks `context.metrics` on every context.
const conformance = createTelemetryAdapterConformance(async () => {
	const { telemetry, recorder } = await setup();
	return {
		context: telemetry,
		propagation: telemetry.propagation,
		getSpans: () => Promise.resolve(recorder.snapshots()),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	} satisfies TelemetryAdapterFixture;
});

describe("pi-telemetry conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("spans", () => {
	it("records a Pi span as an Effect span with its name, attributes, events and links", async () => {
		const { telemetry, recorder } = await setup();
		const target = await settledSpan(telemetry, "target");
		const result = await telemetry.startSpan(
			{
				name: "pi.durable.phase",
				attributes: { "task.id": "t1", attempt: 2, resumed: false, kinds: ["a", "b"], absent: undefined },
				links: [{ context: target, attributes: { reason: "trigger" } }],
			},
			(span) => {
				span.addEvent("pi.durable.checkpoint", { phase: "run", absent: undefined });
				span.addEvent("pi.durable.replay");
				span.setAttributes({ outcome: "done", attempt: 3, absent: undefined });
				span.addLink({ context: target });
				span.addLink({ context: NOOP_TELEMETRY_CONTEXT });
				span.addLink({ context: telemetry });
				return "value";
			},
		);

		expect(result).toBe("value");
		expect(recorder.spans.map((span) => span.name)).toEqual(["target", "pi.durable.phase"]);
		const span = recorder.span("pi.durable.phase");
		expect(Object.fromEntries(span.attributes)).toEqual({
			"task.id": "t1",
			attempt: 3,
			resumed: false,
			kinds: ["a", "b"],
			outcome: "done",
		});
		expect(span.events.map(([name, , attributes]) => [name, attributes])).toEqual([
			["pi.durable.checkpoint", { phase: "run" }],
			["pi.durable.replay", {}],
		]);
		expect(span.links).toEqual([
			{ span: recorder.span("target"), attributes: { reason: "trigger" } },
			{ span: recorder.span("target"), attributes: {} },
		]);
		expect(span.kind).toBe("internal");
		expect(Option.isNone(span.parent)).toBe(true);
		expect(failure(span)).toBe("ok");
	});

	it("nests Pi spans and gives each root its own trace", async () => {
		const { telemetry, recorder } = await setup();
		await telemetry.startSpan({ name: "parent" }, (parent) =>
			parent.startSpan({ name: "child" }, (child) => child.startSpan({ name: "grandchild" }, () => {})),
		);
		await telemetry.startSpan({ name: "other" }, () => {});

		const [parent, child, grandchild, other] = ["parent", "child", "grandchild", "other"].map(recorder.span);
		expect(Option.getOrUndefined(child?.parent ?? Option.none())).toBe(parent);
		expect(Option.getOrUndefined(grandchild?.parent ?? Option.none())).toBe(child);
		expect(grandchild?.traceId).toBe(parent?.traceId);
		expect(Option.isNone(other?.parent ?? Option.some(parent))).toBe(true);
		expect(other?.traceId).not.toBe(parent?.traceId);
	});

	it("starts root spans even when the adapter is made inside an Effect span", async () => {
		const recorder = makeRecorder();
		const telemetry = await Effect.runPromise(
			makeTelemetryContext.pipe(Effect.withSpan("build"), Effect.provideService(Tracer.Tracer, recorder.tracer)),
		);
		await telemetry.startSpan({ name: "root" }, () => {});
		expect(Option.isNone(recorder.span("root").parent)).toBe(true);
		expect(recorder.span("root").traceId).not.toBe(recorder.span("build").traceId);
	});

	it("records nothing and still runs every callback when Effect's tracing is switched off", async () => {
		const recorder = makeRecorder();
		const telemetry = await Effect.runPromise(
			makeTelemetryContext.pipe(
				Effect.provideService(Tracer.Tracer, recorder.tracer),
				Effect.provideService(References.TracerEnabled, false),
			),
		);
		let carrier: TelemetryCarrier | undefined = { traceparent: "unset" };
		const result = await telemetry.startSpan({ name: "disabled" }, (span) => {
			span.addEvent("dropped");
			carrier = span.propagation?.inject(span);
			return span.startSpan({ name: "disabled.child" }, () => 7);
		});
		expect(result).toBe(7);
		expect(carrier).toBeUndefined();
		expect(recorder.spans).toEqual([]);
	});

	it("ends a span with Pi's explicit status, the last one set", async () => {
		const { telemetry, recorder } = await setup();
		await telemetry.startSpan({ name: "failed" }, (span) => {
			span.setStatus({ status: "ok" });
			span.setStatus({ status: "error", error: { name: "task_failed", message: "The tool gave up" } });
		});
		await telemetry.startSpan({ name: "no-detail" }, (span) => span.setStatus({ status: "error" }));
		await telemetry.startSpan({ name: "recovered" }, (span) => {
			span.setStatus({ status: "error" });
			span.setStatus({ status: "ok" });
		});

		expect(failure(recorder.span("failed"))).toEqual({ name: "task_failed", message: "The tool gave up" });
		expect(failure(recorder.span("no-detail"))).toBeUndefined();
		expect(failure(recorder.span("recovered"))).toBe("ok");
	});

	it("ends a span as failed when its callback throws, with the error's name and message only", async () => {
		const { telemetry, recorder } = await setup();
		const thrown = Object.assign(new RangeError("out of range"), { prompt: "secret prompt" });
		const sync = telemetry.startSpan({ name: "sync" }, () => {
			throw thrown;
		});
		await expect(sync).rejects.toBe(thrown);
		const payload = { prompt: "secret prompt" };
		await expect(telemetry.startSpan({ name: "async" }, () => Promise.reject(payload))).rejects.toBe(payload);

		expect(failure(recorder.span("sync"))).toEqual({ name: "RangeError", message: "out of range" });
		expect(failure(recorder.span("async"))).toBeUndefined();
	});

	it("keeps a span open until its promise settles, and records nothing afterwards", async () => {
		const { telemetry, recorder } = await setup();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let handle: TelemetrySpan | undefined;
		const running = telemetry.startSpan({ name: "open", attributes: { value: "initial" } }, async (span) => {
			handle = span;
			await gate;
		});
		expect(recorder.span("open").status._tag).toBe("Started");
		release?.();
		await running;
		expect(recorder.span("open").status._tag).toBe("Ended");

		handle?.setAttributes({ value: "late" });
		handle?.addEvent("late");
		handle?.addLink({ context: handle });
		handle?.setStatus({ status: "error" });
		let admitted = false;
		const late = handle?.startSpan({ name: "late-child" }, (child) => {
			admitted = true;
			return child.startSpan({ name: "late-grandchild" }, () => 7);
		});
		expect(admitted).toBe(true);
		expect(await late).toBe(7);

		const span = recorder.span("open");
		expect(recorder.spans).toEqual([span]);
		expect(Object.fromEntries(span.attributes)).toEqual({ value: "initial" });
		expect(span.events).toEqual([]);
		expect(span.links).toEqual([]);
		expect(failure(span)).toBe("ok");
	});

	it("stamps the start, the events and the end with Effect's Clock", async () => {
		const recorder = makeRecorder();
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_000);
				const telemetry = yield* makeTelemetryContext;
				const context = yield* Effect.context<never>();
				const advance = (millis: number) => Effect.runPromiseWith(context)(TestClock.adjust(millis));
				yield* Effect.promise(() =>
					telemetry.startSpan({ name: "timed" }, async (span) => {
						await advance(5);
						span.addEvent("tick");
						await advance(7);
					}),
				);
			}).pipe(Effect.provideService(Tracer.Tracer, recorder.tracer), Effect.provide(TestClock.layer())),
		);

		const span = recorder.span("timed");
		expect(span.status).toMatchObject({ _tag: "Ended", startTime: 1_000_000_000n, endTime: 1_012_000_000n });
		expect(span.events).toEqual([["tick", 1_005_000_000n, {}]]);
	});

	it("reads no clock when Effect's span timing is switched off", async () => {
		const recorder = makeRecorder();
		const telemetry = await Effect.runPromise(
			makeTelemetryContext.pipe(
				Effect.provideService(Tracer.Tracer, recorder.tracer),
				Effect.provideService(References.TracerTimingEnabled, false),
			),
		);
		await telemetry.startSpan({ name: "untimed" }, (span) => span.addEvent("tick"));
		expect(recorder.span("untimed").status).toMatchObject({ _tag: "Ended", startTime: 0n, endTime: 0n });
		expect(recorder.span("untimed").events).toEqual([["tick", 0n, {}]]);
	});
});

describe("propagation", () => {
	it("injects a W3C traceparent and extracts it as the parent, in another adapter", async () => {
		const sender = await setup();
		const receiver = await setup();
		let carrier: TelemetryCarrier | undefined;
		await sender.telemetry.startSpan({ name: "sender" }, (span) => {
			carrier = span.propagation?.inject(span);
		});
		const sent = sender.recorder.span("sender");
		expect(carrier).toEqual({ traceparent: `00-${sent.traceId}-${sent.spanId}-01` });

		// The carrier is stored as JSON and read after a restart.
		const stored = JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier;
		await receiver.telemetry.propagation?.extract(stored).startSpan({ name: "receiver" }, () => {});
		const received = receiver.recorder.span("receiver");
		expect(received.traceId).toBe(sent.traceId);
		expect(Option.getOrThrow(received.parent)).toMatchObject({
			_tag: "ExternalSpan",
			traceId: sent.traceId,
			spanId: sent.spanId,
			sampled: true,
		});
		expect(received.spanId).not.toBe(sent.spanId);
	});

	it("extracts a malformed or absent carrier to the root, without throwing", async () => {
		const { telemetry, recorder } = await setup();
		const trace = "0af7651916cd43dd8448eb211c80319c";
		const malformed: (Record<string, unknown> | undefined)[] = [
			undefined,
			{},
			{ unknown: "format" },
			{ traceparent: "not a traceparent" },
			{ traceparent: `00-${trace}-b7ad6b7169203331` },
			{ traceparent: `ff-${trace}-b7ad6b7169203331-01` },
			{ traceparent: `00-${"0".repeat(32)}-b7ad6b7169203331-01` },
			{ traceparent: `00-${trace}-${"0".repeat(16)}-01` },
			{ traceparent: 42 },
		];
		for (const [index, carrier] of malformed.entries()) {
			// A carrier is wire input, so the cases include values its type forbids.
			const context = telemetry.propagation?.extract(carrier as TelemetryCarrier | undefined);
			expect(context, JSON.stringify(carrier)).toBe(telemetry);
			expect(await context?.startSpan({ name: `fallback-${index}` }, () => index)).toBe(index);
		}
		expect(recorder.spans).toHaveLength(malformed.length);
		for (const span of recorder.spans) expect(Option.isNone(span.parent), span.name).toBe(true);
	});

	it("carries the sampled flag and the tracestate through to the next carrier", async () => {
		const { telemetry, recorder } = await setup();
		const incoming = {
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
			tracestate: "vendor=opaque",
		};
		let outgoing: TelemetryCarrier | undefined;
		await telemetry.propagation?.extract(incoming).startSpan({ name: "phase" }, (phase) =>
			phase.startSpan({ name: "request" }, (request) => {
				outgoing = request.propagation?.inject(request);
			}),
		);
		const request = recorder.span("request");
		expect(request.sampled).toBe(false);
		expect(outgoing).toEqual({
			traceparent: `00-0af7651916cd43dd8448eb211c80319c-${request.spanId}-00`,
			tracestate: "vendor=opaque",
		});
	});

	it("injects an extracted parent and a settled span, and nothing for a context without a span", async () => {
		const { telemetry } = await setup();
		const carrier = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
		const propagation = telemetry.propagation;
		if (propagation === undefined) throw new Error("Expected the propagation capability");
		expect(propagation.inject(propagation.extract(carrier))).toEqual(carrier);
		const settled = await settledSpan(telemetry, "settled");
		expect(propagation.inject(settled)?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		expect(propagation.inject(telemetry)).toBeUndefined();
		expect(propagation.inject(NOOP_TELEMETRY_CONTEXT)).toBeUndefined();
		expect(propagation.inject(new InMemoryTelemetryContext())).toBeUndefined();
	});

	it("links a span to an extracted remote span", async () => {
		const { telemetry, recorder } = await setup();
		const carrier = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
		const remote = telemetry.propagation?.extract(carrier);
		if (remote === undefined) throw new Error("Expected an extracted context");
		await telemetry.startSpan(
			{ name: "background", links: [{ context: remote, attributes: { reason: "steer" } }] },
			() => {},
		);
		const [link] = recorder.span("background").links;
		expect(Option.isNone(recorder.span("background").parent)).toBe(true);
		expect(link?.attributes).toEqual({ reason: "steer" });
		expect(link === undefined ? undefined : traceparent(link.span)).toEqual(carrier);
	});
});

describe("spanHandle", () => {
	it("records Pi's events, attributes and links on an open Effect span, and leaves its status to its owner", async () => {
		const { telemetry, recorder } = await setup();
		const target = await settledSpan(telemetry, "target");
		const owned = await Effect.runPromise(
			Effect.makeSpan("owned").pipe(Effect.provideService(Tracer.Tracer, recorder.tracer)),
		);
		const handle = spanHandle(telemetry, Option.some(owned));
		handle.addEvent("pi.durable.report", { type: "host_error" });
		handle.setAttributes({ "task.id": "t1", absent: undefined });
		handle.addLink({ context: target, attributes: { reason: "trigger" } });
		handle.setStatus({ status: "error", error: { name: "Ignored", message: "not Pi's span" } });
		await handle.startSpan({ name: "pi.child" }, () => {});

		const span = recorder.span("owned");
		expect(span.status._tag).toBe("Started");
		expect(span.events.map(([name, , attributes]) => [name, attributes])).toEqual([
			["pi.durable.report", { type: "host_error" }],
		]);
		expect(Object.fromEntries(span.attributes)).toEqual({ "task.id": "t1" });
		expect(span.links).toEqual([{ span: recorder.span("target"), attributes: { reason: "trigger" } }]);
		expect(Option.getOrUndefined(recorder.span("pi.child").parent)).toBe(span);
		expect(handle.propagation?.inject(handle)).toEqual(traceparent(span));
		expect(handle.metrics).toBe(telemetry.metrics);
		expect(handle.propagation).toBe(telemetry.propagation);
	});

	it("sends an event without a span to the logger, as a line with the event's attributes", async () => {
		const recorder = makeRecorder();
		const lines: { message: unknown; level: string; annotations: unknown; parent: string | undefined }[] = [];
		const logger = Logger.make((options) => {
			lines.push({
				message: options.message,
				level: options.logLevel,
				annotations: options.fiber.getRef(References.CurrentLogAnnotations),
				parent: Option.getOrUndefined(Context.getOption(options.fiber.context, Tracer.ParentSpan))?.spanId,
			});
		});
		const telemetry = await Effect.runPromise(
			makeTelemetryContext.pipe(
				Effect.withSpan("build"),
				Effect.provide(Layer.merge(Logger.layer([logger]), Layer.succeed(Tracer.Tracer, recorder.tracer))),
			),
		);
		const root = spanHandle(telemetry, Option.none());
		root.addEvent("pi.durable.report", { type: "host_error", "task.id": undefined });
		root.setAttributes({ dropped: true });
		root.setStatus({ status: "error" });
		root.addLink({ context: root });
		const external = Tracer.externalSpan({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" });
		spanHandle(telemetry, Option.some(external)).addEvent("pi.durable.entry");

		expect(lines).toEqual([
			{ message: ["pi.durable.report"], level: "Info", annotations: { type: "host_error" }, parent: undefined },
			{ message: ["pi.durable.entry"], level: "Info", annotations: {}, parent: "b7ad6b7169203331" },
		]);
		expect(recorder.spans.map((span) => span.name)).toEqual(["build"]);
	});

	it("starts children of an external span, and root spans without a span", async () => {
		const { telemetry, recorder } = await setup();
		const external = Tracer.externalSpan({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" });
		await spanHandle(telemetry, Option.some(external)).startSpan({ name: "continued" }, () => {});
		await spanHandle(telemetry, Option.none()).startSpan({ name: "rooted" }, () => {});
		expect(Option.getOrUndefined(recorder.span("continued").parent)).toBe(external);
		expect(recorder.span("continued").traceId).toBe("0af7651916cd43dd8448eb211c80319c");
		expect(Option.isNone(recorder.span("rooted").parent)).toBe(true);
	});

	it("is inert once the Effect span has ended", async () => {
		const { telemetry, recorder } = await setup();
		const owned = await Effect.runPromise(
			Effect.makeSpan("owned").pipe(Effect.provideService(Tracer.Tracer, recorder.tracer)),
		);
		const handle = spanHandle(telemetry, Option.some(owned));
		owned.end(1n, Effect.runSyncExit(Effect.void));
		handle.addEvent("late");
		handle.setAttributes({ late: true });
		expect(await handle.startSpan({ name: "late-child" }, () => 7)).toBe(7);
		expect(recorder.spans).toEqual([owned]);
		expect(recorder.span("owned").events).toEqual([]);
		expect([...recorder.span("owned").attributes]).toEqual([]);
	});

	it("starts another adapter's root spans, because that adapter cannot take an Effect parent", async () => {
		const memory = new InMemoryTelemetryContext();
		const owned = await Effect.runPromise(Effect.makeSpan("owned"));
		const handle = spanHandle(memory, Option.some(owned));
		handle.addEvent("dropped");
		expect(await handle.startSpan({ name: "pi.span" }, () => 7)).toBe(7);
		expect(handle.metrics).toBe(memory);
		expect(handle.propagation).toBe(memory);
		expect(memory.getSpans().map((span) => [span.name, span.parentContext, span.events])).toEqual([
			["pi.span", null, []],
		]);
	});
});
