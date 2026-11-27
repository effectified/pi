// Refusals: what a guard publishes for every tool call it kept from running. Never the arguments.

import { Conversation, Task, ToolCallId, ToolName } from "@effectified/pi-durable";
import { Schema } from "effect";

/**
 * Why a call did not run:
 *
 * - `denied`: the tool's name is one the policy says can never be registered.
 * - `allow-list`: the tool is not in the conversation's grant.
 * - `ceiling`: the tool's classification ceiling is below the conversation's classification.
 * - `argument`: an argument rule blocked the call; `name` is the rule's, `reason` what it gave.
 * - `argument-failed`: an argument rule failed; `name` is the rule's.
 * - `unavailable`: Pi itself refused the call, because the tool was not offered or does not resolve.
 * - `guard-not-first`: the conversation does not ask the guard's extension first, so the tool refused to run.
 * - `guard-failed`: the guard could not decide, such as a grant it could not read.
 *
 * Plain literals, not a tagged union: the reason is stored in a tool result's details (`Refused`), which a host
 * reads as JSON without this package.
 */
export const Reason = Schema.Literals([
	"denied",
	"allow-list",
	"ceiling",
	"argument",
	"argument-failed",
	"unavailable",
	"guard-not-first",
	"guard-failed",
]);

/** Why a call did not run. */
export type Reason = typeof Reason.Type;

/** One tool call a guard kept from running: which conversation, which tool, which rule. */
export const Refusal = Schema.Struct({
	conversationId: Conversation.Id,
	/** The call's task. With `callId` it identifies the call: Pi may ask a hook twice across a restart. */
	taskId: Task.Id,
	/** The id the model gave the call; a nested call's is `<caller's id>/<key>`. */
	callId: ToolCallId,
	tool: ToolName,
	rule: Reason,
	/** The name of the argument rule, for `argument` and `argument-failed`. */
	name: Schema.optionalKey(Schema.String),
	/** What the argument rule gave as its reason, for `argument`. */
	reason: Schema.optionalKey(Schema.String),
});

/** One tool call a guard kept from running. */
export type Refusal = typeof Refusal.Type;

/** What the model reads for every refusal, whatever the rule: the words Pi uses for a tool it does not have. */
export function unavailable(tool: ToolName): string {
	return `Tool ${tool} is not available`;
}
