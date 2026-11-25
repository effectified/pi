// pi-schema's compiled validator in Effect terms: compiling can fail, and a rejected value is a typed error.

import {
	type CompileOptions,
	compile,
	type JsonSchema,
	type ParseResult,
	type Static,
} from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { SchemaConversionError, SchemaDecodeError } from "./errors.ts";

/** A compiled JSON Schema whose valid values have type `T`. */
export interface Validator<T> {
	/** Whether `value` is valid: pi-schema's allocation-free check. */
	readonly check: (value: unknown) => value is T;
	/** `value` itself when it is valid, else its issues. Nothing is coerced. */
	readonly validate: (value: unknown) => Effect.Effect<T, SchemaDecodeError>;
	/** `value` coerced towards the schema as pi-schema coerces tool call arguments, then validated. */
	readonly parse: (value: unknown) => Effect.Effect<T, SchemaDecodeError>;
}

/**
 * Compiles `jsonSchema` with pi-schema, so values are checked exactly as Pi checks tool arguments. Fails with
 * `SchemaConversionError` when the schema is malformed or a `$ref` names nothing.
 */
export function validator<S extends JsonSchema>(
	jsonSchema: S,
	options?: Omit<CompileOptions, "coerce">,
): Effect.Effect<Validator<Static<S>>, SchemaConversionError> {
	return Effect.try({
		try: (): Validator<Static<S>> => {
			const compiled = compile(jsonSchema, { ...options, coerce: true });
			return {
				check: compiled.check,
				validate: (value) => fromParseResult(compiled.validate(value)),
				parse: (value) => fromParseResult(compiled.parse(value)),
			};
		},
		catch: (cause) => new SchemaConversionError({ reason: cause instanceof Error ? cause.message : String(cause) }),
	});
}

function fromParseResult<T>(result: ParseResult<T>): Effect.Effect<T, SchemaDecodeError> {
	return result.ok ? Effect.succeed(result.value) : Effect.fail(new SchemaDecodeError({ issues: result.errors }));
}
