// Each example of the README, run: against a canned HttpClient or a scripted provider, never the network.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { Harness, Registry } from "@gunta/pi-durable-effect";
import { answer, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Config, ConfigProvider, DateTime, Effect, Fiber, Layer, Option, Redacted, Stream } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Exa from "../src/exa.ts";
import { Evidence, type SearchOptions, SearchProvider, SearchRateLimited, SearchTools } from "../src/index.ts";
import * as Acme from "./example-provider.ts";

const SEARCH_BODY = JSON.stringify({
	requestId: "req-1",
	results: [
		{
			id: "https://effect.website/docs/schema",
			url: "https://effect.website/docs/schema",
			title: "Schema",
			highlights: ["Schema describes the shape of data."],
		},
	],
});

const CONTENTS_BODY = JSON.stringify({
	requestId: "req-2",
	results: [
		{ id: "https://effect.website/docs/schema", url: "https://effect.website/docs/schema", text: "Page text." },
	],
});

/** An `HttpClient` that answers each path with a canned body and records what it was asked. */
function canned(bodies: Readonly<Record<string, string>>) {
	const requests: HttpClientRequest.HttpClientRequest[] = [];
	const client = HttpClient.make((request, url) => {
		requests.push(request);
		const body = bodies[url.pathname];
		return Effect.succeed(
			HttpClientResponse.fromWeb(request, new Response(body ?? "", { status: body === undefined ? 404 : 200 })),
		);
	});
	return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

const key = (name: string, value: string) => ConfigProvider.layer(ConfigProvider.fromUnknown({ [name]: value }));

describe("The provider port", () => {
	it("searches and fetches through Exa without a harness", async () => {
		const program = Effect.gen(function* () {
			const provider = yield* SearchProvider;
			const found = yield* provider.search("effect schema", { maxResults: 3, includeDomains: ["effect.website"] });
			const pages = yield* provider.fetch([found.hits[0]?.url ?? ""], { maxCharacters: 5000 });
			return { titles: found.hits.map((hit) => hit.title), text: pages.hits[0]?.text, raw: found.raw };
		});
		const http = canned({ "/search": SEARCH_BODY, "/contents": CONTENTS_BODY });
		const live = Exa.layer().pipe(Layer.provide(http.layer));
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(live), Effect.provide(key("EXA_API_KEY", "k"))),
		);
		expect(result).toEqual({ titles: ["Schema"], text: "Page text.", raw: SEARCH_BODY });
		expect(http.requests.map((request) => request.url)).toEqual([
			"https://api.exa.ai/search",
			"https://api.exa.ai/contents",
		]);
		// As the README composes it: the Layer needs nothing more once an HttpClient is provided.
		const withFetch = Exa.layer().pipe(Layer.provide(FetchHttpClient.layer));
		const needsNothing: Layer.Layer<SearchProvider, Config.ConfigError> = withFetch;
		expect(Layer.isLayer(needsNothing)).toBe(true);
	});

	it("handles a rate limit by its tag, waiting as long as the provider said", async () => {
		let calls = 0;
		// Rate limited once, with a hint of seven seconds; then it answers.
		const once = Effect.suspend(() => {
			calls += 1;
			return calls === 1
				? Effect.fail(new SearchRateLimited({ provider: "exa", retryAfterMillis: 7000 }))
				: Effect.succeed({
						provider: "exa",
						request: { method: "POST", url: "https://api.exa.ai/search", body: {} },
						retrievedAt: DateTime.makeUnsafe(0),
						raw: "{}",
						hits: [],
						unfetched: [],
					});
		});
		const limited = Layer.succeed(SearchProvider, { search: () => once, fetch: () => once });
		const waited = await Effect.runPromise(
			Effect.gen(function* () {
				const provider = yield* SearchProvider;
				const patient = provider
					.search("effect")
					.pipe(
						Effect.catchTag("SearchRateLimited", (error) =>
							Effect.andThen(Effect.sleep(error.retryAfterMillis ?? 1000), provider.search("effect")),
						),
					);
				const fiber = yield* Effect.forkChild(patient);
				yield* TestClock.adjust(6999);
				const early = calls;
				yield* TestClock.adjust(1);
				return { early, retrieval: yield* Fiber.join(fiber) };
			}).pipe(Effect.provide(limited), Effect.provide(TestClock.layer())),
		);
		expect(waited.early).toBe(1);
		expect(calls).toBe(2);
		expect(waited.retrieval.provider).toBe("exa");
	});
});

