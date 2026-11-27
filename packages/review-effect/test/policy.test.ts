import { fromPiModelRef } from "@effectified/pi-ai";
import { Option, Schema } from "effect";
import { pipe } from "effect/Function";
import { describe, expect, it } from "vitest";
import { Policy } from "../src/index.ts";

const WRITER = fromPiModelRef({ provider: "author-lab", modelId: "writer" });
const JUDGE = fromPiModelRef({ provider: "reviewer-lab", modelId: "judge" });

describe("Policy", () => {
	const decode = Schema.decodeUnknownSync(Policy.Policy);
	const policy = {
		reviewer: JUDGE,
		families: [
			{ ...WRITER, family: "alpha" },
			{ ...JUDGE, family: "beta" },
		],
		maxCorrections: 0,
		blocking: "block",
	};

	it("decodes a policy from plain data, with and without instructions", () => {
		expect(decode(policy)).toEqual(policy);
		expect(decode({ ...policy, maxCorrections: 2, instructions: "Check the dates." })).toEqual({
			...policy,
			maxCorrections: 2,
			instructions: "Check the dates.",
		});
	});

	it("refuses a count of corrective runs that is negative or not whole", () => {
		expect(() => decode({ ...policy, maxCorrections: -1 })).toThrow(/maxCorrections/);
		expect(() => decode({ ...policy, maxCorrections: 1.5 })).toThrow(/maxCorrections/);
	});

	it("refuses a blocking severity it does not know", () => {
		expect(() => decode({ ...policy, blocking: "fatal" })).toThrow(/blocking/);
	});
});

describe("familyOf", () => {
	const families = [
		{ ...WRITER, family: "alpha" },
		{ ...JUDGE, family: "beta" },
	];

	it("gives the family of a listed model, by provider and id", () => {
		expect(Policy.familyOf(families, WRITER)).toEqual(Option.some("alpha"));
		expect(Policy.familyOf(families, JUDGE)).toEqual(Option.some("beta"));
	});

	it("gives none for a model that is not listed, also one that shares a provider or an id", () => {
		expect(Policy.familyOf(families, fromPiModelRef({ provider: "author-lab", modelId: "judge" }))).toEqual(
			Option.none(),
		);
		expect(Policy.familyOf([], WRITER)).toEqual(Option.none());
	});

	it("gives none for a model listed under two labels, and its family when the rows agree", () => {
		expect(Policy.familyOf([...families, { ...WRITER, family: "gamma" }], WRITER)).toEqual(Option.none());
		expect(Policy.familyOf([...families, { ...WRITER, family: "alpha" }], WRITER)).toEqual(Option.some("alpha"));
	});

	it("pipes: data-last on the table", () => {
		expect(pipe(families, Policy.familyOf(JUDGE))).toEqual(Option.some("beta"));
	});
});
