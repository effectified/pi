// The typed failures of this package: the rejections of pi-agent-core's agent and loop, as a closed union of tags.

import { Schema } from "effect";

/**
 * The agent was already running a prompt or a continuation, so it refused another run (or a reset). Queue a message
 * with `steer` or `followUp` instead, or wait with `waitForIdle`.
 */
export class AgentBusy extends Schema.TaggedError<AgentBusy>()("AgentBusy", {
	message: Schema.String,
}) {}

/**
 * There was nothing to continue from: the transcript is empty or holds only system messages, or it ends in an
 * assistant message and no steering or follow-up message is queued.
 */
export class CannotContinue extends Schema.TaggedError<CannotContinue>()("CannotContinue", {
	message: Schema.String,
}) {}

/**
 * Every failure of a call into pi-agent-core. Pi rejects with plain `Error`s, not classes of its own; each rejection
 * it documents has a tag here, and anything else it rejects with is a defect.
 */
export type AgentError = AgentBusy | CannotContinue;
