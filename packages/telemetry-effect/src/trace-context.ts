// W3C Trace Context carriers over Effect's span context: a span as `traceparent`, a carrier as an external span.

import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { Context, Option, Tracer } from "effect";

/**
 * The `tracestate` a carrier arrived with, kept in the annotations of its external span. A carrier written for any
 * span below that external span passes it on unchanged, as W3C Trace Context asks of a participant that does not
 * change it.
 */
export const TraceState: Context.Reference<string | undefined> = Context.Reference<string | undefined>(
	"@effectified/pi-telemetry/TraceState",
	{ defaultValue: () => undefined },
);

/**
 * The carrier of `span`: `traceparent` (version 00), and the `tracestate` its trace arrived with. `undefined` when the
 * tracer's ids are not W3C ids (32 and 16 lowercase hex digits, not all zero), so no invalid header is ever stored.
 */
export function toCarrier(span: Tracer.AnySpan): TelemetryCarrier | undefined {
	if (!isId(span.traceId, 32) || !isId(span.spanId, 16)) return undefined;
	const traceparent = `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`;
	const tracestate = Context.get(entrySpan(span).annotations, TraceState);
	return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
}

/**
 * The external span `carrier` names, to be the parent of what continues its trace. None when the carrier is absent,
 * has no `traceparent`, or its `traceparent` is malformed. A carrier is wire input: it may have been stored by
 * another version or another adapter, so every part is checked here and nothing in it can make this throw.
 */
export function fromCarrier(carrier: TelemetryCarrier | undefined): Option.Option<Tracer.ExternalSpan> {
	const traceparent: unknown = carrier?.traceparent;
	if (typeof traceparent !== "string") return Option.none();
	const parts = traceparent.split("-");
	const [version = "", traceId = "", spanId = "", flags = ""] = parts;
	// Version ff is forbidden; version 00 has exactly four parts, a later version may append more.
	if (!HEX_BYTE.test(version) || version === "ff" || (version === "00" && parts.length !== 4)) return Option.none();
	if (!isId(traceId, 32) || !isId(spanId, 16) || !HEX_BYTE.test(flags)) return Option.none();
	const tracestate: unknown = carrier?.tracestate;
	return Option.some(
		Tracer.externalSpan({
			traceId,
			spanId,
			sampled: (Number.parseInt(flags, 16) & 1) === 1,
			annotations:
				typeof tracestate === "string" && tracestate !== "" ? Context.make(TraceState, tracestate) : undefined,
		}),
	);
}

const HEX_BYTE = /^[0-9a-f]{2}$/;

const HEX = /^[0-9a-f]+$/;

const ZEROS = /^0+$/;

/** Whether `id` is a W3C id of `length` lowercase hex digits; the all-zero id is the invalid one. */
function isId(id: string, length: number): boolean {
	return id.length === length && HEX.test(id) && !ZEROS.test(id);
}

/** The span a trace entered this process with: the topmost ancestor, external when the trace came from a carrier. */
function entrySpan(span: Tracer.AnySpan): Tracer.AnySpan {
	let current = span;
	while (current._tag === "Span" && Option.isSome(current.parent)) current = current.parent.value;
	return current;
}
