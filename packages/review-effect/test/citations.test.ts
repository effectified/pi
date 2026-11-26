import { answer } from "@effectified/pi-durable/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { Subject } from "../src/check.ts";
import { Citations, state } from "../src/index.ts";
import { ask, findings, scene, textOf, transcript } from "./scene.ts";

/** Citations as `[source]` at the end of a sentence, which is the claim. */
const extract = (text: string): ReadonlyArray<Citations.Citation> =>
	[...text.matchAll(/([^.\]]+?)\s*\[([^\]]+)\]/g)].map((match) => ({
		source: match[2] ?? "",
		claim: (match[1] ?? "").trim(),
	}));

/** A verifier that knows two sources: one supports "the sky is blue", the other nothing. */
function verifier(asked: Citations.Citation[] = []) {
	return Layer.succeed(Citations.Verifier, {
		verify: (citation) =>
			Effect.sync((): Citations.Verification => {
				asked.push(citation);
				if (citation.source === "atlas") {
					return citation.claim.includes("blue")
						? { _tag: "Verified" }
						: { _tag: "Unsupported", reason: "The atlas says nothing of it." };
				}
				return citation.source === "almanac" ? { _tag: "Unsupported" } : { _tag: "Unresolved" };
			}),
	});
}

const found = (text: string) =>
	Citations.check(extract)
		.run({ answer: text } as unknown as Subject)
		.pipe(Effect.provide(verifier()), Effect.runPromise);

describe("Citations.check", () => {
	it("finds nothing in an answer without citations, or whose citations are all verified", async () => {
		expect(await found("The sky is blue.")).toEqual([]);
		expect(await found("The sky is blue [atlas].")).toEqual([]);
	});

	it("blocks a citation that does not resolve", async () => {
		expect(await found("The sky is blue [gazette].")).toEqual([
			{ severity: "block", text: 'The citation "gazette" does not resolve.', location: "gazette" },
		]);
	});

	it("blocks a citation that does not support its claim, with the verifier's reason", async () => {
		expect(await found("The sea is green [atlas]. Grass is red [almanac].")).toEqual([
			{
				severity: "block",
				text: 'The citation "atlas" does not support the claim "The sea is green": The atlas says nothing of it.',
				location: "atlas",
			},
			{
				severity: "block",
				text: 'The citation "almanac" does not support the claim "Grass is red".',
				location: "almanac",
			},
		]);
	});

	it("asks the verifier about every citation, in order, and puts the citation's own location on the finding", async () => {
		const asked: Citations.Citation[] = [];
		const located = Citations.check(() => [
			{ source: "atlas", claim: "the sky is blue" },
			{ source: "gazette", claim: "it rains", location: "paragraph 2" },
		]);
		const findings = await Effect.runPromise(
			located.run({ answer: "" } as unknown as Subject).pipe(Effect.provide(verifier(asked))),
		);
		expect(asked.map((citation) => citation.source)).toEqual(["atlas", "gazette"]);
		expect(findings).toEqual([
			{ severity: "block", text: 'The citation "gazette" does not resolve.', location: "paragraph 2" },
		]);
	});

	it("fails, and finds nothing, when the verifier fails", async () => {
		const down = Layer.succeed(Citations.Verifier, { verify: () => Effect.fail("The index is down") });
		const check = Citations.check(extract);
		const failed = await Effect.runPromise(
			Effect.flip(check.run({ answer: "The sky is blue [atlas]." } as unknown as Subject)).pipe(
				Effect.provide(down),
			),
		);
		expect([check.name, failed]).toEqual(["review.citations", "The index is down"]);
	});
});

describe("the citation check in a review", () => {
	it("sends an answer with an unverifiable citation back, and passes the one whose citations are verified", async () => {
		const cited = scene({
			checks: [Citations.check(extract)],
			author: [answer("The sky is blue [gazette]."), answer("The sky is blue [atlas].")],
			reviewer: [findings(), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask("What colour is the sky?");
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { status: settled.status, transcript: yield* transcript(root), state: yield* state(root) };
			}).pipe(Effect.provide(cited.layer), Effect.provide(verifier())),
		);
		const blocking = {
			check: "review.citations",
			severity: "block",
			text: 'The citation "gazette" does not resolve.',
			location: "gazette",
		};
		expect(result.transcript.filter(([kind]) => kind === "review.verdict").map(([, data]) => data)).toMatchObject([
			{ pass: 1, corrections: 1, findings: [blocking], failures: [], outcome: { _tag: "Corrected" } },
			{ pass: 2, corrections: 1, findings: [], failures: [], outcome: { _tag: "Passed" } },
		]);
		expect(textOf(cited.authorRequests[1]?.at(-1))).toContain(
			'1. [block] The citation "gazette" does not resolve. (at: gazette)',
		);
		expect([result.status, result.state._tag]).toEqual(["done", "Reviewed"]);
	});

	it("never passes an answer whose citations could not be checked", async () => {
		const unchecked = scene({
			checks: [Citations.check(extract)],
			author: [answer("The sky is blue [atlas].")],
			reviewer: [findings()],
		});
		const down = Layer.succeed(Citations.Verifier, { verify: () => Effect.fail(new Error("The index is down")) });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask("What colour is the sky?");
				yield* submission.wait;
				return yield* state(root);
			}).pipe(Effect.provide(unchecked.layer), Effect.provide(down)),
		);
		expect(result).toMatchObject({
			_tag: "NotReviewed",
			reason: "check_failed",
			verdict: {
				findings: [],
				failures: [{ check: "review.citations", error: "The index is down" }],
				outcome: { _tag: "NotReviewed", reason: "check_failed" },
			},
		});
	});
});
