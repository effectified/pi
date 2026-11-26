// Classification ceilings: whether a conversation's classification stays within what a tool or a model may see.

import type { Agent } from "@effectified/pi-durable";
import { Effect } from "effect";
import { ModelNotCleared } from "./errors.ts";
import type { Policy } from "./policy.ts";

/** A model as Pi names it: Pi's `ModelRef`. */
export type ModelRef = Agent.ModelRef;

/**
 * Whether `classification` is at most `ceiling` in `labels`, which run lowest to highest. An absent classification,
 * and a label that is not listed, are above every ceiling.
 */
export function within(labels: ReadonlyArray<string>, ceiling: string, classification: string | undefined): boolean {
	const allowed = labels.indexOf(ceiling);
	const held = classification === undefined ? -1 : labels.indexOf(classification);
	return allowed >= 0 && held >= 0 && held <= allowed;
}

/**
 * Whether the tool `name` may be called by a conversation of `classification`: its ceiling is not below it. A tool
 * the policy gives no ceiling may be called at every classification.
 */
export function toolCleared(policy: Policy, name: string, classification: string | undefined): boolean {
	const ceiling = Object.hasOwn(policy.toolCeilings, name) ? policy.toolCeilings[name] : undefined;
	return ceiling === undefined || within(policy.classifications, ceiling, classification);
}

/**
 * Succeeds when `model` may serve a conversation of `classification`: the policy lists a ceiling for the model, and
 * it is not below the classification. A policy without classifications clears every model. The check is pure: it
 * stops nothing by itself, so apply it wherever a model is chosen.
 */
export function checkModel(
	policy: Policy,
	model: ModelRef,
	classification: string | undefined,
): Effect.Effect<void, ModelNotCleared> {
	if (policy.classifications.length === 0) return Effect.void;
	const { provider, modelId } = model;
	const ceiling = policy.modelCeilings.find(
		(listed) => listed.provider === provider && listed.modelId === modelId,
	)?.ceiling;
	return ceiling !== undefined && within(policy.classifications, ceiling, classification)
		? Effect.void
		: Effect.fail(new ModelNotCleared({ provider, modelId, classification, ceiling }));
}
