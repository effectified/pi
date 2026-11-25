// Decoding tool arguments into a schema's type and encoding results back to JSON, with typed errors.

import { Effect, Schema, SchemaIssue } from "effect";
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
	return new SchemaDecodeError({
		issues: formatIssues(error.issue).issues.map(
			(issue): Issue => ({ path: toJsonPointer(issue.path ?? []), message: issue.message }),
		),
	});
}

/** A Standard Schema path as the JSON Pointer pi-schema reports (RFC 6901: `~` is `~0`, `/` is `~1`). */
function toJsonPointer(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
	return path
		.map((segment) => {
			const key = typeof segment === "object" ? segment.key : segment;
			return `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
		})
		.join("");
}
