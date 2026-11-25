// A recording Effect tracer for tests: it keeps every span it creates and reads them as pi-telemetry's snapshots.

import type { RecordedTelemetrySpan, SpanAttributes, SpanStatus, TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { Cause, Exit, Option, Tracer } from "effect";

/** A tracer and what it has recorded. */
export interface Recorder {
	readonly tracer: Tracer.Tracer;
	/** Every span the tracer created, in start order. */
	readonly spans: Tracer.NativeSpan[];
	/** The first span with `name`; the test fails when there is none. */
	span(name: string): Tracer.NativeSpan;
	/** The spans as pi-telemetry's conformance suite reads them. */
	snapshots(): RecordedTelemetrySpan[];
}

/** A fresh recorder: Effect's own in-memory spans, kept in start order and in end order. */
export function makeRecorder(): Recorder {
	const spans: Tracer.NativeSpan[] = [];
	const ended: Tracer.Span[] = [];
	class RecordingSpan extends Tracer.NativeSpan {
		override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
			if (this.status._tag === "Started") ended.push(this);
			super.end(endTime, exit);
		}
	}
	return {
		tracer: Tracer.make({
			span: (options) => {
				const span = new RecordingSpan(options);
				spans.push(span);
				return span;
			},
		}),
		spans,
		span: (name) => {
			const span = spans.find((candidate) => candidate.name === name);
			if (span === undefined) throw new Error(`No recorded span ${name}`);
			return span;
		},
		snapshots: () =>
			spans.map((span, index): RecordedTelemetrySpan => {
				const parent = Option.getOrUndefined(span.parent);
				const parentIndex = spans.findIndex((candidate) => candidate.spanId === parent?.spanId);
				const endIndex = ended.indexOf(span);
				return {
					id: index + 1,
					parentId: parentIndex === -1 ? null : parentIndex + 1,
					context: traceparent(span),
					parentContext: parent === undefined ? null : traceparent(parent),
					links: span.links.map((link) => ({
						context: traceparent(link.span),
						// The adapter only ever writes pi-telemetry attribute values into a link.
						attributes: link.attributes as SpanAttributes,
					})),
					name: span.name,
					// The adapter only ever writes pi-telemetry attribute values into a span or an event.
					attributes: Object.fromEntries(span.attributes) as SpanAttributes,
					events: span.events.map(([name, , attributes]) => ({ name, attributes: attributes as SpanAttributes })),
					status: piStatus(span),
					settled: span.status._tag === "Ended",
					...(endIndex === -1 ? {} : { endSequence: endIndex + 1 }),
				};
			}),
	};
}

/** The W3C carrier of a sampled span, written by hand so the adapter's own codec is not what checks it. */
export function traceparent(span: Tracer.AnySpan): TelemetryCarrier {
	return { traceparent: `00-${span.traceId}-${span.spanId}-01` };
}

/** What a span's exit failed with: `{ name, message }`, `undefined` for a failure without detail, or `"ok"`. */
export function failure(span: Tracer.Span): unknown {
	if (span.status._tag !== "Ended") throw new Error(`Span ${span.name} has not ended`);
	const exit = span.status.exit;
	return Exit.isSuccess(exit) ? "ok" : Option.getOrThrow(Cause.findErrorOption(exit.cause));
}

function piStatus(span: Tracer.Span): SpanStatus {
	if (span.status._tag !== "Ended") return { status: "ok" };
	const failed = failure(span);
	if (failed === "ok") return { status: "ok" };
	// The adapter fails a span with Pi's `{ name, message }` or with nothing.
	return failed === undefined
		? { status: "error" }
		: { status: "error", error: failed as { name: string; message: string } };
}
