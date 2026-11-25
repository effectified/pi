// The citation check: every citation of an answer must resolve and support its claim, as the product's verifier says.

import { Context, Effect } from "effect";
import * as Check from "./check.ts";
import type { Finding } from "./finding.ts";

/** The name the citation check has: on its findings and its failures. */
export const NAME = "review.citations";

/** One citation of an answer, as the product's extractor found it. */
export interface Citation {
	/** What is cited, in the product's terms: a URL, a document id, a paragraph number. */
	readonly source: string;
	/** The statement of the answer the citation is given for. */
	readonly claim: string;
	/** Where in the answer the citation stands; a finding about it carries this, or the source. */
	readonly location?: string;
}

/**
 * What the verifier says of one citation: it resolves and supports its claim, it does not resolve, or it resolves and
 * does not support the claim. `reason` is added to the finding the author reads.
 */
export type Verification =
	| { readonly _tag: "Verified" }
	| { readonly _tag: "Unresolved"; readonly reason?: string }
	| { readonly _tag: "Unsupported"; readonly reason?: string };

/**
 * The port a product provides: whether a citation resolves and supports its claim. A `verify` that fails says nothing
 * about the citation: the check then fails, and the answer is recorded as not reviewed.
 */
export class Verifier extends Context.Service<
	Verifier,
	{ readonly verify: (citation: Citation) => Effect.Effect<Verification, unknown> }
>()("@gunta/pi-review-effect/Citations/Verifier") {}

/**
 * The citation check: `extract` finds the citations of an answer's text, and the `Verifier` of the context is asked
 * about each, one after another, in order. Every citation that is not verified is a `block` finding. An answer
 * without citations has no finding. The registry the check is installed in requires `Verifier`.
 */
export function check(extract: (answer: string) => ReadonlyArray<Citation>): Check.Check<Verifier> {
	return Check.make(NAME, (subject) =>
		Effect.gen(function* () {
			const verifier = yield* Verifier;
			const findings: Finding[] = [];
			for (const citation of extract(subject.answer)) {
				const verification = yield* verifier.verify(citation);
				if (verification._tag !== "Verified") findings.push(unverified(citation, verification));
			}
			return findings;
		}),
	);
}

/** The blocking finding for a citation the verifier did not verify. */
function unverified(citation: Citation, verification: Exclude<Verification, { readonly _tag: "Verified" }>): Finding {
	const what =
		verification._tag === "Unresolved"
			? `The citation "${citation.source}" does not resolve`
			: `The citation "${citation.source}" does not support the claim "${citation.claim}"`;
	return {
		severity: "block",
		text: verification.reason === undefined ? `${what}.` : `${what}: ${verification.reason}`,
		location: citation.location ?? citation.source,
	};
}
