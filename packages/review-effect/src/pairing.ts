// The family rule: a reviewer reviews an author only when both families are known and differ.

import { Option } from "effect";
import { familyOf, type ModelRef, type Policy } from "./policy.ts";
import type { Party } from "./verdict.ts";

/** An author and a reviewer with their families, and whether that reviewer may review that author. */
export type Pairing =
	| { readonly _tag: "Reviewable"; readonly author: Party; readonly reviewer: Party }
	| {
			readonly _tag: "Unreviewable";
			readonly author: Party;
			readonly reviewer: Party;
			readonly reason: "author_family_unknown" | "reviewer_family_unknown" | "same_family";
	  };

/**
 * Pairs `author` with `reviewer`: the policy's reviewer before a request, and afterwards the model the reviewer's
 * response names, which behind a router alias is the route that served. It fails closed: an author or a reviewer
 * the family table does not place, and a reviewer of the author's family, give `Unreviewable`.
 */
export function pair(policy: Policy, author: ModelRef, reviewer: ModelRef = policy.reviewer): Pairing {
	const authorFamily = familyOf(policy.families, author);
	const reviewerFamily = familyOf(policy.families, reviewer);
	const parties = { author: party(author, authorFamily), reviewer: party(reviewer, reviewerFamily) };
	if (Option.isNone(authorFamily)) return { _tag: "Unreviewable", ...parties, reason: "author_family_unknown" };
	if (Option.isNone(reviewerFamily)) return { _tag: "Unreviewable", ...parties, reason: "reviewer_family_unknown" };
	if (authorFamily.value === reviewerFamily.value) return { _tag: "Unreviewable", ...parties, reason: "same_family" };
	return { _tag: "Reviewable", ...parties };
}

function party(model: ModelRef, family: Option.Option<string>): Party {
	return {
		provider: model.provider,
		modelId: model.modelId,
		...(Option.isSome(family) ? { family: family.value } : {}),
	};
}
