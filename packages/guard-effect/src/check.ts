// The decision about one tool call: the denied names, the conversation's grant, the tool's ceiling, then the rules.

import type { JsonObject } from "@effectified/pi-durable";
import { Cause, Effect, Option } from "effect";
import * as Classification from "./classification.ts";
import * as Policy from "./policy.ts";
import type { Reason } from "./refusal.ts";
import type * as Rule from "./rule.ts";

/** What a guard decides about one call. */
export type Verdict = Pass | Refuse;

/** The call runs, with `arguments` when a rule rewrote them. */
export interface Pass {
	readonly _tag: "Pass";
	readonly arguments: Option.Option<JsonObject>;
}

/** The call does not run, and why. */
export interface Refuse {
	readonly _tag: "Refuse";
	readonly rule: Reason;
	readonly name?: string;
	readonly reason?: string;
}

/** A refusal for `rule`. */
export function refuse(rule: Reason, detail?: { readonly name?: string; readonly reason?: string }): Verdict {
	return { _tag: "Refuse", rule, ...detail };
}

/**
 * Decides one call, cheapest check first, and stops at the first refusal: a name the policy denies, a tool outside
 * the grant, a ceiling below the conversation's classification, then the rules of the tool in order, each seeing the
 * arguments the one before left. It never fails: a rule that fails refuses the call.
 */
export function decide<R>(
	policy: Policy.Policy,
	rules: ReadonlyArray<Rule.Rule<R>>,
	args: Rule.Arguments,
	call: Rule.Call,
): Effect.Effect<Verdict, never, R> {
	if (Option.isSome(Policy.denying(policy, call.name))) return Effect.succeed(refuse("denied"));
	if (!call.grant.tools.includes(call.name)) return Effect.succeed(refuse("allow-list"));
	if (!Classification.toolCleared(policy, call.name, call.grant.classification)) {
		return Effect.succeed(refuse("ceiling"));
	}
	return asking(
		rules.filter((rule) => rule.tool === call.name),
		args,
		call,
		Option.none(),
	);
}

/** Asks `rules` in order with `args`; `rewritten` holds the arguments once a rule replaced them. */
function asking<R>(
	rules: ReadonlyArray<Rule.Rule<R>>,
	args: Rule.Arguments,
	call: Rule.Call,
	rewritten: Option.Option<JsonObject>,
): Effect.Effect<Verdict, never, R> {
	const [rule, ...rest] = rules;
	if (rule === undefined) return Effect.succeed({ _tag: "Pass", arguments: rewritten });
	return Effect.flatMap(asked(rule, args, call), (outcome) => {
		switch (outcome._tag) {
			case "Allow":
				return asking(rest, args, call, rewritten);
			case "Rewrite":
				return asking(rest, outcome.arguments, call, Option.some(outcome.arguments));
			case "Refuse":
				return Effect.succeed(outcome);
		}
	});
}

/** One rule's answer, with its block and its failure as refusals. An interruption stays one. */
function asked<R>(
	rule: Rule.Rule<R>,
	args: Rule.Arguments,
	call: Rule.Call,
): Effect.Effect<Rule.Allow | Rule.Rewrite<JsonObject> | Refuse, never, R> {
	return Effect.suspend(() => rule.run(args, call)).pipe(
		Effect.map((outcome) =>
			outcome._tag === "Block"
				? ({ _tag: "Refuse", rule: "argument", name: rule.name, reason: outcome.reason } as const)
				: outcome,
		),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.succeed({ _tag: "Refuse", rule: "argument-failed", name: rule.name } as const),
		),
	);
}
