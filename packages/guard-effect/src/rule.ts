// Argument rules: what the product decides about one call of one tool, from its decoded arguments, as an Effect.

import { Conversation, type JsonObject, ToolCallId, ToolName } from "@effectified/pi-durable";
import { type Cause, Effect, Predicate, Schema } from "effect";
import { Grant } from "./grant.ts";

/**
 * What a rule answers: the call goes on, does not run, or goes on with other arguments. Interfaces, not a Schema: a
 * rewrite holds the tool's own parameters, whose type a Schema here cannot name. Choose with `Match.valueTags`.
 */
export type Outcome<A> = Allow | Block | Rewrite<A>;

/** The call goes on to the next rule, and runs when none stops it. */
export interface Allow {
	readonly _tag: "Allow";
}

/** The call does not run. `reason` is published with the refusal; the model is told only that the tool is not available. */
export interface Block {
	readonly _tag: "Block";
	readonly reason: string;
}

/** The call goes on with `arguments`, which the next rule sees and Pi validates again. */
export interface Rewrite<A> {
	readonly _tag: "Rewrite";
	readonly arguments: A;
}

/** Lets the call go on. */
export const allow: Outcome<never> = { _tag: "Allow" };

/** Stops the call. Keep the arguments' content out of `reason`: it is published. */
export function block(reason: string): Outcome<never> {
	return { _tag: "Block", reason };
}

/** Replaces the call's arguments. */
export function rewrite<A>(args: A): Outcome<A> {
	return { _tag: "Rewrite", arguments: args };
}

/** A call's arguments as Pi holds them: a JSON object, read only. */
export type Arguments = { readonly [key: string]: unknown };

/** The call a rule decides about, besides its arguments. */
export const Call = Schema.Struct({
	/** The tool's name. */
	name: ToolName,
	conversationId: Conversation.Id,
	/** The id the model gave the call; a nested call's is `<caller's id>/<key>`. */
	callId: ToolCallId,
	/** Whether another tool made the call (`executeTool`), not the model. */
	nested: Schema.Boolean,
	/** The grant that holds for the conversation. */
	grant: Grant,
});

/** The call a rule decides about, besides its arguments. */
export type Call = typeof Call.Type;

/** A rule made by `make`: what a guard runs before a call of `tool`. Its failure `E` blocks the call. */
export interface Rule<R, E = unknown> {
	/** Published with a refusal of this rule. */
	readonly name: string;
	/** The name of the tool whose calls it decides about. */
	readonly tool: ToolName;
	/** The rule over the arguments as Pi holds them, JSON. */
	readonly run: (args: Arguments, call: Call) => Effect.Effect<Outcome<JsonObject>, E, R>;
}

/** Any rule, whatever it needs and fails with. */
export interface Any {
	readonly name: string;
	readonly tool: ToolName;
	readonly run: (args: Arguments, call: Call) => Effect.Effect<Outcome<JsonObject>, unknown, unknown>;
}

/** The services a rule, or each rule of a union, needs to run. */
export type Services<T> = T extends {
	readonly run: (...args: never) => Effect.Effect<infer _A, infer _E, infer R>;
}
	? R
	: never;

/**
 * Defines a rule for the calls of `tool`, a `Tool` or anything with its `name` and `parameters`. `check` gets the
 * arguments decoded by the tool's `parameters`, as its handler would, and answers `allow`, `block(reason)` or
 * `rewrite(arguments)`. A guard fails closed: when `check` fails, with a failure or a defect, or the arguments do not
 * decode, the call is blocked. Rules of one tool run in the order they were given to the guard. Pi asks again on every
 * wake of a parked call, so keep what `check` does outside idempotent. Each run is a span `Rule.run` that names the
 * rule and the tool.
 */
export function make<P extends Schema.Constraint, E, R>(
	name: string,
	tool: { readonly name: ToolName; readonly parameters: P },
	check: (params: P["Type"], call: Call) => Effect.Effect<Outcome<P["Type"]>, E, R>,
): Rule<R | P["DecodingServices"] | P["EncodingServices"], E | Schema.SchemaError | Cause.NoSuchElementError> {
	const codec = Schema.toCodecJson(tool.parameters);
	// As the tool's handler reads them: every issue, and no property the schema does not know.
	const decode = Schema.decodeUnknownEffect(codec, { errors: "all", onExcessProperty: "error" });
	const encode = Schema.encodeEffect(codec, { errors: "all" });
	const run = Effect.fn("Rule.run")(function* (args: Arguments, call: Call) {
		yield* Effect.annotateCurrentSpan({ rule: name, tool: tool.name });
		const params = yield* decode(args);
		const outcome = yield* check(params, call);
		if (outcome._tag !== "Rewrite") return outcome;
		const encoded = yield* Effect.filterOrFail(encode(outcome.arguments), isJsonObject);
		return rewrite(encoded);
	});
	return { name, tool: tool.name, run };
}

/** Whether encoded arguments are what Pi takes: a JSON object. A decode boundary: Effect types the JSON as `Json`. */
function isJsonObject(encoded: Schema.Json): encoded is JsonObject {
	return Predicate.isObject(encoded);
}
