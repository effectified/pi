// Decoding tool arguments into a schema's type and encoding results back to JSON, with typed errors.

import { Array as Arr, Effect, Predicate, pipe, Schema, SchemaIssue, String as Str } from "effect";
import { type Issue, SchemaDecodeError } from "./errors.ts";
import type { ToJsonSchemaOptions } from "./json-schema.ts";

/**
 * Decodes JSON (a model's tool call arguments) into `schema`'s type, through the JSON form `toJsonSchema(schema)`
 * describes. Every issue is reported, not only the first.
 */
export function decodeUnknown<S extends Schema.Constraint>(
	schema: S,
	options?: ToJsonSchemaOptions,
): (input: unknown) => Effect.Effect<S["Type"], SchemaDecodeError, S["DecodingServices"]> {
	const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema), {
		errors: "all",
		onExcessProperty: options?.onExcessProperty ?? "error",
	});
	return (input) => Effect.mapError(decode(input), toDecodeError);
}

/** Encodes a value of `schema`'s type to JSON (a tool result), the inverse of `decodeUnknown`. */
export function encode<S extends Schema.Constraint>(
	schema: S,
): (value: S["Type"]) => Effect.Effect<Schema.Json, SchemaDecodeError, S["EncodingServices"]> {
	const encodeJson = Schema.encodeEffect(Schema.toCodecJson(schema), { errors: "all" });
	return (value) => Effect.mapError(encodeJson(value), toDecodeError);
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function toDecodeError(error: Schema.SchemaError): SchemaDecodeError {
	return SchemaDecodeError.make({
		issues: Arr.map(formatIssues(error.issue).issues, (issue): Issue => ({
			path: toJsonPointer(issue.path ?? []),
			message: issue.message,
		})),
	});
}

/** A Standard Schema path as the JSON Pointer pi-schema reports (RFC 6901: `~` is `~0`, `/` is `~1`). */
function toJsonPointer(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
	return Arr.join(
		Arr.map(path, (segment) => {
			const key = Predicate.isObject(segment) ? segment.key : segment;
			return `/${escapeToken(String(key))}`;
		}),
		"",
	);
}

/** RFC 6901: `~` is `~0`, `/` is `~1`. */
function escapeToken(key: string): string {
	return pipe(key, Str.replaceAll("~", "~0"), Str.replaceAll("/", "~1"));
}
