// The policy: what no tool may be registered as, the classification labels and ceilings, and the grant of a
// conversation that was given none. Data the product supplies.

import { Agent, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Effect, Option, Record, Schema } from "effect";
import { dual } from "effect/Function";
import { InvalidPolicy } from "./errors.ts";
import { Grant } from "./grant.ts";
import * as Matcher from "./matcher.ts";

/** The highest classification one model may serve; the model as `Agent.ModelRef` names it, its ids branded. */
export const ModelCeiling = Schema.Struct({ ...Agent.ModelRef.fields, ceiling: Schema.String });

/** The highest classification one model may serve. */
export type ModelCeiling = typeof ModelCeiling.Type;

/**
 * The whole policy of a guard:
 *
 * - `denied`: no tool these matchers name is ever registered or run.
 * - `classifications`: the labels, lowest to highest. Empty: the program uses none, and no ceiling is checked.
 * - `toolCeilings`: per tool name, the highest classification of a conversation that may call it. A tool without one
 *   is not limited by classification.
 * - `modelCeilings`: per model, the highest classification it may serve. A model without one may serve none.
 * - `ungranted`: the grant of a conversation that was given none.
 *
 * Its type has the tool names and model ids branded; its encoded form, `Policy.Encoded`, has plain strings and
 * is what a product writes in code or stores. `Guard.fromPolicy` and `Guard.layer` take either.
 */
export const Policy = Schema.Struct({
	denied: Schema.Array(Matcher.Matcher),
	classifications: Schema.Array(Schema.String),
	toolCeilings: Schema.Record(ToolName, Schema.String),
	modelCeilings: Schema.Array(ModelCeiling),
	ungranted: Grant,
});

/** The whole policy of a guard. */
export type Policy = typeof Policy.Type;

/** A policy as a product writes it in code or stores it: tool names and model ids as plain strings. */
export type Encoded = typeof Policy.Encoded;

/** The policy that denies no name, has no classifications, and allows a conversation without a grant nothing. */
export const empty: Policy = Policy.make({
	denied: [],
	classifications: [],
	toolCeilings: {},
	modelCeilings: [],
	ungranted: { tools: [] },
});

/**
 * `input` as a policy, its names branded, when it holds together; fails with `InvalidPolicy` for the first
 * contradiction found, or for input that is not the shape of a policy.
 */
export const decode: (input: Encoded) => Effect.Effect<Policy, InvalidPolicy> = Effect.fn("Policy.decode")(
	function* (input) {
		const policy = yield* Effect.mapError(Schema.decodeEffect(Policy)(input), (error) =>
			InvalidPolicy.make({ reason: error.message }),
		);
		return yield* validate(policy);
	},
);

/** `policy` when it holds together; fails with the first contradiction found. */
export const validate: (policy: Policy) => Effect.Effect<Policy, InvalidPolicy> = Effect.fn("Policy.validate")(
	function* (policy) {
		const reason = contradiction(policy);
		if (Option.isSome(reason)) return yield* InvalidPolicy.make({ reason: reason.value });
		return policy;
	},
);

/** The first matcher of the policy's `denied` list that names the tool `name`, if any. Data-first or data-last. */
export const denying: {
	(name: string): (policy: Policy) => Option.Option<Matcher.Matcher>;
	(policy: Policy, name: string): Option.Option<Matcher.Matcher>;
} = dual(2, (policy: Policy, name: string) => Arr.findFirst(policy.denied, Matcher.matches(name)));

/** The first contradiction of `policy`, in the order its fields are listed. */
function contradiction(policy: Policy): Option.Option<string> {
	const labels = policy.classifications;
	const listed = (label: string) => Arr.contains(labels, label);
	// Lazy, in the order of the fields: the first that finds one is the answer, and no later one runs.
	const checks: ReadonlyArray<() => Option.Option<string>> = [
		() => when(listed(""), "A classification is empty"),
		() => when(Arr.dedupe(labels).length !== labels.length, "A classification is listed twice"),
		() => Arr.findFirst(policy.denied, emptyText),
		() =>
			Arr.findFirst(Record.toEntries(policy.toolCeilings), ([tool, ceiling]) =>
				when(!listed(ceiling), `The ceiling ${ceiling} of tool ${tool} is not a classification`),
			),
		() =>
			Arr.findFirst(policy.modelCeilings, (entry, index) =>
				modelContradiction(entry, Arr.take(policy.modelCeilings, index), listed),
			),
		() =>
			Option.flatMap(Option.fromUndefinedOr(policy.ungranted.classification), (label) =>
				when(
					!listed(label),
					`The classification ${label} of a conversation without a grant is not a classification`,
				),
			),
	];
	return Arr.findFirst(checks, (check) => check());
}

/** A denied matcher whose text is empty, which would name no tool or every tool. */
function emptyText(matcher: Matcher.Matcher): Option.Option<string> {
	return Matcher.Matcher.match(matcher, {
		Exact: ({ name }) => when(name === "", "A denied name is empty"),
		Prefix: (start) => when(start.prefix === "", "A denied prefix is empty"),
		Word: ({ words }) => when(Arr.contains(words, ""), "A denied word is empty"),
	});
}

/** What is wrong with one model ceiling: a ceiling that is no label, or a model one of `earlier` lists already. */
function modelContradiction(
	entry: ModelCeiling,
	earlier: ReadonlyArray<ModelCeiling>,
	listed: (label: string) => boolean,
): Option.Option<string> {
	const { provider, modelId, ceiling } = entry;
	const model = `${provider}/${modelId}`;
	if (!listed(ceiling)) return Option.some(`The ceiling ${ceiling} of model ${model} is not a classification`);
	return when(
		Arr.some(earlier, (other) => other.provider === provider && other.modelId === modelId),
		`Model ${model} has two ceilings`,
	);
}

/** `reason` when `holds`. */
function when(holds: boolean, reason: string): Option.Option<string> {
	return holds ? Option.some(reason) : Option.none();
}
