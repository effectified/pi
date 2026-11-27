// The citation check: every citation of an answer must resolve and support its claim, as the product's verifier says.

import { Array as Arr, Context, Effect, Option, Schema } from "effect";
import * as Check from "./check.ts";
import type { VerificationFailed } from "./errors.ts";
import type { Finding } from "./finding.ts";

/** The name the citation check has: on its findings and its failures. */
export const NAME = Check.Name.make("review.citations");

/** One citation of an answer, as the product's extractor found it. */
export const Citation = Schema.Struct({
	/** What is cited, in the product's terms: a URL, a document id, a paragraph number. */
	source: Schema.String,
	/** The statement of the answer the citation is given for. */
	claim: Schema.String,
	/** Where in the answer the citation stands; a finding about it carries this, or the source. */
	location: Schema.optionalKey(Schema.String),
});

/** One citation of an answer. */
export type Citation = typeof Citation.Type;

/**
 * What the verifier says of one citation: it resolves and supports its claim, it does not resolve, or it resolves and
 * does not support the claim. `reason` is added to the finding the author reads. `Verification.match` picks a
 * handler per tag.
 */
export const Verification = Schema.TaggedUnion({
	Verified: {},
	Unresolved: { reason: Schema.optionalKey(Schema.String) },
	Unsupported: { reason: Schema.optionalKey(Schema.String) },
});

/** What the verifier says of one citation. */
export type Verification = typeof Verification.Type;

/**
 * The port a product provides: whether a citation resolves and supports its claim. A `verify` that fails, with
 * `VerificationFailed`, says nothing about the citation: the check then fails, and the answer is recorded as not
 * reviewed.
 */
export class Verifier extends Context.Service<
	Verifier,
	{ readonly verify: (citation: Citation) => Effect.Effect<Verification, VerificationFailed> }
>()("@effectified/pi-review/citations/Verifier") {}

/**
 * The citation check: `extract` finds the citations of an answer's text, and the `Verifier` of the context is asked
 * about each, one after another, in order. Every citation that is not verified is a `block` finding. An answer
 * without citations has no finding. The registry the check is installed in requires `Verifier`.
 */
export function check(extract: (answer: string) => ReadonlyArray<Citation>): Check.Check<Verifier, VerificationFailed> {
	return Check.make(
		NAME,
		Effect.fn("Citations.check")(function* (subject: Check.Subject) {
			const verifier = yield* Verifier;
			const unverified = yield* Effect.forEach(
				extract(subject.answer),
				(citation) => Effect.map(verifier.verify(citation), (verification) => findingOf(citation, verification)),
				{ concurrency: 1 },
			);
			return Arr.getSomes(unverified);
		}),
	);
}

/** The blocking finding for a citation the verifier did not verify; none for a verified one. */
function findingOf(citation: Citation, verification: Verification): Option.Option<Finding> {
	return Verification.match(verification, {
		Verified: () => Option.none(),
		Unresolved: ({ reason }) =>
			Option.some(blocking(citation, `The citation "${citation.source}" does not resolve`, reason)),
		Unsupported: ({ reason }) =>
			Option.some(
				blocking(
					citation,
					`The citation "${citation.source}" does not support the claim "${citation.claim}"`,
					reason,
				),
			),
	});
}

/** A `block` finding about `citation` that says `what`, and why when the verifier said. */
function blocking(citation: Citation, what: string, reason: string | undefined): Finding {
	return {
		severity: "block",
		text: reason === undefined ? `${what}.` : `${what}: ${reason}`,
		location: citation.location ?? citation.source,
	};
}
