// Pi attribute bags in the two forms Effect takes them: span attributes and metric attributes.

import type { AttributeValue, SpanAttributes } from "@earendil-works/pi-telemetry";
import { Record, Result, Schema, type Tracer } from "effect";

/**
 * `attributes` as the attributes of an Effect span, event, link or log line: `undefined` values are left out and
 * arrays are copied, because pi-telemetry's contract lets the caller change its bag after the call.
 */
export function toSpanAttributes(attributes: SpanAttributes | undefined): Record<string, AttributeValue> {
	return Record.filterMap(attributes ?? {}, (value) =>
		value === undefined ? Result.failVoid : Result.succeed(typeof value === "object" ? value.slice() : value),
	);
}

/** Sets the defined values of `attributes` on `span`; a value replaces an earlier one of the same name. */
export function setSpanAttributes(span: Tracer.Span, attributes: SpanAttributes | undefined): void {
	for (const [name, value] of Record.toEntries(toSpanAttributes(attributes))) span.attribute(name, value);
}

/**
 * `attributes` as Effect metric attributes, which are strings: a scalar is written with `String`, an array as JSON.
 * `undefined` values are left out.
 */
export function toMetricAttributes(attributes: SpanAttributes | undefined): Record<string, string> {
	return Record.filterMap(attributes ?? {}, (value) =>
		value === undefined
			? Result.failVoid
			: Result.succeed(typeof value === "object" ? encodeJson(value) : String(value)),
	);
}

/**
 * An array attribute as JSON text. Its elements are strings, numbers and booleans, which JSON always encodes (a
 * non-finite number as `null`), so the encoding cannot fail.
 */
// @effect-diagnostics-next-line schemaSync:off Pi's metric instruments are synchronous, and this encoding cannot fail.
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