describe("The Exa provider", () => {
	it("takes the key and the base URL as Config, and Exa's fixed settings as options", async () => {
		const keyFromYourVault = "vault-key";
		const exa = Exa.layer({
			apiKey: Config.succeed(Redacted.make(keyFromYourVault)),
			baseUrl: Config.succeed("https://exa.proxy.internal"),
			searchType: "auto",
			maxAgeHours: 24,
		});
		const http = canned({ "/search": SEARCH_BODY });
		const retrieval = await Effect.runPromise(
			SearchProvider.use((provider) => provider.search("effect")).pipe(
				Effect.provide(exa.pipe(Layer.provide(http.layer))),
			),
		);
		expect(http.requests[0]?.headers["x-api-key"]).toBe("vault-key");
		expect(retrieval.request).toEqual({
			method: "POST",
			url: "https://exa.proxy.internal/search",
			body: { query: "effect", type: "auto", contents: { highlights: true, maxAgeHours: 24 } },
		});
	});
});

/** The tool result messages of stored entries: what the README's host example reads. */
function toolResults(entries: ReadonlyArray<EntryRecord>) {
	return entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role === "toolResult"));
}

describe("The tools", () => {
	it("give the model text and the host the evidence of every search and fetch", async () => {
		const evidence = Effect.gen(function* () {
			const root = yield* Harness.root;
			const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
			return yield* Effect.forEach(
				entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role === "toolResult")),
				(result) => Effect.option(Evidence.fromJson(result.details)),
			);
		});
		const http = canned({ "/search": SEARCH_BODY, "/contents": CONTENTS_BODY });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("What is Schema?");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { read: toolResults(entries).map((result) => result.content), evidence: yield* evidence };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [SearchTools.extension({ maxResults: 5, blockedDomains: ["example.org"] })],
						responses: [
							toolCall("web_search", { query: "effect schema", maxResults: 50 }),
							toolCall("web_fetch", { urls: ["https://effect.website/docs/schema", "https://example.org/x"] }),
							answer("Schema describes the shape of data."),
						],
					}),
				),
				Effect.provide(Exa.layer().pipe(Layer.provide(http.layer))),
				Effect.provide(key("EXA_API_KEY", "k")),
			),
		);
		expect(seen.read).toEqual([
			[
				{
					type: "text",
					text: "1. Schema\n   https://effect.website/docs/schema\n   Schema describes the shape of data.",
				},
			],
			[
				{
					type: "text",
					text: [
						"# (no title)\nhttps://effect.website/docs/schema\n\nPage text.",
						"Not fetched: https://example.org/x (this domain may not be fetched)",
					].join("\n\n---\n\n"),
				},
			],
		]);
		const [searched, fetched] = seen.evidence.map(Option.getOrThrow);
		expect(searched?.raw).toBe(SEARCH_BODY);
		expect(searched?.request.body).toEqual({
			query: "effect schema",
			numResults: 5,
			excludeDomains: ["example.org"],
			contents: { highlights: { maxCharacters: 500 } },
		});
		expect(fetched?.raw).toBe(CONTENTS_BODY);
		expect(fetched?.request.body).toEqual({
			urls: ["https://effect.website/docs/schema"],
			text: { maxCharacters: 10_000 },
		});
	});

	it("make a registry that needs nothing more once a provider and an HttpClient are provided", () => {
		const registry = Registry.layer([SearchTools.extension({ maxResults: 5, blockedDomains: ["example.org"] })]).pipe(
			Layer.provide(Exa.layer()),
			Layer.provide(FetchHttpClient.layer),
		);
		const closed: Layer.Layer<Registry.Registry, Layer.Error<typeof registry>> = registry;
		expect(Layer.isLayer(closed)).toBe(true);
	});
});

