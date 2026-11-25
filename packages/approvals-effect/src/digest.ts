// The digest of a tool call's arguments: SHA-256 over their canonical JSON, so equal arguments have one digest.

import { Effect, type Schema } from "effect";

/**
 * The canonical JSON of `value`, as RFC 8785 writes it: object keys sorted by UTF-16 code unit, no whitespace,
 * strings and numbers as `JSON.stringify` writes them. The key order of the input never matters.
 */
export function canonical(value: Schema.Json): string {
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	if (isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const members = Object.keys(value)
		.sort()
		// Pi hands a hook the arguments before its strict JSON copy: a repaired optional property may hold `undefined`,
		// which JSON has no word for and the tool never gets.
		.filter((key) => value[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
	return `{${members.join(",")}}`;
}

/**
 * The SHA-256 of `text` in UTF-8, as 64 lower-case hexadecimal digits. From Web Crypto (`crypto.subtle`), which Bun,
 * Node 22 and Workers have as a global.
 */
export function sha256(text: string): Effect.Effect<string> {
	return Effect.map(
		Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
		(hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
}

/** The digest of a JSON value: `sha256` of its `canonical` form. */
export function of(value: Schema.Json): Effect.Effect<string> {
	return sha256(canonical(value));
}

// `Array.isArray` narrows to `any[]`, which would lose the element type.
const isArray: (value: Schema.JsonArray | Schema.JsonObject) => value is Schema.JsonArray = Array.isArray;
