// The typed failures of this package: a registry or a policy the guard refuses, a grant it cannot give, and a record of
// a refusal it cannot read.

import { Conversation } from "@effectified/pi-durable";
import { Schema } from "effect";
import * as Matcher from "./matcher.ts";

/** An extension holds a tool the policy says can never be registered: no registry is built. */
export class DeniedTool extends Schema.TaggedError<DeniedTool>()("DeniedTool", {
	tool: Schema.String,
	extension: Schema.String,
	/** The matcher of the policy's `denied` list that names the tool. */
	rule: Matcher.Matcher,
}) {
	override get message(): string {
		return `Tool ${this.tool} of extension ${this.extension} can never be registered: the policy denies ${Matcher.describe(this.rule)}`;
	}
}

/** The policy contradicts itself, such as a ceiling that is not one of its classifications. */
export class InvalidPolicy extends Schema.TaggedError<InvalidPolicy>()("InvalidPolicy", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

/** An extension has the name of the guard's own, and would replace it in the registry. */
export class ReservedExtension extends Schema.TaggedError<ReservedExtension>()("ReservedExtension", {
	extension: Schema.String,
}) {
	override get message(): string {
		return `The extension name ${this.extension} is the guard's own`;
	}
}

/** A grant names a classification the policy does not list. */
export class UnknownClassification extends Schema.TaggedError<UnknownClassification>()("UnknownClassification", {
	classification: Schema.String,
}) {
	override get message(): string {
		return `The policy has no classification ${this.classification}`;
	}
}

/**
 * The model may not serve the classification: its ceiling is below it, the policy lists no ceiling for it (`ceiling`
 * absent), or the conversation has no classification (`classification` absent).
 */
export class ModelNotCleared extends Schema.TaggedError<ModelNotCleared>()("ModelNotCleared", {
	provider: Schema.String,
	modelId: Schema.String,
	classification: Schema.optional(Schema.String),
	ceiling: Schema.optional(Schema.String),
}) {
	override get message(): string {
		const model = `Model ${this.provider}/${this.modelId}`;
		if (this.ceiling === undefined) return `${model} has no classification ceiling`;
		if (this.classification === undefined) return `${model} may not serve a conversation without a classification`;
		return `${model} is cleared up to ${this.ceiling}, not for ${this.classification}`;
	}
}

/**
 * The conversation does not run under the guard, so nothing would enforce its grant:
 *
 * - `no-registry`: the guard built no registry at all (`Guard.registry`, `Guard.layer`).
 * - `not-selected`: the conversation's harness runs on a registry this guard did not build, the guard's extension
 *   was replaced there, or the conversation's selection of extensions leaves it out.
 * - `not-first`: the guard's extension is not the first one asked.
 */
export class Unguarded extends Schema.TaggedError<Unguarded>()("Unguarded", {
	conversationId: Conversation.Id,
	reason: Schema.Literals(["no-registry", "not-selected", "not-first"]),
}) {
	override get message(): string {
		if (this.reason === "no-registry") {
			return `This guard built no registry: nothing would enforce a grant of conversation ${this.conversationId}`;
		}
		return this.reason === "not-selected"
			? `Conversation ${this.conversationId} does not select the guard's extension`
			: `Conversation ${this.conversationId} asks another extension before the guard's`;
	}
}

/**
 * The record of a refusal in a tool result's details does not decode: written by another version of this package, or
 * by something else under the same key.
 */
export class MalformedRefusal extends Schema.TaggedError<MalformedRefusal>()("MalformedRefusal", {
	reason: Schema.String,
}) {
	override get message(): string {
		return `details.guard: ${this.reason}`;
	}
}
