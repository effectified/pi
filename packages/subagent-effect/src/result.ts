// Typed results: what a child is told to answer with for a declared result Schema, and its answer decoded against it.

import { SchemaConversionError } from "@gunta/pi-durable-effect";
import { Effect, Predicate, Schema } from "effect";
import { ResultMismatch } from "./errors.ts";
import type { ResultSchema, Subagent } from "./subagent.ts";

/** A declared result schema, made ready once: the contract for the child and the decoder of its answer. */
export interface Typed {
	/** What is added to the task so the child knows the shape of its final answer. */
	readonly contract: string;
	/**
	 * The child's answer as the JSON form of the declared schema: parsed, decoded, and encoded again, so what is kept
	 * is what the schema accepts and nothing else. Fails with what to tell the child.
	 */
	readonly decode: (answer: string) => Effect.Effect<Schema.Json, ResultMismatch>;
}

/**
 * Makes the result schema of `subagent` ready. Fails when it has no JSON Schema, since a child cannot be told what to
 * answer then.
 *
 * How a typed result is produced: the child answers in text with one JSON value. Pi Durable 1.6.0 has no structured
 * output per request, and a `finish` tool would add a tool the declaration did not name. The answer is therefore
 * checked here, and a mismatch is sent back to the child (see `correction`) a bounded number of times.
 */
export function compile(subagent: Subagent, schema: ResultSchema): Effect.Effect<Typed, SchemaConversionError> {
	const mismatch = (issues: string) => new ResultMismatch({ subagent: subagent.name, issues });
	return Effect.try({
		// Effect throws for a schema without a JSON form, from the codec and from the JSON Schema alike.
		try: (): Typed => {
			const codec = Schema.toCodecJson(schema);
			const decodeJson = Schema.decodeUnknownEffect(codec, { errors: "all" });
			const encodeJson = Schema.encodeEffect(codec);
			const document = Schema.toJsonSchemaDocument(schema);
			const jsonSchema =
				Object.keys(document.definitions).length === 0
					? document.schema
					: { ...document.schema, $defs: document.definitions };
			return {
				contract: `Your final answer must be one JSON value that matches this JSON Schema, with no other text:\n${JSON.stringify(jsonSchema)}`,
				decode: (answer) =>
					Effect.try({
						try: (): unknown => JSON.parse(unfenced(answer)),
						catch: () => mismatch("it is not JSON"),
					}).pipe(
						Effect.flatMap((json) => Effect.flatMap(decodeJson(json), encodeJson)),
						Effect.mapError((error) => (error._tag === "ResultMismatch" ? error : mismatch(error.message))),
						// A decode boundary: the JSON codec of a schema encodes to JSON, which its `Encoded` type cannot say.
						Effect.map((encoded) => encoded as Schema.Json),
					),
			};
		},
		catch: (cause) =>
			new SchemaConversionError({
				reason: `Subagent ${subagent.name}: its result has no JSON Schema (${Predicate.isError(cause) ? cause.message : String(cause)})`,
			}),
	});
}

/** What a child whose answer did not match is told. */
export function correction(mismatch: ResultMismatch): string {
	return `Your answer is not the JSON value that was asked for: ${mismatch.issues}\nAnswer again with only the JSON value.`;
}

/** The JSON text of an answer: what its first fenced code block holds, or the answer as it is. */
function unfenced(answer: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
	return (fenced?.[1] ?? answer).trim();
}
