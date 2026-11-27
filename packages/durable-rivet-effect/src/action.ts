// A product action of an actor: an Effect on the harness, with the schemas of what crosses the action boundary.

import { Effect, Schema } from "effect";
import { type Answer, defect } from "./answer.ts";

/** A schema whose value crosses the action boundary as JSON: it needs no service to encode or decode. */
export type Wire = Schema.ConstraintCodec<unknown, unknown, never, never>;

/**
 * How one action crosses the boundary: the schemas of its argument, its value and its failure, and the caller's
 * codecs built from them once. The codecs take `unknown`; `Client.call` types what goes in and what comes out.
 */
export interface Boundary<Input extends Wire, Output extends Wire, Failure extends Wire> {
	readonly input: Input;
	readonly output: Output;
	readonly error: Failure;
	/** The JSON an input crosses as. */
	readonly encodeInput: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
	/** The value of a success answer. */
	readonly decodeOutput: (json: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
	/** The error of a failure answer. */
	readonly decodeError: (json: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}

/**
 * One action of an actor, made by `make`. `run` is the action inside the actor, with the harness and the product's
 * services: it decodes the JSON input, runs the handler, and always succeeds with the answer that crosses back.
 */
export interface Action<Input extends Wire, Output extends Wire, Failure extends Wire, R> extends Boundary<
	Input,
	Output,
	Failure
> {
	readonly run: (encoded: unknown) => Effect.Effect<Answer, never, R>;
}

/** Any action, whatever its schemas and requirements: what a record of actions holds. */
export type Any = Action<Wire, Wire, Wire, unknown>;

/** What an action takes: its decoded input. */
export type Input<A extends Boundary<Wire, Wire, Wire>> = A["input"]["Type"];

/** What an action gives: its decoded output. */
export type Output<A extends Boundary<Wire, Wire, Wire>> = A["output"]["Type"];

/** What an action fails with: its decoded error. */
export type Failure<A extends Boundary<Wire, Wire, Wire>> = A["error"]["Type"];

/**
 * The schemas of an action without a handler: `error` defaults to an action that cannot fail. `NoInfer`: the error
 * schema is read from the argument only, so an action made inside a record of actions does not take the record's.
 */
export function boundary<Input extends Wire, Output extends Wire, Failure extends Wire = typeof Schema.Never>(schemas: {
	readonly input: Input;
	readonly output: Output;
	readonly error?: Failure;
}): Boundary<Input, Output, NoInfer<Failure>> {
	// TypeScript cannot tie an absent option to the default of its type parameter: without `error`, `Failure` is
	// `Schema.Never`.
	const error = schemas.error ?? (Schema.Never as Wire as Failure);
	return {
		input: schemas.input,
		output: schemas.output,
		error,
		encodeInput: Schema.encodeUnknownEffect(Schema.toCodecJson(schemas.input)),
		decodeOutput: Schema.decodeUnknownEffect(Schema.toCodecJson(schemas.output)),
		decodeError: Schema.decodeUnknownEffect(Schema.toCodecJson(error)),
	};
}

/**
 * Defines an action. Without `error` the handler cannot fail: a failure it does not declare would have no way across.
 * A defect of the handler, an input its schema rejects, and a value or an error its schema cannot encode all cross as
 * a defect with its message. Rivet ends an action that runs longer than the actor's `actionTimeout` (60 seconds
 * unless the actor sets it), so a handler that starts long work submits it and returns, and the caller waits with
 * `Client.waitForIdle`.
 */
export function make<
	Input extends Wire,
	Output extends Wire,
	Failure extends Wire = typeof Schema.Never,
	R = never,
>(definition: {
	readonly input: Input;
	readonly output: Output;
	readonly error?: Failure;
	readonly handler: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"], R>;
}): Action<Input, Output, NoInfer<Failure>, R> {
	const schemas = boundary(definition);
	const decodeInput = Schema.decodeUnknownEffect(Schema.toCodecJson(schemas.input));
	const encodeOutput = Schema.encodeUnknownEffect(Schema.toCodecJson(schemas.output));
	const encodeError = Schema.encodeUnknownEffect(Schema.toCodecJson(schemas.error));
	return {
		...schemas,
		run: (encoded) =>
			// The schema failures die before and inside the handlers below, so only the handler's own error is caught.
			Effect.orDie(decodeInput(encoded)).pipe(
				Effect.flatMap(definition.handler),
				Effect.flatMap((value) => Effect.orDie(encodeOutput(value))),
				Effect.map((value): Answer => ({ _tag: "success", value })),
				Effect.catch((failure) =>
					Effect.map(Effect.orDie(encodeError(failure)), (json): Answer => ({ _tag: "failure", error: json })),
				),
				Effect.catchCause((cause) => Effect.succeed(defect(cause))),
			),
	};
}
