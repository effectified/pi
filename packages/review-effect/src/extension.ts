// The extension a product installs: the `onYield` hook that asks for a review of every final answer, and the review
// task.

import { type Extension, Hook } from "@effectified/pi-durable";
import { Effect, Option } from "effect";
import type * as Check from "./check.ts";
import * as Correction from "./correction.ts";
import type { Policy } from "./policy.ts";
import * as ReviewTask from "./review-task.ts";

/** The name of the review extension. */
export const NAME = "review";

/** What the extension is made from. `Checks` is the list as written, so each check keeps its own requirements. */
export interface Options<Checks extends ReadonlyArray<Check.Any> = readonly []> {
	readonly policy: Policy;
	/** The product's checks, run after the model review, in order: the citation check, and its own. Default: none. */
	readonly checks?: Checks;
	/** Writes the correction message from the findings. Default: `Correction.standard`. */
	readonly correction?: Correction.Writer;
}

/** The hooks and the tasks of the extension. `R` is what its checks need. */
export type Review<R> = Extension.Extension<
	readonly [],
	readonly [Hook.Hook<never>],
	readonly [ReviewTask.ReviewTask<R>]
>;

/**
 * The extension `review` for `options`. Its `onYield` hook answers at every final answer, with one review task, so
 * Pi keeps the run's inputs open until that task decided. The registry it is installed in requires the union of what
 * the checks need. Install it after the extensions that guard tool calls, and as the only extension with an
 * `onYield` hook: Pi takes the first `onYield` answer, so a hook before this one that answers leaves the answer
 * without a review, and a hook after it is never asked. `NoInfer`: the checks are read from the argument only, so a
 * call written inside the array of `Registry.layer` does not take them from there.
 */
export function extension<const Checks extends ReadonlyArray<Check.Any> = readonly []>(
	options: Options<Checks>,
): Review<Check.Services<NoInfer<Checks>[number]>> {
	const task = ReviewTask.make({
		policy: options.policy,
		// TypeScript cannot carry each check's requirement through the list, where it is `unknown`: by construction
		// the checks need the union of what each needs, which is `Check.Services`.
		checks: (options.checks ?? []) as ReadonlyArray<Check.Check<Check.Services<Checks[number]>>>,
		correction: options.correction ?? Correction.standard,
	});
	const asked = Hook.onYield(() =>
		Effect.map(Hook.task(task, {}), (request) => Option.some({ kind: "tasks" as const, tasks: [request] })),
	);
	return { name: NAME, hooks: [asked], tasks: [task] };
}
