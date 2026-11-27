// Effect Schema to and from the JSON Schema that Pi tool parameters are written in.

import type { JsonSchema as PiJsonSchema } from "@earendil-works/pi-schema";
import { Effect, JsonSchema, Predicate, Record, Schema, SchemaRepresentation } from "effect";
import { SchemaConversionError } from "./errors.ts";

/** How `toJsonSchema` writes a schema. */
export interface ToJsonSchemaOptions {
	/**
	 * `"error"` (default) closes objects (`additionalProperties: false`), as pi-schema's `obj()` does and as strict tool
	 * calling requires; `"ignore"` leaves them open. `decodeUnknown` takes the same option and the same default.
	 */
	readonly onExcessProperty?: "ignore" | "error";
}

/**
 * The draft 2020-12 JSON Schema of `schema`'s JSON form, self-contained: shared definitions are under `$defs`.
 * It describes what `decodeUnknown(schema)` accepts, so a date is a string and an optional field may be `null`.
 */
export function toJsonSchema(schema: Schema.Constraint, options?: ToJsonSchemaOptions): PiJsonSchema {
	const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: options?.onExcessProperty ?? "error" });
	return Record.isEmptyRecord(document.definitions)
		? document.schema
		: { ...document.schema, $defs: document.definitions };
}

/** How `fromJsonSchema` reads a schema. */
export interface FromJsonSchemaOptions {
	/** The draft `jsonSchema` is written in: `"2020-12"` (default) or `"7"`, the two pi-schema validates. */
	readonly draft?: "2020-12" | "7";
	/**
	 * What a `pattern` does: `"error"` (default) fails the conversion, because a pattern from an untrusted schema can
	 * block the thread; `"apply"` checks it (trusted schemas only); `"ignore"` drops it.
	 */
	readonly patterns?: "error" | "apply" | "ignore";
}

/**
 * An Effect schema that accepts what `jsonSchema` accepts, for tool parameters that arrive as JSON Schema (MCP
 * servers, tools defined with pi-schema's builders). Best effort, as Effect's importer is: keywords it cannot express
 * (`if`, `contains`, `$dynamicRef`, ...) fail with `SchemaConversionError`. A closed object strips unknown properties
 * unless the decoder runs with `onExcessProperty: "error"`. Use `validator()` to check values with pi-schema's exact
 * semantics instead.
 */
export function fromJsonSchema(
	jsonSchema: PiJsonSchema,
	options?: FromJsonSchemaOptions,
): Effect.Effect<Schema.Decoder<unknown>, SchemaConversionError> {
	return Effect.try({
		try: () => {
			// A decode boundary: pi-schema types a schema as `boolean | object`, Effect as its own JSON Schema record.
			const source = jsonSchema as JsonSchema.JsonSchema;
			const document =
				options?.draft === "7" ? JsonSchema.fromSchemaDraft07(source) : JsonSchema.fromSchemaDraft2020_12(source);
			// The importer builds from Effect's built-in schemas and checks only, so decoding needs no service; its
			// return type, `Schema.Top`, cannot say so.
			return SchemaRepresentation.fromJsonSchemaDocument(document, {
				patterns: options?.patterns ?? "error",
			}) as Schema.Decoder<unknown>;
		},
		catch: (cause) =>
			SchemaConversionError.make({ reason: Predicate.isError(cause) ? cause.message : String(cause) }),
	});
}
