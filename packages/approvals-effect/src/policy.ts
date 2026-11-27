// The policy a product supplies: which tool calls need a person's approval, and how long a request stays open.

import type { ToolName } from "@effectified/pi-durable";
import { Array as Arr, Cause, type Duration, Effect, Schema, Struct } from "effect";
import { Request } from "./request.ts";

/**
 * The tool call a rule judges: its tool, its arguments as the gate got them (after the hooks installed before it), its
 * conversation and the id the model gave it. The fields of a `Request` of the same name.
 */
export const Call = Schema.Struct(Struct.pick(Request.fields, ["tool", "arguments", "conversation", "callId"]));

/** The tool call a rule judges. */
export type Call = typeof Call.Type;

/**
 * Which calls need approval. `R` is what `rule` needs, which the registry Layer then requires; `E` is what it may fail
 * with, which the gate reads as a yes. An interface, not a Schema: it holds a function.
 */
export interface Policy<R = never, E = never> {
	/** Tools whose every call needs approval, by name: a `Tool`'s own `name`, or `ToolName.make("...")`. */
	readonly tools?: ReadonlyArray<ToolName>;
	/**
	 * Asked about a call of any other tool: true when it needs approval. A rule that fails, with a failure or a defect,
	 * means it does. Asked only until a call first needs approval: from then on the call asks for every change of
	 * its arguments, whatever the rule would say.
	 */
	readonly rule?: (call: Call) => Effect.Effect<boolean, E, R>;
	/** How long a request stays open, from when it is first made; finite. */
	readonly expiresAfter: Duration.Input;
}

/** Whether `policy` asks a person about `call`. Never fails: a failing rule answers true. */
export const needsApproval: <R, E>(policy: Policy<R, E>, call: Call) => Effect.Effect<boolean, never, R> = Effect.fn(
	"Approvals.needsApproval",
)(function* <R, E>(policy: Policy<R, E>, call: Call) {
	if (Arr.contains(policy.tools ?? [], call.tool)) return true;
	const rule = policy.rule;
	if (rule === undefined) return false;
	return yield* Effect.catchCause(
		Effect.suspend(() => rule(call)),
		// An interruption is Pi aborting the hook, not an answer of the rule.
		(cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(true)),
	);
});
