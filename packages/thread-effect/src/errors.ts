// The typed failures of this package's own services: a thread the product did not set up, and one it may not start.

import { Schema } from "effect";

/** No thread was started under this key in this harness storage. */
export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
	thread: Schema.String,
}) {
	override get message(): string {
		return `No thread ${this.thread}`;
	}
}

/** A model as a provider names it: one route of an alias, or a model that is asked for directly. */
const Route = Schema.Struct({ provider: Schema.String, modelId: Schema.String });

/**
 * The thread was not started: it asks for a review, and a model that may review it is of the family of a model that
 * may write its answers. `conflicts` names every such pair by its routes. A review by such a route judges nothing,
 * and is paid for.
 */
export class ReviewerSharesFamily extends Schema.TaggedError<ReviewerSharesFamily>()("ReviewerSharesFamily", {
	thread: Schema.String,
	conflicts: Schema.Array(Schema.Struct({ family: Schema.String, author: Route, reviewer: Route })),
}) {
	override get message(): string {
		const pairs = this.conflicts.map(
			({ family, author, reviewer }) =>
				`${reviewer.provider}/${reviewer.modelId} reviews ${author.provider}/${author.modelId} (${family})`,
		);
		return `Thread ${this.thread} is not started: a reviewer's route is of an author's family: ${pairs.join(", ")}`;
	}
}
