import { Context, Effect, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { fromCarrier, TraceState, toCarrier } from "../src/trace-context.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

describe("toCarrier", () => {
	it("writes a version 00 traceparent with the sampled flag", () => {
		expect(toCarrier(Tracer.externalSpan({ traceId: TRACE, spanId: SPAN }))).toEqual({
			traceparent: `00-${TRACE}-${SPAN}-01`,
		});
		expect(toCarrier(Tracer.externalSpan({ traceId: TRACE, spanId: SPAN, sampled: false }))).toEqual({
			traceparent: `00-${TRACE}-${SPAN}-00`,
		});
	});

	it("writes the ids of a span Effect's own tracer made", async () => {
		const span = await Effect.runPromise(Effect.makeSpan("native"));
		expect(toCarrier(span)).toEqual({ traceparent: `00-${span.traceId}-${span.spanId}-01` });
	});

	it("gives no carrier for ids that are not W3C ids", () => {
		const ids: [traceId: string, spanId: string][] = [
			["trace-1", SPAN],
			[TRACE, "span-1"],
			[TRACE.toUpperCase(), SPAN],
			["0".repeat(32), SPAN],
			[TRACE, "0".repeat(16)],
			[TRACE.slice(1), SPAN],
		];
		for (const [traceId, spanId] of ids) {
			expect(toCarrier(Tracer.externalSpan({ traceId, spanId })), `${traceId} ${spanId}`).toBeUndefined();
		}
	});

	it("passes on the tracestate its trace arrived with, from any depth", async () => {
		const entry = Option.getOrThrow(
			fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: "vendor=opaque,other=1" }),
		);
		const child = await Effect.runPromise(Effect.makeSpan("child", { parent: entry }));
		const grandchild = await Effect.runPromise(Effect.makeSpan("grandchild", { parent: child }));
		expect(toCarrier(grandchild)).toEqual({
			traceparent: `00-${TRACE}-${grandchild.spanId}-01`,
			tracestate: "vendor=opaque,other=1",
		});
	});
});

describe("fromCarrier", () => {
	it("reads the trace id, parent id and sampled flag", () => {
		const sampled = Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-01` }));
		expect(sampled).toMatchObject({ _tag: "ExternalSpan", traceId: TRACE, spanId: SPAN, sampled: true });
		expect(Context.get(sampled.annotations, TraceState)).toBeUndefined();
		const unsampled = Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-00` }));
		expect(unsampled.sampled).toBe(false);
		// Only the lowest flag bit means sampled.
		expect(Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-03` })).sampled).toBe(true);
		expect(Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-02` })).sampled).toBe(false);
	});

	it("keeps a tracestate and ignores an empty one", () => {
		const span = Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: "a=1" }));
		expect(Context.get(span.annotations, TraceState)).toBe("a=1");
		const empty = Option.getOrThrow(fromCarrier({ traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: "" }));
		expect(Context.get(empty.annotations, TraceState)).toBeUndefined();
	});

	it("accepts a later version with parts it does not know", () => {
		const span = Option.getOrThrow(fromCarrier({ traceparent: `01-${TRACE}-${SPAN}-01-future` }));
		expect(span).toMatchObject({ traceId: TRACE, spanId: SPAN, sampled: true });
	});

	it("gives none for an absent or malformed carrier", () => {
		const malformed: (Record<string, unknown> | undefined)[] = [
			undefined,
			{},
			{ unknown: "format" },
			{ traceparent: "" },
			{ traceparent: "mutated" },
			{ traceparent: `00-${TRACE}-${SPAN}` },
			{ traceparent: `00-${TRACE}-${SPAN}-01-extra` },
			{ traceparent: `ff-${TRACE}-${SPAN}-01` },
			{ traceparent: `0-${TRACE}-${SPAN}-01` },
			{ traceparent: `00-${TRACE.toUpperCase()}-${SPAN}-01` },
			{ traceparent: `00-${TRACE.slice(2)}-${SPAN}-01` },
			{ traceparent: `00-${"0".repeat(32)}-${SPAN}-01` },
			{ traceparent: `00-${TRACE}-${"0".repeat(16)}-01` },
			{ traceparent: `00-${TRACE}-${SPAN}-zz` },
			{ traceparent: `00-${TRACE}-${SPAN}-1` },
			{ traceparent: 42 },
			{ traceparent: null },
			{ traceparent: [`00-${TRACE}-${SPAN}-01`] },
		];
		for (const carrier of malformed) {
			// A carrier is wire input, so the cases include values its type forbids.
			const span = fromCarrier(carrier as Record<string, string> | undefined);
			expect(Option.isNone(span), JSON.stringify(carrier)).toBe(true);
		}
	});

	it("drops a tracestate that is not a string", () => {
		const carrier = { traceparent: `00-${TRACE}-${SPAN}-01`, tracestate: 7 };
		// A carrier is wire input, so the case is a value its type forbids.
		const span = Option.getOrThrow(fromCarrier(carrier as unknown as Record<string, string>));
		expect(Context.get(span.annotations, TraceState)).toBeUndefined();
	});
});
