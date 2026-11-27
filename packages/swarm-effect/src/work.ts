// The work of a swarm: what a product declares for its jobs (input, result, prompt), and what a coordinator runs.

import type { Task } from "@effectified/pi-durable";
import { Effect, Formatter, Option, Record, Schema } from "effect";
import { correction, instruction, jsonOf } from "./answer.ts";
import { InvalidValue } from "./errors.ts";
import { JobKey, SwarmId } from "./ids.ts";

/** The job a prompt is built for. */
export const JobRef = Schema.Struct({ swarmId: SwarmId, key: JobKey });

/** The job a prompt is built for. */
export type JobRef = typeof JobRef.Type;

/**
 * What a product declares for the jobs of its swarms. It is code, so it is installed in the registry and found by
 * `name` again after a restart, as a task's phases are; everything else about one swarm is data (`Plan`).
 */
export interface Definition<I extends Task.ValueSchema, A extends Task.ValueSchema> {
	/** Stored with every swarm of this definition and never renamed: the coordinator's task is `swarm.coordinator.<name>`. */
	readonly name: string;
	/** A job's input: encoded to JSON when the swarm starts, decoded for the prompt builder. */
	readonly input: I;
	/** A job's result: the fork's final answer is JSON decoded against it, through the schema's JSON form. */
	readonly result: A;
	/**
	 * The job prompt builder: what one fork is asked. A pure function, since the coordinator runs it again after a
	 * restart. How to answer (one JSON value of the result's JSON Schema) is added after it.
	 */
	readonly prompt: (input: I["Type"], job: JobRef) => string;
	/**
	 * How often a fork whose answer does not decode is told what was wrong and asked again, at most. Default 2; with
	 * 0 the first answer decides.
	 */
	readonly corrections?: number;
}

/** A definition as a coordinator runs it: on the JSON it stores, with every schema failure as `InvalidValue`. */
export interface Work<I, A> {
	readonly name: string;
	readonly corrections: number;
	/** A job input as the JSON the coordinator stores. */
	readonly encodeInput: (input: I) => Effect.Effect<Schema.Json, InvalidValue>;
	/** The whole prompt of the job with this stored input: the product's, then how to answer. */
	readonly promptOf: (input: Schema.Json, job: JobRef) => Effect.Effect<string, InvalidValue>;
	/** A fork's answer as the stored JSON of a result; fails with what was wrong when it is not one. */
	readonly read: (answer: string) => Effect.Effect<Schema.Json, InvalidValue>;
	/** What the fork is told about an answer `read` refused. */
	readonly correctionOf: (refused: InvalidValue) => string;
	/** A stored result as the typed value. */
	readonly decodeResult: (stored: Schema.Json) => Effect.Effect<A, InvalidValue>;
}

const DEFAULT_CORRECTIONS = 2;

/** Compiles a definition's schemas once: the cost of a definition, paid when it is made. */
export function compile<I extends Task.ValueSchema, A extends Task.ValueSchema>(
	definition: Definition<I, A>,
): Work<I["Type"], A["Type"]> {
	const input = Schema.toCodecJson(definition.input);
	const result = Schema.toCodecJson(definition.result);
	const encodeInput = Schema.encodeEffect(input, ALL_ISSUES);
	const decodeInput = Schema.decodeUnknownEffect(input, ALL_ISSUES);
	const encodeResult = Schema.encodeEffect(result, ALL_ISSUES);
	const decodeResult = Schema.decodeUnknownEffect(result, ALL_ISSUES);
	const invalid = (what: "input" | "result") => (error: Schema.SchemaError) =>
		InvalidValue.make({ what, issues: error.message });
	const decoded = (json: unknown) => Effect.mapError(decodeResult(json), invalid("result"));
	const answer = instruction(jsonSchemaOf(definition.result));
	return {
		name: definition.name,
		corrections: definition.corrections ?? DEFAULT_CORRECTIONS,
		encodeInput: (value) => Effect.mapBoth(encodeInput(value), { onFailure: invalid("input"), onSuccess: json }),
		promptOf: (stored, job) =>
			Effect.mapBoth(decodeInput(stored), {
				onFailure: invalid("input"),
				onSuccess: (value) => `${definition.prompt(value, job)}\n\n${answer}`,
			}),
		read: (text) =>
			Option.match(jsonOf(text), {
				onNone: () => Effect.fail(InvalidValue.make({ what: "result", issues: "The answer holds no JSON value" })),
				// Stored as the schema encodes it, so what `decodeResult` reads later is what was checked here.
				onSome: (found) =>
					Effect.flatMap(decoded(found), (value) =>
						Effect.mapBoth(encodeResult(value), { onFailure: invalid("result"), onSuccess: json }),
					),
			}),
		correctionOf: (refused) => correction(refused.issues),
		decodeResult: decoded,
	};
}

// A model that gets every issue at once needs fewer corrections.
const ALL_ISSUES = { errors: "all" } as const;

/** A decode boundary: the encoded side of a schema's JSON form is JSON, which its type does not say. */
function json(encoded: unknown): Schema.Json {
	return encoded as Schema.Json;
}

/** The JSON Schema of a result, as text for a prompt; none for a schema Effect cannot describe. */
function jsonSchemaOf(schema: Schema.Constraint): Option.Option<string> {
	return Option.map(describe(schema), ({ schema: root, definitions }) =>
		Formatter.formatJson(Record.isEmptyRecord(definitions) ? root : { ...root, $defs: definitions }),
	);
}

const describe = Option.liftThrowable(Schema.toJsonSchemaDocument);
