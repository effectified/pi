// Pi attribute bags in the two forms Effect takes them: span attributes and metric attributes.

import type { AttributeValue, SpanAttributes } from "@earendil-works/pi-telemetry";

/**
 * `attributes` as the attributes of an Effect span, event, link or log line: `undefined` values are left out and
 * arrays are copied, because pi-telemetry's contract lets the caller change its bag after the call.
 */
export function toSpanAttributes(attributes: SpanAttributes | undefined): Record<string, AttributeValue> {
	const copy: Record<string, AttributeValue> = {};
	for (const name in attributes) {
		const value = attributes[name];
		if (value !== undefined) copy[name] = typeof value === "object" ? value.slice() : value;
	}
	return copy;
}

/**
 * `attributes` as Effect metric attributes, which are strings: a scalar is written with `String`, an array as JSON.
 * `undefined` values are left out.
 */
export function toMetricAttributes(attributes: SpanAttributes | undefined): Record<string, string> {
	const tags: Record<string, string> = {};
	for (const name in attributes) {
		const value = attributes[name];
		if (value !== undefined) tags[name] = typeof value === "object" ? JSON.stringify(value) : String(value);
	}
	return tags;
}
