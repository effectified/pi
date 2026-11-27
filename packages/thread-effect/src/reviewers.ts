// The reviewer check of the composition: the route table and the family table held against each other, for one
// thread's model, before the thread is started.

import { fromPiModelRef } from "@effectified/pi-ai";
import * as Review from "@effectified/pi-review";
import type { RouteTable } from "@effectified/pi-router";
import { Array as Arr, Context, Effect, Layer, Option } from "effect";
import { type FamilyConflict, ReviewerSharesFamily } from "./errors.ts";
import type { ThreadKey } from "./ids.ts";

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
		readonly check: (thread: ThreadKey, model: Review.Policy.ModelRef) => Effect.Effect<void, ReviewerSharesFamily>;
	}
>()("@effectified/pi-thread/reviewers") {}

/** A model that may serve a request, with the family the review's table gives it. */
interface Familied {
	readonly family: string;
	readonly model: Review.Policy.ModelRef;
}

/**
 * The check for the routes of `routes` (the table as a product writes it, or decoded) and the reviewer and the
 * families of `policy`. `router` is the id of the router's provider, under which an alias is a model
 * (`RouterOptions.id`). Data only: a check reads nothing.
 */
export function layer(
	routes: typeof RouteTable.Encoded,
	policy: Review.Policy.Policy,
	router: string,
): Layer.Layer<Reviewers> {
	/** The models that may serve `model`: the routes of its alias, in their order, or the model itself. */
	const serving = (model: Review.Policy.ModelRef): ReadonlyArray<Review.Policy.ModelRef> => {
		const alias =
			model.provider === router
				? Arr.findFirst(routes.aliases, (entry) => entry.alias === model.modelId)
				: Option.none();
		return Option.match(alias, {
			onNone: () => [model],
			onSome: (found) =>
				Arr.map(found.routes, (route) => fromPiModelRef({ provider: route.provider, modelId: route.model })),
		});
	};
	/** The models of `models` the family table lists, with their families. */
	const familied = (models: ReadonlyArray<Review.Policy.ModelRef>): ReadonlyArray<Familied> =>
		Arr.getSomes(
			Arr.map(models, (model) =>
				Option.map(Review.Policy.familyOf(policy.families, model), (family) => ({ family, model })),
			),
		);
	const reviewers = familied(serving(policy.reviewer));
	const check = Effect.fn("Reviewers.check")(function* (thread: ThreadKey, model: Review.Policy.ModelRef) {
		const authors = familied(serving(model));
		const conflicts = Arr.flatMap(authors, (author) =>
			Arr.map(
				Arr.filter(reviewers, (reviewer) => reviewer.family === author.family),
				(reviewer): FamilyConflict => ({ family: author.family, author: author.model, reviewer: reviewer.model }),
			),
		);
		if (Arr.isReadonlyArrayNonEmpty(conflicts)) return yield* ReviewerSharesFamily.make({ thread, conflicts });
	});
	return Layer.succeed(Reviewers, Reviewers.of({ check }));
}
