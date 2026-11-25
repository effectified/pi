// The policy a product supplies: which tool calls need a person's approval, and how long a request stays open.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Cause, type Duration, Effect, type Schema } from "effect";

/** The tool call a rule judges. */
export interface Call {
	readonly tool: string;
	/** The arguments as the gate got them: after the hooks installed before it. */
	readonly arguments: Schema.JsonObject;
	readonly conversation: ConversationId;
	/** The id the model gave the call. */
	readonly callId: string;
}

/** Which calls need approval. `R` is what `rule` needs: the registry Layer requires it. */
export interface Policy<R = never> {
	/** Tools whose every call needs approval, by name. */
	readonly tools?: ReadonlyArray<string>;
	/**
	 * Asked about a call of any other tool: true when it needs approval. A rule that fails, with a failure or a defect,
	 * means it does. Asked only until a call first needs approval: from then on the call asks for every change of
	 * its arguments, whatever the rule would say.
	 */
	readonly rule?: (call: Call) => Effect.Effect<boolean, unknown, R>;
	/** How long a request stays open, from when it is first made; finite. */
	readonly expiresAfter: Duration.Input;
}

/** Whether `policy` asks a person about `call`. Never fails: a failing rule answers true. */
export function needsApproval<R>(policy: Policy<R>, call: Call): Effect.Effect<boolean, never, R> {
	if (policy.tools?.includes(call.tool) === true) return Effect.succeed(true);
	if (policy.rule === undefined) return Effect.succeed(false);
	const rule = policy.rule;
	return Effect.catchCause(
		Effect.suspend(() => rule(call)),
		// An interruption is Pi aborting the hook, not an answer of the rule.
		(cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(true)),
	);
}
