// The typed failures of this package: why a subagent was not started, and why a typed result was not accepted.

import { Schema } from "effect";

/** The parent's model named a subagent the product did not declare. */
export class UnknownSubagent extends Schema.TaggedError<UnknownSubagent>()("UnknownSubagent", {
	subagent: Schema.String,
	declared: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `There is no subagent named "${this.subagent}". Declared: ${this.declared.join(", ")}`;
	}
}

/** A subagent may not start one of its own: the child would be deeper than the limit allows. */
export class DepthExceeded extends Schema.TaggedError<DepthExceeded>()("DepthExceeded", {
	/** How deep the asking conversation is: 0 for one that is no subagent. */
	depth: Schema.Number,
	maxDepth: Schema.Number,
}) {
	override get message(): string {
		return `Subagents may nest ${this.maxDepth} deep at most, and this agent is at depth ${this.depth}: do the task yourself`;
	}
}

/** The asking conversation already has as many live subagents as the limit allows. */
export class TooManyChildren extends Schema.TaggedError<TooManyChildren>()("TooManyChildren", {
	live: Schema.Number,
	maxLive: Schema.Number,
}) {
	override get message(): string {
		return `This agent already has as many subagents at work as it may have (${this.maxLive}): wait for one to finish`;
	}
}

/**
 * The product's `ChildSetup` refused a child: what its port fails with. `reason` is read by the parent's model, so it
 * says what to do differently and quotes nothing secret; `cause` is the product's own failure, for a host.
 */
export class ChildSetupFailed extends Schema.TaggedError<ChildSetupFailed>()("ChildSetupFailed", {
	reason: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message(): string {
		return `The subagent could not be set up: ${this.reason}`;
	}
}

/** A value is not what a subagent's declared result `Schema` accepts; `issues` says where, one line each. */
export class ResultMismatch extends Schema.TaggedError<ResultMismatch>()("ResultMismatch", {
	subagent: Schema.String,
	issues: Schema.String,
}) {
	override get message(): string {
		return `The result of subagent "${this.subagent}" does not match its declared schema: ${this.issues}`;
	}
}
