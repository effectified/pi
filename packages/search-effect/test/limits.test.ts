import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { capFetch, capSearch, defaultLimits, type Limits } from "../src/limits.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const within = (limits: Partial<Limits>): Limits => ({ ...defaultLimits, ...limits });

describe("capSearch", () => {
	it("caps the count, and asks for the default one when none is named", async () => {
		const limits = within({ maxResults: 8, defaultResults: 4 });
		expect(await Effect.runPromise(capSearch(limits, { maxResults: 1000 }))).toStrictEqual({
			maxResults: 8,
			snippetCharacters: 500,
		});
		expect((await Effect.runPromise(capSearch(limits, { maxResults: 2 }))).maxResults).toBe(2);
		expect((await Effect.runPromise(capSearch(limits, {}))).maxResults).toBe(4);
		// A default above the cap is the cap.
		expect((await Effect.runPromise(capSearch(within({ maxResults: 3, defaultResults: 5 }), {}))).maxResults).toBe(3);
	});

	it("passes the model's domains on when no domain is fixed", async () => {
		const options = await Effect.runPromise(
			capSearch(defaultLimits, { includeDomains: ["a.example"], excludeDomains: ["b.example"] }),
		);
		expect(options).toMatchObject({ includeDomains: ["a.example"], excludeDomains: ["b.example"] });
	});

	it("narrows the asked domains to the allowed ones, in any spelling, and always excludes the blocked", async () => {
		const limits = within({ allowedDomains: ["Example.com"], blockedDomains: ["ads.example.com", "b.example"] });
		const options = await Effect.runPromise(
			capSearch(limits, {
				includeDomains: ["https://Docs.example.com/guide", "*.example.com", "notexample.com", "ads.example.com"],
				excludeDomains: ["b.example", "c.example"],
			}),
		);
		expect(options.includeDomains).toEqual(["https://Docs.example.com/guide", "*.example.com"]);
		expect(options.excludeDomains).toEqual(["b.example", "c.example", "ads.example.com"]);
	});

	it("refuses when none of the asked domains is permitted", async () => {
		const refused = await Effect.runPromise(
			Effect.flip(capSearch(within({ blockedDomains: ["b.example"] }), { includeDomains: ["www.b.example"] })),
		);
		expect(refused).toMatchObject({
			_tag: "SearchRefused",
			reason: "None of these domains may be searched: www.b.example.",
		});
		expect(refused.message).toBe(refused.reason);
	});

	it("refuses every search when the allow-list is empty, instead of searching everywhere", async () => {
		const refused = await Effect.runPromise(Effect.flip(capSearch(within({ allowedDomains: [] }), {})));
		expect(refused.reason).toBe("No domain may be searched.");
	});

	it("moves the asked dates inside the fixed range, and refuses a range that is empty", async () => {
		const limits = within({
			publishedAfter: at("2020-01-01T00:00:00Z"),
			publishedBefore: at("2025-01-01T00:00:00Z"),
		});
		expect(await Effect.runPromise(capSearch(limits, {}))).toMatchObject({
			publishedAfter: at("2020-01-01T00:00:00Z"),
			publishedBefore: at("2025-01-01T00:00:00Z"),
		});
		expect(
			await Effect.runPromise(
				capSearch(limits, {
					publishedAfter: at("2022-06-01T00:00:00Z"),
					publishedBefore: at("2030-01-01T00:00:00Z"),
				}),
			),
		).toMatchObject({ publishedAfter: at("2022-06-01T00:00:00Z"), publishedBefore: at("2025-01-01T00:00:00Z") });
		const refused = await Effect.runPromise(
			Effect.flip(capSearch(limits, { publishedAfter: at("2025-01-01T00:00:00Z") })),
		);
		expect(refused.reason).toBe(
			"No page is published after 2025-01-01T00:00:00.000Z and before 2025-01-01T00:00:00.000Z.",
		);
	});
});

describe("capFetch", () => {
	it("keeps the first permitted pages, says why each other one is left out, and caps the text", async () => {
		const limits = within({ maxUrls: 2, maxCharacters: 100, allowedDomains: ["example.com"] });
		const plan = await Effect.runPromise(
			capFetch(limits, {
				urls: [
					"https://example.com/a",
					"example.com/no-scheme",
					"https://other.example/b",
					"HTTP://user:pw@Docs.Example.com:8080/c",
					"https://example.com/d",
				],
				maxCharacters: 5000,
			}),
		);
		expect(plan).toStrictEqual({
			urls: ["https://example.com/a", "HTTP://user:pw@Docs.Example.com:8080/c"],
			maxCharacters: 100,
			skipped: [
				{ url: "example.com/no-scheme", reason: "not a web address" },
				{ url: "https://other.example/b", reason: "this domain may not be fetched" },
				{ url: "https://example.com/d", reason: "over the limit of 2 pages" },
			],
		});
	});

	it("reads a page's host as a fetcher does, whatever the spelling", async () => {
		const limits = within({ allowedDomains: ["example.com"], blockedDomains: ["ads.example.com"] });
		const plan = await Effect.runPromise(
			capFetch(limits, {
				urls: [
					// The host is evil.test in each of these, though example.com is written in them.
					"https://example.com@evil.test/",
					"https://evil.test\\@example.com/",
					"https://evil.test/?example.com",
					"https://example.com.evil.test/",
					"https://notexample.com/",
					// The blocked host, with a trailing dot and in capitals.
					"https://ADS.example.com./banner",
					"https://www.example.com./ok",
				],
			}),
		);
		expect(plan.urls).toEqual(["https://www.example.com./ok"]);
		expect(plan.skipped.map((page) => page.reason)).toEqual(Array(6).fill("this domain may not be fetched"));
	});

	it("lets a model ask for less text than the limit", async () => {
		const plan = await Effect.runPromise(
			capFetch(defaultLimits, { urls: ["https://example.com/a"], maxCharacters: 300 }),
		);
		expect(plan).toStrictEqual({ urls: ["https://example.com/a"], maxCharacters: 300, skipped: [] });
	});

	it("refuses when no page is left", async () => {
		const refused = await Effect.runPromise(
			Effect.flip(
				capFetch(within({ blockedDomains: ["example.com"] }), { urls: ["https://www.example.com/", "x"] }),
			),
		);
		expect(refused.reason).toBe(
			"No page can be fetched: https://www.example.com/ (this domain may not be fetched); x (not a web address).",
		);
		expect((await Effect.runPromise(Effect.flip(capFetch(defaultLimits, { urls: [] })))).reason).toBe(
			"No page can be fetched: no address was given.",
		);
	});
});
