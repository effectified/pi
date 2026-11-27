import { fromPiModelRef } from "@effectified/pi-ai";
import { describe, expect, it } from "vitest";
import { pair } from "../src/pairing.ts";
import { AUTHOR, PARTIES, POLICY, REVIEWER } from "./scene.ts";

describe("pair", () => {
	it("lets a reviewer of another family review, and names both families", () => {
		expect(pair(POLICY, AUTHOR)).toEqual({ _tag: "Reviewable", ...PARTIES });
	});

	it("refuses a reviewer of the author's family", () => {
		const families = [PARTIES.author, { ...REVIEWER, family: "alpha" }];
		expect(pair({ ...POLICY, families }, AUTHOR)).toEqual({
			_tag: "Unreviewable",
			author: PARTIES.author,
			reviewer: { ...REVIEWER, family: "alpha" },
			reason: "same_family",
		});
	});

	it("refuses an author the table does not place, and stores no family for it", () => {
		expect(pair({ ...POLICY, families: [PARTIES.reviewer] }, AUTHOR)).toEqual({
			_tag: "Unreviewable",
			author: AUTHOR,
			reviewer: PARTIES.reviewer,
			reason: "author_family_unknown",
		});
	});

	it("refuses a reviewer the table does not place", () => {
		expect(pair({ ...POLICY, families: [PARTIES.author] }, AUTHOR)).toEqual({
			_tag: "Unreviewable",
			author: PARTIES.author,
			reviewer: REVIEWER,
			reason: "reviewer_family_unknown",
		});
	});

	it("pairs the author with another reviewer than the policy's: the model that answered", () => {
		const JUDGE = fromPiModelRef({ provider: "judge-lab", modelId: "judge-2" });
		const families = [...POLICY.families, { ...JUDGE, family: "beta" }];
		expect(pair({ ...POLICY, families }, AUTHOR, JUDGE)).toEqual({
			_tag: "Reviewable",
			author: PARTIES.author,
			reviewer: { ...JUDGE, family: "beta" },
		});
		// The policy's reviewer is of another family; the model that answered is the author's own, or unknown.
		expect(pair(POLICY, AUTHOR, AUTHOR)).toMatchObject({ _tag: "Unreviewable", reason: "same_family" });
		expect(pair(POLICY, AUTHOR, JUDGE)).toEqual({
			_tag: "Unreviewable",
			author: PARTIES.author,
			reviewer: JUDGE,
			reason: "reviewer_family_unknown",
		});
	});

	it("refuses the reviewer as the author of the answer it would review", () => {
		expect(pair(POLICY, REVIEWER)).toMatchObject({ _tag: "Unreviewable", reason: "same_family" });
	});
});
