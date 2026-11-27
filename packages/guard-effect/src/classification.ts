// Classification ceilings: whether a conversation's classification stays within what a tool or a model may see.

import type { Agent, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Effect, Option, Record } from "effect";
import { ModelNotCleared } from "./errors.ts";
import type { Encoded } from "./policy.ts";

/** A model as Pi names it, its ids branded: `Agent.ModelRef`. */
export type ModelRef = Agent.ModelRef;

/**
 * Whether `classification` is at most `ceiling` in `labels`, which run lowest to highest. An absent classification,
 * and a label that is not listed, are above every ceiling.
 */
export function within(labels: ReadonlyArray<string>, ceiling: string, classification: string | undefined): boolean {
	const allowed = rank(labels, ceiling);
	const held = classification === undefined ? Option.none() : rank(labels, classification);
	return Option.exists(
		Option.zipWith(allowed, held, (top, at) => at <= top),
		(fits) => fits,
	);
}

/**
 * Whether the tool `name` may be called by a conversation of `classification`: its ceiling is not below it. A tool
 * the policy gives no ceiling may be called at every classification. `policy` is a decoded one or one as a product
 * writes it (`Policy.Encoded`): the check reads its labels and tool ceilings only.
 */
export function toolCleared(
	policy: Pick<Encoded, "classifications" | "toolCeilings">,
	name: ToolName,
	classification: string | undefined,
): boolean {
	return Option.match(Record.get(policy.toolCeilings, name), {
		onNone: () => true,
		onSome: (ceiling) => within(policy.classifications, ceiling, classification),
	});
}

/**
 * Succeeds when `model` may serve a conversation of `classification`: the policy lists a ceiling for the model, and
 * it is not below the classification. A policy without classifications clears every model. The check is pure: it
 * stops nothing by itself, so apply it wherever a model is chosen. `policy` is a decoded one or one as a product
 * writes it (`Policy.Encoded`): the check reads its labels and model ceilings only.
 */
export const checkModel: (
	policy: Pick<Encoded, "classifications" | "modelCeilings">,
	model: ModelRef,
	classification: string | undefined,
) => Effect.Effect<void, ModelNotCleared> = Effect.fn("Classification.checkModel")(
	function* (policy, model, classification) {
		if (Arr.isReadonlyArrayEmpty(policy.classifications)) return;
		const { provider, modelId } = model;
		const ceiling = Option.map(
			Arr.findFirst(policy.modelCeilings, (listed) => listed.provider === provider && listed.modelId === modelId),
			(listed) => listed.ceiling,
		);
		if (Option.exists(ceiling, (top) => within(policy.classifications, top, classification))) return;
		return yield* ModelNotCleared.make({
			provider,
			modelId,
			classification,
			ceiling: Option.getOrUndefined(ceiling),
		});
	},
);

/** The place of `label` in `labels`, from 0: none when it is not listed. */
function rank(labels: ReadonlyArray<string>, label: string): Option.Option<number> {
	return Arr.findFirstIndex(labels, (listed) => listed === label);
}
