// The digest of a tool call's arguments: SHA-256 over their canonical JSON, so equal arguments have one digest.

import { Array as Arr, Effect, Formatter, Order, pipe, Record, Schema } from "effect";
import { Hex } from "effect/encoding";

/**
 * A SHA-256 digest as 64 lower-case hexadecimal digits, branded: what a request and a decision name, so a request's
 * id or a principal is never taken for one. `of` and `sha256` make one; decoding a stored request or decision checks
 * the digits.
 */
export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
	Schema.brand("@effectified/pi-approvals/Digest"),
);

/** A SHA-256 digest as 64 lower-case hexadecimal digits. */
export type Digest = typeof Digest.Type;

/**
 * The canonical JSON of `value`, as RFC 8785 writes it: object keys sorted by UTF-16 code unit, no whitespace,
 * strings and numbers as `JSON.stringify` writes them. The key order of the input never matters.
 */
export function canonical(value: Schema.Json): string {
	if (typeof value !== "object" || value === null) return Formatter.formatJson(value);
	if (isArray(value)) return `[${Arr.join(Arr.map(value, canonical), ",")}]`;
	const members = pipe(
		Record.keys<string, Schema.Json>(value),
		// `Order.String` compares with `<`: by UTF-16 code unit, as RFC 8785 sorts.
		Arr.sort(Order.String),
		// Pi hands a hook the arguments before its strict JSON copy: a repaired optional property may hold `undefined`,
		// which JSON has no word for and the tool never gets.
		Arr.filter((key) => value[key] !== undefined),
		Arr.map((key) => `${Formatter.formatJson(key)}:${canonical(value[key])}`),
	);
	return `{${Arr.join(members, ",")}}`;
}

/**
 * The SHA-256 of `text` in UTF-8. From Web Crypto (`crypto.subtle`), which Bun, Node 22 and Workers have as a global:
 * Effect's `Digest` service would ask every product to provide a Layer for a function that needs no choice.
 */
export const sha256: (text: string) => Effect.Effect<Digest> = Effect.fn("Digest.sha256")(function* (text) {
	const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Digest.make(Hex.encode(new Uint8Array(hash)));
});

/** The digest of a JSON value: `sha256` of its `canonical` form. */
export const of: (value: Schema.Json) => Effect.Effect<Digest> = Effect.fn("Digest.of")(function* (value) {
	return yield* sha256(canonical(value));
});

// `Arr.isArray` narrows to a mutable `Array<unknown>`, which would lose the element type.
const isArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray => Arr.isArray(value);
