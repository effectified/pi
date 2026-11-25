import { describe, expect, it } from "vitest";
import { Grant } from "../src/index.ts";

describe("Document", () => {
	it("is a conversation document of this plugin that a fork copies as its parent has it now", () => {
		expect(Grant.Document).toMatchObject({
			kind: "guard.grant",
			version: 1,
			scope: "conversation",
			history: "latest",
		});
		expect(Grant.Document.token.definition).toMatchObject({ kind: "guard.grant", fork: "current" });
	});
});

describe("normalize", () => {
	it("keeps each tool once, in the order given, and no classification key without a value", () => {
		expect(Grant.normalize({ tools: ["read", "search", "read"] })).toEqual({ tools: ["read", "search"] });
		const unlabelled = Grant.normalize({ tools: [], classification: undefined });
		expect(Object.keys(unlabelled)).toEqual(["tools"]);
		expect(Grant.normalize({ tools: ["read"], classification: "internal" })).toEqual({
			tools: ["read"],
			classification: "internal",
		});
	});
});

describe("effective", () => {
	const ungranted = { tools: ["read"] };

	it("is the stored grant when the conversation has one, an empty one included", () => {
		expect(Grant.effective({ grant: { tools: ["search"] } }, ungranted)).toEqual({ tools: ["search"] });
		expect(Grant.effective({ grant: { tools: [] } }, ungranted)).toEqual({ tools: [] });
	});

	it("is the policy's grant for a conversation without a document or without a grant", () => {
		expect(Grant.effective(undefined, ungranted)).toBe(ungranted);
		expect(Grant.effective({ grant: null }, ungranted)).toBe(ungranted);
	});
});
