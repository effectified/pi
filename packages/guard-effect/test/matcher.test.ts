import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Matcher } from "../src/index.ts";

describe("words", () => {
	it("splits snake, kebab, dotted and camel case names into lower-case words", () => {
		expect(Matcher.words("sign_document")).toEqual(["sign", "document"]);
		expect(Matcher.words("signDocument")).toEqual(["sign", "document"]);
		expect(Matcher.words("sign-document.now")).toEqual(["sign", "document", "now"]);
		expect(Matcher.words("SignDocument")).toEqual(["sign", "document"]);
		expect(Matcher.words("DELETE_ALL")).toEqual(["delete", "all"]);
	});

	it("keeps an acronym together and digits apart", () => {
		expect(Matcher.words("exportPDF")).toEqual(["export", "pdf"]);
		expect(Matcher.words("HTTPServer")).toEqual(["http", "server"]);
		expect(Matcher.words("send2")).toEqual(["send", "2"]);
	});

	it("sees one word where nothing separates two, and none in a name without ASCII letters or digits", () => {
		expect(Matcher.words("approveclaim")).toEqual(["approveclaim"]);
		expect(Matcher.words("__")).toEqual([]);
		expect(Matcher.words("löschen")).toEqual(["l", "schen"]);
	});
});

describe("matches", () => {
	const verbs = Matcher.firstWord(["approve", "sign", "export", "send", "delete"]);

	it("a first word matches the verb in snake and camel case, alone, and whatever its capitals", () => {
		for (const name of [
			"approve_claim",
			"approveClaim",
			"approve",
			"Approve_Claim",
			"SIGN",
			"export-pdf",
			"send2",
			"deleteAll",
		]) {
			expect([name, Matcher.matches(verbs, name)]).toEqual([name, true]);
		}
	});

	it("a first word does not match a longer word, a later word, or a name that only starts with the letters", () => {
		for (const name of ["approval_status", "signature_lookup", "bulk_delete", "resend", "exporter", "search"]) {
			expect([name, Matcher.matches(verbs, name)]).toEqual([name, false]);
		}
	});

	it("any word matches the term wherever it stands", () => {
		const anywhere = Matcher.anyWord(["Delete"]);
		expect(Matcher.matches(anywhere, "bulk_delete")).toBe(true);
		expect(Matcher.matches(anywhere, "bulkDeleteRows")).toBe(true);
		expect(Matcher.matches(anywhere, "undelete")).toBe(false);
	});

	it("an exact name and a prefix compare the characters as they are", () => {
		expect(Matcher.matches(Matcher.exact("drop_table"), "drop_table")).toBe(true);
		expect(Matcher.matches(Matcher.exact("drop_table"), "Drop_table")).toBe(false);
		expect(Matcher.matches(Matcher.exact("drop_table"), "drop_table_now")).toBe(false);
		expect(Matcher.matches(Matcher.prefix("admin__"), "admin__reset")).toBe(true);
		expect(Matcher.matches(Matcher.prefix("admin__"), "Admin__reset")).toBe(false);
		expect(Matcher.matches(Matcher.prefix("sign"), "signature_lookup")).toBe(true);
	});
});

describe("Matcher", () => {
	it("is data: the constructors give what the schema decodes from JSON", () => {
		const decode = Schema.decodeUnknownSync(Schema.Array(Matcher.Matcher));
		const json = JSON.parse(
			JSON.stringify([Matcher.exact("a"), Matcher.prefix("b"), Matcher.firstWord(["c"]), Matcher.anyWord(["d"])]),
		);
		expect(decode(json)).toEqual([
			{ _tag: "Exact", name: "a" },
			{ _tag: "Prefix", prefix: "b" },
			{ _tag: "Word", words: ["c"], position: "first" },
			{ _tag: "Word", words: ["d"], position: "any" },
		]);
		expect(() => decode([{ _tag: "Regex", source: ".*" }])).toThrow();
	});

	it("describes itself for an error message", () => {
		expect(Matcher.describe(Matcher.exact("a"))).toBe("the name a");
		expect(Matcher.describe(Matcher.prefix("b"))).toBe("the prefix b");
		expect(Matcher.describe(Matcher.firstWord(["c", "d"]))).toBe("the first word c, d");
		expect(Matcher.describe(Matcher.anyWord(["e"]))).toBe("a word e");
	});
});
