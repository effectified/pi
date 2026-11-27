// W3C Trace Context carriers over Effect's span context: a span as `traceparent`, a carrier as an external span.

import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { Context, Option, pipe, Schema, SchemaTransformation, String as Str, Tracer } from "effect";

/**
 * The `tracestate` a carrier arrived with, kept in the annotations of its external span. A carrier written for any
 * span below that external span passes it on unchanged, as W3C Trace Context asks of a participant that does not
 * change it.
 */
export const TraceState: Context.Reference<string | undefined> = Context.Reference<string | undefined>(
	"@effectified/pi-telemetry/trace-context/TraceState",
	{ defaultValue: () => undefined },
);

/**
 * The carrier of `span`: `traceparent` (version 00), and the `tracestate` its trace arrived with. `undefined` when the
 * tracer's ids are not W3C ids (32 and 16 lowercase hex digits, not all zero), so no invalid header is ever stored.
 */
export function toCarrier(span: Tracer.AnySpan): TelemetryCarrier | undefined {
	const header = Schema.encodeOption(TraceParent)({
		traceId: span.traceId,
		spanId: span.spanId,
		sampled: span.sampled,
	});
	return Option.getOrUndefined(
		Option.map(header, (traceparent): TelemetryCarrier => {
			const tracestate = Context.get(entrySpan(span).annotations, TraceState);
			return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
		}),
	);
}

/**
 * The external span `carrier` names, to be the parent of what continues its trace. None when the carrier is absent,
 * has no `traceparent`, or its `traceparent` is malformed; a `tracestate` that is not a non-empty string is dropped.
 * A carrier is wire input: it may have been stored by another version or another adapter, so both headers are decoded
 * here and nothing in them can make this throw.
 */
export function fromCarrier(carrier: TelemetryCarrier | undefined): Option.Option<Tracer.ExternalSpan> {
	return Option.map(Schema.decodeUnknownOption(TraceParent)(carrier?.traceparent), (parent) =>
		Tracer.externalSpan({
			...parent,
			annotations: Option.getOrUndefined(
				Option.map(Schema.decodeUnknownOption(Schema.NonEmptyString)(carrier?.tracestate), (tracestate) =>
					Context.make(TraceState, tracestate),
				),
			),
		}),
	);
}

/** A W3C trace id: 32 lowercase hex digits; the all-zero id is the invalid one. */
const TraceId = Schema.String.check(Schema.isPattern(/^(?!0{32})[0-9a-f]{32}$/));

/** A W3C parent id, the span's: 16 lowercase hex digits; the all-zero id is the invalid one. */
const SpanId = Schema.String.check(Schema.isPattern(/^(?!0{16})[0-9a-f]{16}$/));

/** What a `traceparent` names: the trace, the span in it that is the parent, and whether the trace is sampled. */
const SpanContext = Schema.Struct({ traceId: TraceId, spanId: SpanId, sampled: Schema.Boolean });

/**
 * The shape of a `traceparent`: version, trace id, parent id and flags, each lowercase hex. Version ff is forbidden;
 * version 00 has exactly four parts, a later version may append more.
 */
const TRACEPARENT =
	/^(?:00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}|(?!00|ff)[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}(?:-.*)?)$/;

/**
 * A `traceparent` header as the span context it names. Decoding reads any version's first four parts and only the
 * lowest flag bit (sampled); encoding writes version 00. Both directions check the ids, so neither reads nor writes
 * an invalid header.
 */
const TraceParent = Schema.String.check(Schema.isPattern(TRACEPARENT)).pipe(
	Schema.decodeTo(
		SpanContext,
		SchemaTransformation.transform({
			decode: (header: string) => {
				const [, traceId = "", spanId = "", flags = ""] = pipe(header, Str.split("-"));
				return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
			},
			encode: (context: typeof SpanContext.Type) =>
				`00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`,
		}),
	),
);

/** The span a trace entered this process with: the topmost ancestor, external when the trace came from a carrier. */
function entrySpan(span: Tracer.AnySpan): Tracer.AnySpan {
	let current = span;
	while (current._tag === "Span" && Option.isSome(current.parent)) current = current.parent.value;
	return current;
}
