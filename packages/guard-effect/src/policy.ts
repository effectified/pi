// The policy: what no tool may be registered as, the classification labels and ceilings, and the grant of a
// conversation that was given none. Data the product supplies.

import { Effect, Option, Schema } from "effect";
import { InvalidPolicy } from "./errors.ts";
import { Grant } from "./grant.ts";
import * as Matcher from "./matcher.ts";

/** The highest classification one model may serve. */
export const ModelCeiling = Schema.Struct({
	provider: Schema.String,
	modelId: Schema.String,
	ceiling: Schema.String,
});

/**
 * The whole policy of a guard:
 *
 * - `denied`: no tool these matchers name is ever registered or run.
 * - `classifications`: the labels, lowest to highest. Empty: the program uses none, and no ceiling is checked.
 * - `toolCeilings`: per tool name, the highest classification of a conversation that may call it. A tool without one
 *   is not limited by classification.
 * - `modelCeilings`: per model, the highest classification it may serve. A model without one may serve none.
 * - `ungranted`: the grant of a conversation that was given none.
 */
export const Policy = Schema.Struct({
	denied: Schema.Array(Matcher.Matcher),
	classifications: Schema.Array(Schema.String),
	toolCeilings: Schema.Record(Schema.String, Schema.String),
	modelCeilings: Schema.Array(ModelCeiling),
	ungranted: Grant,
});

/** The whole policy of a guard. */
export type Policy = typeof Policy.Type;

/** The policy that denies no name, has no classifications, and allows a conversation without a grant nothing. */
export const empty: Policy = {
	denied: [],
	classifications: [],
	toolCeilings: {},
	modelCeilings: [],
	ungranted: { tools: [] },
};

/** `policy` when it holds together; fails with the first contradiction found. */
export function validate(policy: Policy): Effect.Effect<Policy, InvalidPolicy> {
	const reason = contradiction(policy);
	return reason === undefined ? Effect.succeed(policy) : Effect.fail(new InvalidPolicy({ reason }));
}

/** The first matcher of the policy's `denied` list that names the tool `name`, if any. */
export function denying(policy: Policy, name: string): Option.Option<Matcher.Matcher> {
	return Option.fromUndefinedOr(policy.denied.find((matcher) => Matcher.matches(matcher, name)));
}

function contradiction(policy: Policy): string | undefined {
	const labels = policy.classifications;
	if (labels.includes("")) return "A classification is empty";
	if (new Set(labels).size !== labels.length) return "A classification is listed twice";
	for (const matcher of policy.denied) {
		const text = matcher._tag === "Exact" ? matcher.name : matcher._tag === "Prefix" ? matcher.prefix : undefined;
		if (text === "") return `A denied ${matcher._tag === "Exact" ? "name" : "prefix"} is empty`;
		if (matcher._tag === "Word" && matcher.words.includes("")) return "A denied word is empty";
	}
	for (const [tool, ceiling] of Object.entries(policy.toolCeilings)) {
		if (!labels.includes(ceiling)) return `The ceiling ${ceiling} of tool ${tool} is not a classification`;
	}
	const models = new Set<string>();
	for (const { provider, modelId, ceiling } of policy.modelCeilings) {
		const model = `${provider}/${modelId}`;
		if (!labels.includes(ceiling)) return `The ceiling ${ceiling} of model ${model} is not a classification`;
		if (models.has(model)) return `Model ${model} has two ceilings`;
		models.add(model);
	}
	const unlabelled = policy.ungranted.classification;
	if (unlabelled !== undefined && !labels.includes(unlabelled)) {
		return `The classification ${unlabelled} of a conversation without a grant is not a classification`;
	}
	return undefined;
}
