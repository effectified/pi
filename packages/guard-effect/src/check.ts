// The decision about one tool call: the denied names, the conversation's grant, the tool's ceiling, then the rules.

import type { JsonObject } from "@effectified/pi-durable";
import { Array as Arr, Cause, Effect, Match, Option } from "effect";
import * as Classification from "./classification.ts";
import * as Policy from "./policy.ts";
import type { Reason, Refusal } from "./refusal.ts";
import type * as Rule from "./rule.ts";

/**
 * What a guard decides about one call. Interfaces, not a Schema: a pass holds Pi's own mutable JSON object, which Pi's
 * gate takes as it is. Choose with `Match.valueTags`.
 */
export type Verdict = Pass | Refuse;

/** The call runs, with `arguments` when a rule rewrote them. */
export interface Pass {
	readonly _tag: "Pass";
	readonly arguments: Option.Option<JsonObject>;
}

/** The call does not run, and why: the refusal's `rule`, and for an argument rule its `name` and `reason`. */
export interface Refuse extends Pick<Refusal, "rule" | "name" | "reason"> {
	readonly _tag: "Refuse";
}

/** A refusal for `rule`. */
export function refuse(rule: Reason, detail?: Pick<Refuse, "name" | "reason">): Refuse {
	return { _tag: "Refuse", rule, ...detail };
}

/**
 * Decides one call, cheapest check first, and stops at the first refusal: a name the policy denies, a tool outside
 * the grant, a ceiling below the conversation's classification, then the rules of the tool in order, each seeing the
 * arguments the one before left. It never fails: a rule that fails refuses the call.
 */
export const decide: <R, E>(
	policy: Policy.Policy,
	rules: ReadonlyArray<Rule.Rule<R, E>>,
	args: Rule.Arguments,
	call: Rule.Call,
) => Effect.Effect<Verdict, never, R> = Effect.fn("Guard.decide")(function* <R, E>(
	policy: Policy.Policy,
	rules: ReadonlyArray<Rule.Rule<R, E>>,
	args: Rule.Arguments,
	call: Rule.Call,
) {
	if (Option.isSome(Policy.denying(policy, call.name))) return refuse("denied");
	if (!Arr.contains(call.grant.tools, call.name)) return refuse("allow-list");
	if (!Classification.toolCleared(policy, call.name, call.grant.classification)) return refuse("ceiling");
	let rewritten = Option.none<JsonObject>();
	for (const rule of Arr.filter(rules, (each) => each.tool === call.name)) {
		const outcome = yield* asked(
			rule,
			Option.getOrElse(rewritten, () => args),
			call,
		);
		if (outcome._tag === "Refuse") return outcome;
		if (outcome._tag === "Rewrite") rewritten = Option.some(outcome.arguments);
	}
	const pass: Verdict = { _tag: "Pass", arguments: rewritten };
	return pass;
});

/** One rule's answer, with its block and its failure as refusals. An interruption stays one. */
function asked<R, E>(
	rule: Rule.Rule<R, E>,
	args: Rule.Arguments,
	call: Rule.Call,
): Effect.Effect<Rule.Allow | Rule.Rewrite<JsonObject> | Refuse, never, R> {
	return Effect.suspend(() => rule.run(args, call)).pipe(
		Effect.map(
			Match.valueTags({
				Allow: (allow): Rule.Allow | Rule.Rewrite<JsonObject> | Refuse => allow,
				Rewrite: (rewrite) => rewrite,
				Block: ({ reason }) => refuse("argument", { name: rule.name, reason }),
			}),
		),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.succeed(refuse("argument-failed", { name: rule.name })),
		),
	);
}
