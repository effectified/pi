// The typed failures of this package: why a subagent was not started, and why a typed result was not accepted.

import { Array as Arr, Schema } from "effect";
import { Name } from "./subagent-name.ts";

/** A count, 0 or more: of nesting levels, of children at work. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The parent's model named a subagent the product did not declare; `declared` lists those it did, in order. */
export class UnknownSubagent extends Schema.TaggedError<UnknownSubagent, { readonly brand: unique symbol }>()(
	"UnknownSubagent",
	{ subagent: Name, declared: Schema.Array(Name) },
) {
	override get message(): string {
		return `There is no subagent named "${this.subagent}". Declared: ${Arr.join(this.declared, ", ")}`;
	}
}

/** A subagent may not start one of its own: the child would be deeper than the limit allows. */
export class DepthExceeded extends Schema.TaggedError<DepthExceeded, { readonly brand: unique symbol }>()(
	"DepthExceeded",
	{
		/** How deep the asking conversation is: 0 for one that is no subagent. */
		depth: Count,
		maxDepth: Count,
	},
) {
	override get message(): string {
		return `Subagents may nest ${this.maxDepth} deep at most, and this agent is at depth ${this.depth}: do the task yourself`;
	}
}

/** The asking conversation already has as many live subagents as the limit allows. */
export class TooManyChildren extends Schema.TaggedError<TooManyChildren, { readonly brand: unique symbol }>()(
	"TooManyChildren",
	{ live: Count, maxLive: Count },
) {
	override get message(): string {
		return `This agent already has as many subagents at work as it may have (${this.maxLive}): wait for one to finish`;
	}
}

/**
 * The product's `ChildSetup` refused a child: what its port fails with. `reason` is read by the parent's model, so it
 * says what to do differently and quotes nothing secret; `cause` is the product's own failure, for a host.
 */
export class ChildSetupFailed extends Schema.TaggedError<ChildSetupFailed, { readonly brand: unique symbol }>()(
	"ChildSetupFailed",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
	override get message(): string {
		return `The subagent could not be set up: ${this.reason}`;
	}
}

/** A value is not what a subagent's declared result `Schema` accepts; `issues` says where, one line each. */
export class ResultMismatch extends Schema.TaggedError<ResultMismatch, { readonly brand: unique symbol }>()(
	"ResultMismatch",
	{ subagent: Name, issues: Schema.String },
) {
	override get message(): string {
		return `The result of subagent "${this.subagent}" does not match its declared schema: ${this.issues}`;
	}
}
