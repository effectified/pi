// The typed failures of this package: a registry or a policy the guard refuses, a grant it cannot give, and a record of
// a refusal it cannot read.

import { Agent, Conversation, ToolName } from "@effectified/pi-durable";
import { Schema } from "effect";
import * as Matcher from "./matcher.ts";

/** An extension holds a tool the policy says can never be registered: no registry is built. */
export class DeniedTool extends Schema.TaggedError<DeniedTool, { readonly brand: unique symbol }>()("DeniedTool", {
	tool: ToolName,
	extension: Schema.String,
	/** The matcher of the policy's `denied` list that names the tool. */
	rule: Matcher.Matcher,
}) {
	override get message(): string {
		return `Tool ${this.tool} of extension ${this.extension} can never be registered: the policy denies ${Matcher.describe(this.rule)}`;
	}
}

/** The policy contradicts itself, such as a ceiling that is not one of its classifications. */
export class InvalidPolicy extends Schema.TaggedError<InvalidPolicy, { readonly brand: unique symbol }>()(
	"InvalidPolicy",
	{ reason: Schema.String },
) {
	override get message(): string {
		return this.reason;
	}
}

/** An extension has the name of the guard's own, and would replace it in the registry. */
export class ReservedExtension extends Schema.TaggedError<ReservedExtension, { readonly brand: unique symbol }>()(
	"ReservedExtension",
	{ extension: Schema.String },
) {
	override get message(): string {
		return `The extension name ${this.extension} is the guard's own`;
	}
}

/** A grant names a classification the policy does not list. */
export class UnknownClassification extends Schema.TaggedError<
	UnknownClassification,
	{ readonly brand: unique symbol }
>()("UnknownClassification", { classification: Schema.String }) {
	override get message(): string {
		return `The policy has no classification ${this.classification}`;
	}
}

/**
 * The model may not serve the classification: its ceiling is below it, the policy lists no ceiling for it (`ceiling`
 * absent), or the conversation has no classification (`classification` absent). The model is named with
 * `@effectified/pi-ai`'s branded ids, as `Agent.ModelRef` names it.
 */
export class ModelNotCleared extends Schema.TaggedError<ModelNotCleared, { readonly brand: unique symbol }>()(
	"ModelNotCleared",
	{
		...Agent.ModelRef.fields,
		classification: Schema.optional(Schema.String),
		ceiling: Schema.optional(Schema.String),
	},
) {
	override get message(): string {
		const model = `Model ${this.provider}/${this.modelId}`;
		if (this.ceiling === undefined) return `${model} has no classification ceiling`;
		if (this.classification === undefined) return `${model} may not serve a conversation without a classification`;
		return `${model} is cleared up to ${this.ceiling}, not for ${this.classification}`;
	}
}

/**
 * Why a conversation does not run under the guard, a case each, so a caller picks one with `Effect.catchReason`:
 *
 * - `NoRegistry`: the guard built no registry at all (`Guard.registry`, `Guard.layer`).
 * - `NotSelected`: the conversation's harness runs on a registry this guard did not build, the guard's extension was
 *   replaced there, or the conversation's selection of extensions leaves it out.
 * - `NotFirst`: the guard's extension is not the first one asked.
 */
export const UnguardedReason = Schema.TaggedUnion({ NoRegistry: {}, NotSelected: {}, NotFirst: {} });

/** Why a conversation does not run under the guard. */
export type UnguardedReason = typeof UnguardedReason.Type;

/** The conversation does not run under the guard, so nothing would enforce its grant; `reason` says why. */
export class Unguarded extends Schema.TaggedError<Unguarded, { readonly brand: unique symbol }>()("Unguarded", {
	conversationId: Conversation.Id,
	reason: UnguardedReason,
}) {
	override get message(): string {
		const id = this.conversationId;
		return UnguardedReason.match(this.reason, {
			NoRegistry: () => `This guard built no registry: nothing would enforce a grant of conversation ${id}`,
			NotSelected: () => `Conversation ${id} does not select the guard's extension`,
			NotFirst: () => `Conversation ${id} asks another extension before the guard's`,
		});
	}
}

/**
 * The record of a refusal in a tool result's details does not decode: written by another version of this package, or
 * by something else under the same key.
 */
export class MalformedRefusal extends Schema.TaggedError<MalformedRefusal, { readonly brand: unique symbol }>()(
	"MalformedRefusal",
	{ reason: Schema.String },
) {
	override get message(): string {
		return `details.guard: ${this.reason}`;
	}
}
