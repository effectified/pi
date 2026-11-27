// The typed failures of this package: the rejections of pi-agent-core's agent and loop, as a closed union of tags, and
// the failure a tool gives Pi for a call it could not answer.

import { Schema } from "effect";
import { ToolName } from "./ids.ts";

/**
 * The agent was already running a prompt or a continuation, so it refused another run (or a reset). Queue a message
 * with `steer` or `followUp` instead, or wait with `waitForIdle`.
 */
export class AgentBusy extends Schema.TaggedError<AgentBusy, { readonly brand: unique symbol }>()("AgentBusy", {
	message: Schema.String,
}) {}

/**
 * There was nothing to continue from: the transcript is empty or holds only system messages, or it ends in an
 * assistant message and no steering or follow-up message is queued.
 */
export class CannotContinue extends Schema.TaggedError<CannotContinue, { readonly brand: unique symbol }>()(
	"CannotContinue",
	{
		message: Schema.String,
	},
) {}

/**
 * Every failure of a call into pi-agent-core. Pi rejects with plain `Error`s, not classes of its own; each rejection
 * it documents has a tag here, and anything else it rejects with is a defect.
 */
export type AgentError = AgentBusy | CannotContinue;

/**
 * A tool of `Tool.make` could not answer a call: the arguments did not decode after Pi validated them, the handler
 * failed, or the success value did not encode. It is what the tool rejects Pi's call with, and Pi turns it into an
 * error result whose text is `message`; `cause` is the failure itself. Never a failure of an Effect of this package.
 */
export class ToolFailed extends Schema.TaggedError<ToolFailed, { readonly brand: unique symbol }>()("ToolFailed", {
	tool: ToolName,
	message: Schema.String,
	cause: Schema.Defect(),
}) {}
