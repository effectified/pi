// The family rule: a reviewer reviews an author only when both families are known and differ.

import { Option, Schema } from "effect";
import { familyOf, type ModelRef, type Policy } from "./policy.ts";
import { Party, Unreviewed } from "./verdict.ts";

/**
 * An author and a reviewer with their families, and whether that reviewer may review that author: `Reviewable`, or
 * `Unreviewable` with the reason, which is one of a verdict's (`Unreviewed`).
 */
export const Pairing = Schema.TaggedUnion({
	Reviewable: { author: Party, reviewer: Party },
	Unreviewable: {
		author: Party,
		reviewer: Party,
		reason: Unreviewed.pick(["author_family_unknown", "reviewer_family_unknown", "same_family"]),
	},
});

/** An author and a reviewer with their families, and whether that reviewer may review that author. */
export type Pairing = typeof Pairing.Type;

/**
 * Pairs `author` with `reviewer`: the policy's reviewer before a request, and afterwards the model the reviewer's
 * response names, which behind a router alias is the route that served. It fails closed: an author or a reviewer
 * the family table does not place, and a reviewer of the author's family, give `Unreviewable`.
 */
export function pair(policy: Policy, author: ModelRef, reviewer: ModelRef = policy.reviewer): Pairing {
	const authorFamily = familyOf(policy.families, author);
	const reviewerFamily = familyOf(policy.families, reviewer);
	const parties = { author: party(author, authorFamily), reviewer: party(reviewer, reviewerFamily) };
	const unreviewable = (reason: typeof Pairing.cases.Unreviewable.Type.reason) =>
		Pairing.cases.Unreviewable.make({ ...parties, reason });
	if (Option.isNone(authorFamily)) return unreviewable("author_family_unknown");
	if (Option.isNone(reviewerFamily)) return unreviewable("reviewer_family_unknown");
	if (authorFamily.value === reviewerFamily.value) return unreviewable("same_family");
	return Pairing.cases.Reviewable.make(parties);
}

/** `model` as a party of a review, with its family when the table gives one. */
function party(model: ModelRef, family: Option.Option<string>): Party {
	return Party.make({
		provider: model.provider,
		modelId: model.modelId,
		...(Option.isSome(family) ? { family: family.value } : {}),
	});
}
