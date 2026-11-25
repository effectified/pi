import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import type { Hit, Retrieval, Unfetched } from "../src/provider/index.ts";
import { fetchText, searchText } from "../src/render.ts";

function retrieval(hits: ReadonlyArray<Hit>, unfetched: ReadonlyArray<Unfetched> = []): Retrieval {
	return {
		provider: "test",
		request: { method: "POST", url: "https://search.test", body: {} },
		retrievedAt: DateTime.makeUnsafe(0),
		raw: '{"secret":"raw body"}',
		hits,
		unfetched,
	};
}

describe("searchText", () => {
	it("lists each hit with what the provider gave, and nothing of the raw response", () => {
		const text = searchText(
			retrieval([
				{
					url: "https://a.example/",
					title: "Alpha",
					snippet: "One\n\n two.",
					publishedDate: "2026-01-02",
					author: "Ada",
				},
				{ url: "https://b.example/", title: "Beta", author: "Bo" },
				{ url: "https://c.example/" },
			]),
			100,
		);
		expect(text).toBe(
			[
				"1. Alpha\n   https://a.example/\n   2026-01-02 · Ada\n   One two.",
				"2. Beta\n   https://b.example/\n   Bo",
				"3. (no title)\n   https://c.example/",
			].join("\n\n"),
		);
		expect(text).not.toContain("raw body");
	});

	it("cuts a snippet to the limit, and shows page text when a hit has no snippet", () => {
		expect(searchText(retrieval([{ url: "u", title: "T", snippet: "abcdefghij" }]), 4)).toBe(
			"1. T\n   u\n   abcd...",
		);
		expect(searchText(retrieval([{ url: "u", title: "T", snippet: "abcd" }]), 4)).toBe("1. T\n   u\n   abcd");
		expect(searchText(retrieval([{ url: "u", title: "T", text: "page text" }]), 4)).toBe("1. T\n   u\n   page...");
	});

	it("says so when there are no hits", () => {
		expect(searchText(retrieval([]), 100)).toBe("No results.");
	});
});

describe("fetchText", () => {
	it("gives each page's text under its heading, pages apart, and the unread pages last", () => {
		const text = fetchText(
			retrieval(
				[
					{ url: "https://a.example/", title: "Alpha", text: "First page.\n\nSecond paragraph.", author: "Ada" },
					{ url: "https://b.example/" },
				],
				[{ url: "https://gone.example/", reason: "HTTP 404" }],
			),
			1000,
			[{ url: "ftp://x", reason: "not a web address" }],
		);
		expect(text).toBe(
			[
				"# Alpha\nhttps://a.example/\nAda\n\nFirst page.\n\nSecond paragraph.",
				"# (no title)\nhttps://b.example/\n\n(no text)",
				"Not fetched: https://gone.example/ (HTTP 404)\nNot fetched: ftp://x (not a web address)",
			].join("\n\n---\n\n"),
		);
	});

	it("cuts text at the limit with a note, also text of exactly the limit, and never splits a character", () => {
		const page = (text: string) => fetchText(retrieval([{ url: "u", title: "T", text }]), 5, []);
		expect(page("abcdefgh")).toBe("# T\nu\n\nabcde\n\n[Cut at 5 characters.]");
		expect(page("abcde")).toBe("# T\nu\n\nabcde\n\n[Cut at 5 characters.]");
		expect(page("abcd")).toBe("# T\nu\n\nabcd");
		// The fifth UTF-16 unit is the first half of the emoji: the cut steps back before it.
		expect(page("abcd\u{1F600}fgh")).toBe("# T\nu\n\nabcd\n\n[Cut at 5 characters.]");
	});
});