describe("Limits", () => {
	it("fix what a model can ask for when the tools are made", async () => {
		const tools = SearchTools.extension({
			maxResults: 5,
			allowedDomains: ["patents.google.com", "epo.org"],
			publishedBefore: DateTime.makeUnsafe("2024-03-01T00:00:00Z"),
		});
		const asked: Array<SearchOptions | undefined> = [];
		const provider = Layer.succeed(SearchProvider, {
			search: (_query, options) => {
				asked.push(options);
				return Effect.fail(new SearchRateLimited({ provider: "none" }));
			},
			fetch: () => Effect.fail(new SearchRateLimited({ provider: "none" })),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Find prior art.");
				yield* root.waitForIdle;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [tools],
						responses: [
							toolCall("web_search", {
								query: "heat pump",
								maxResults: 1000,
								publishedBefore: "2025-01-01T00:00:00Z",
							}),
							answer("Nothing found."),
						],
					}),
				),
				Effect.provide(provider),
			),
		);
		expect(asked).toStrictEqual([
			{
				maxResults: 5,
				snippetCharacters: 500,
				includeDomains: ["patents.google.com", "epo.org"],
				publishedBefore: DateTime.makeUnsafe("2024-03-01T00:00:00Z"),
			},
		]);
	});
});

describe("Writing another provider", () => {
	const ITEMS = '{"items":[{"link":"https://a.example/","name":"Alpha","excerpt":"First."}],"took":3}';

	/** Runs `effect` on the example provider over a client that answers every request with `status` and `body`. */
	function onAcme<A, E>(effect: Effect.Effect<A, E, SearchProvider>, status: number, body: string) {
		const requests: HttpClientRequest.HttpClientRequest[] = [];
		const client = HttpClient.make((request) => {
			requests.push(request);
			return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
		});
		const layer = Acme.layer().pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
		const ran = Effect.runPromise(
			Effect.andThen(TestClock.setTime(86_400_000), effect).pipe(
				Effect.provide(layer),
				Effect.provide(key("ACME_API_KEY", "acme-key")),
				Effect.provide(TestClock.layer()),
			),
		);
		return { requests, ran };
	}

	it("is one file that gives the port: hits, the raw body, the request without the key, the time", async () => {
		const { requests, ran } = onAcme(
			SearchProvider.use((provider) => provider.search("alpha & beta", { maxResults: 2 })),
			200,
			ITEMS,
		);
		const retrieval = await ran;
		expect(retrieval).toStrictEqual({
			provider: "acme",
			request: { method: "GET", url: "https://api.acme.test/v1/search?q=alpha%20%26%20beta&n=2", body: null },
			retrievedAt: DateTime.makeUnsafe(86_400_000),
			raw: ITEMS,
			hits: [{ url: "https://a.example/", title: "Alpha", snippet: "First." }],
			unfetched: [],
		});
		expect(requests[0]?.headers.authorization).toBe("Bearer acme-key");
		expect(JSON.stringify(retrieval)).not.toContain("acme-key");
	});

	it("fails only with the port's errors", async () => {
		const search = Effect.flip(SearchProvider.use((provider) => provider.search("alpha")));
		const fetch = Effect.flip(SearchProvider.use((provider) => provider.fetch(["https://a.example/"])));
		expect((await onAcme(search, 429, "").ran)._tag).toBe("SearchRateLimited");
		expect(await onAcme(search, 401, "").ran).toMatchObject({ _tag: "SearchUnauthorized", status: 401 });
		expect(await onAcme(fetch, 500, "").ran).toMatchObject({ _tag: "SearchProviderFailure", status: 500 });
		expect((await onAcme(search, 200, "<html>").ran)._tag).toBe("SearchResponseInvalid");
	});
});
