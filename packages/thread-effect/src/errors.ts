// The typed failures of this package's own services: a thread the product did not set up, and one it may not start.

import { Agent } from "@effectified/pi-durable";
import { Array as Arr, Schema } from "effect";
import { ThreadKey } from "./ids.ts";

/** No thread was started under this key in this harness storage. */
export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound, { readonly brand: unique symbol }>()(
	"ThreadNotFound",
	{ thread: ThreadKey },
) {
	override get message(): string {
		return `No thread ${this.thread}`;
	}
}

/**
 * A model of an author's family that may review it: `author` and `reviewer` are routes, Pi's `ModelRef` (one route of
 * an alias, or a model that is asked for directly), and `family` is the review's family of both.
 */
export const FamilyConflict = Schema.Struct({
	family: Schema.String,
	author: Agent.ModelRef,
	reviewer: Agent.ModelRef,
});

/** A model of an author's family that may review it. */
export type FamilyConflict = typeof FamilyConflict.Type;

/**
 * The thread was not started: it asks for a review, and a model that may review it is of the family of a model that
 * may write its answers. `conflicts` names every such pair by its routes. A review by such a route judges nothing,
 * and is paid for.
 */
export class ReviewerSharesFamily extends Schema.TaggedError<ReviewerSharesFamily, { readonly brand: unique symbol }>()(
	"ReviewerSharesFamily",
	{ thread: ThreadKey, conflicts: Schema.Array(FamilyConflict) },
) {
	override get message(): string {
		const pairs = Arr.map(
			this.conflicts,
			({ family, author, reviewer }) =>
				`${reviewer.provider}/${reviewer.modelId} reviews ${author.provider}/${author.modelId} (${family})`,
		);
		return `Thread ${this.thread} is not started: a reviewer's route is of an author's family: ${Arr.join(pairs, ", ")}`;
	}
}
