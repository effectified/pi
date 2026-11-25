// The reviewer check of the composition: the route table and the family table held against each other, for one
// thread's model, before the thread is started.

import * as Review from "@gunta/pi-review-effect";
import type { RouteTable } from "@gunta/pi-router-effect";
import { Context, Effect, Layer, Option } from "effect";
import { ReviewerSharesFamily } from "./errors.ts";

/**
 * Whether a thread that asks for a review may be started with a model. The review plugin applies its family rule to
 * the reviewer it is configured with before the request, and to the route that served after it: a reviewer alias one
 * of whose routes is of the author's family is found out only once that route was paid. The route table and the
 * family table are two pieces of data, and only the composition has both.
 */
export class Reviewers extends Context.Service<
	Reviewers,
	{
		/**
		 * Fails when a route of the reviewer's alias and a route of `model` are of one family, with every such pair. A
		 * route the family table does not list has no family and is left to the review plugin, which reviews nothing
		 * with it and says so.
		 */
		readonly check: (thread: string, model: Review.Policy.ModelRef) => Effect.Effect<void, ReviewerSharesFamily>;
	}
>()("@gunta/pi-thread-effect/Reviewers") {}

/**
 * The check for the routes of `routes` and the reviewer and the families of `policy`. `router` is the id of the
 * router's provider, under which an alias is a model (`RouterOptions.id`). Data only: a check reads nothing.
 */
export function layer(routes: RouteTable, policy: Review.Policy.Policy, router: string): Layer.Layer<Reviewers> {
	/** The models that may serve `model`: the routes of its alias, in their order, or the model itself. */
	const serving = (model: Review.Policy.ModelRef): ReadonlyArray<Review.Policy.ModelRef> => {
		const alias =
			model.provider === router ? routes.aliases.find((entry) => entry.alias === model.modelId) : undefined;
		return alias === undefined
			? [model]
			: alias.routes.map((route) => ({ provider: route.provider, modelId: route.model }));
	};
	const familyOf = (model: Review.Policy.ModelRef) =>
		Option.map(Review.Policy.familyOf(policy.families, model), (family) => ({ family, model }));
	const reviewers = serving(policy.reviewer).flatMap((model) => Option.toArray(familyOf(model)));
	return Layer.succeed(Reviewers, {
		check: (thread, model) => {
			const authors = serving(model).flatMap((route) => Option.toArray(familyOf(route)));
			const conflicts = authors.flatMap((author) =>
				reviewers
					.filter((reviewer) => reviewer.family === author.family)
					.map((reviewer) => ({ family: author.family, author: author.model, reviewer: reviewer.model })),
			);
			return conflicts.length === 0 ? Effect.void : Effect.fail(new ReviewerSharesFamily({ thread, conflicts }));
		},
	});
}
