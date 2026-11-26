import { type EntryRecord, MemoryStorage } from "@earendil-works/pi-durable";
import { type DurableError, Harness, Registry, Storage } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { DateTime, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	Evidence,
	type FetchOptions,
	type Hit,
	type Limits,
	type Retrieval,
	type SearchError,
	type SearchOptions,
	SearchProvider,
	SearchRateLimited,
	SearchTools,
	type Unfetched,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** One call the scripted provider received. */
type Call =
	| { readonly kind: "search"; readonly query: string; readonly options: SearchOptions | undefined }
	| { readonly kind: "fetch"; readonly urls: ReadonlyArray<string>; readonly options: FetchOptions | undefined };

/** What the scripted provider answers a call with. */
interface Script {
	readonly raw: string;
	readonly hits: ReadonlyArray<Hit>;
	readonly unfetched?: ReadonlyArray<Unfetched>;
}

/** A provider that reaches nothing: it records each call and answers with `respond`, at the time of the `Clock`. */
function scripted(respond: (call: Call) => Effect.Effect<Script, SearchError>) {
	const calls: Call[] = [];
	const reply = (call: Call, path: string, body: Retrieval["request"]["body"]) =>
		Effect.gen(function* () {
			calls.push(call);
			const script = yield* respond(call);
			return {
				provider: "scripted",
				request: { method: "POST", url: `https://search.test${path}`, body },
				retrievedAt: yield* DateTime.now,
				raw: script.raw,
				hits: script.hits,
				unfetched: script.unfetched ?? [],
			};
		});
	const layer = Layer.succeed(SearchProvider, {
		search: (query, options) => reply({ kind: "search", query, options }, "/search", { query }),
		fetch: (urls, options) => reply({ kind: "fetch", urls, options }, "/fetch", { urls }),
	});
	return { calls, layer };
}

/** The tool result message of a stored entry, if it is one: what the model was given, with the details beside it. */
function toolResult(entry: EntryRecord) {
	const message = entry.model?.[0];
	return message?.role === "toolResult" ? [message] : [];
}

/** Asks the root conversation one question; gives how it settled, the tool results and the model's request count. */
const ask = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const settled = yield* root.prompt("Look it up.");
	yield* root.waitForIdle;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return {
		status: settled.status,
		results: entries.flatMap(toolResult),
		requests: yield* ScriptedModels.use((models) => models.callCount),
	};
});

/** One model turn that calls `tool`, then a final answer, on the tools within `limits` and the provider `layer`. */
function run(
	tool: string,
	args: Parameters<typeof toolCall>[1],
	limits: Partial<Limits>,
	layer: Layer.Layer<SearchProvider>,
) {
	return Effect.runPromise(
		Effect.andThen(TestClock.setTime(NOW), ask).pipe(
			Effect.provide(
				TestHarness.layer({
					extensions: [SearchTools.extension(limits)],
					responses: [toolCall(tool, args, { id: "call-1" }), answer("Done.")],
				}),
			),
			Effect.provide(layer),
			Effect.provide(TestClock.layer()),
		),
	);
}

const RAW = '{"requestId":"r-1","results":[{"url":"https://effect.website/docs","score":0.50}]}';

const HITS: ReadonlyArray<Hit> = [
	{
		url: "https://effect.website/docs",
		title: "Effect documentation",
		snippet: "Effect is a TypeScript library\nfor building   robust programs with typed errors.",
		publishedDate: "2026-01-02",
		author: "Effect",
		score: 0.5,
	},
	{ url: "https://effect.website/blog", text: "x".repeat(200) },
];

describe("web_search", () => {
	it("reaches the provider with the model's query and the options capped by the limits", async () => {
		const provider = scripted(() => Effect.succeed({ raw: RAW, hits: HITS }));
		await run(
			"web_search",
			{
				query: "effect schema",
				maxResults: 1000,
				includeDomains: ["docs.effect.website", "evil.example", "ads.effect.website"],
				excludeDomains: ["old.example"],
				publishedAfter: "2019-01-01T00:00:00.000Z",
				publishedBefore: "2030-01-01T00:00:00.000Z",
			},
			{
				maxResults: 3,
				snippetCharacters: 80,
				allowedDomains: ["effect.website"],
				blockedDomains: ["ads.effect.website"],
				publishedAfter: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
			},
			provider.layer,
		);
		expect(provider.calls).toStrictEqual([
			{
				kind: "search",
				query: "effect schema",
				options: {
					// 1,000 asked, 3 allowed.
					maxResults: 3,
					snippetCharacters: 80,
					// Only the asked domain inside the allowed one and outside the blocked one is left.
					includeDomains: ["docs.effect.website"],
					excludeDomains: ["old.example", "ads.effect.website"],
					// The fixed start is later than the asked one; no end is fixed, so the asked one stands.
					publishedAfter: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
					publishedBefore: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
				},
			},
		]);
	});

	it("asks for the default count and the allowed domains when the model names neither", async () => {
		const provider = scripted(() => Effect.succeed({ raw: RAW, hits: [] }));
		const seen = await run("web_search", { query: "effect" }, { allowedDomains: ["effect.website"] }, provider.layer);
		expect(provider.calls).toStrictEqual([
			{
				kind: "search",
				query: "effect",
				options: { maxResults: 5, snippetCharacters: 500, includeDomains: ["effect.website"] },
			},
		]);
		expect(seen.results[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "No results." }] });
	});

	it("gives the model compact text, and the host the evidence in the details", async () => {
		const provider = scripted(() => Effect.succeed({ raw: RAW, hits: HITS }));
		const seen = await run("web_search", { query: "effect schema" }, { snippetCharacters: 60 }, provider.layer);
		expect(seen.status).toBe("done");
		expect(seen.results).toHaveLength(1);
		expect(seen.results[0]).toMatchObject({
			role: "toolResult",
			toolName: "web_search",
			isError: false,
			content: [
				{
					type: "text",
					text: [
						"1. Effect documentation",
						"   https://effect.website/docs",
						"   2026-01-02 · Effect",
						"   Effect is a TypeScript library for building robust programs ...",
						"",
						"2. (no title)",
						"   https://effect.website/blog",
						`   ${"x".repeat(60)}...`,
					].join("\n"),
				},
			],
			// What the model never reads: the request, the body as it came, the provider, and when (the TestClock's time).
			details: {
				provider: "scripted",
				request: { method: "POST", url: "https://search.test/search", body: { query: "effect schema" } },
				retrievedAt: "2026-11-25T12:00:00.000Z",
				raw: RAW,
			},
		});
		// The raw response is not in what the model reads.
		expect(JSON.stringify(seen.results[0]?.content)).not.toContain("requestId");
	});

	it("stores details a host decodes back to the evidence", async () => {
		const provider = scripted(() => Effect.succeed({ raw: RAW, hits: HITS }));
		const seen = await run("web_search", { query: "effect" }, {}, provider.layer);
		const evidence = await Effect.runPromise(Evidence.fromJson(seen.results[0]?.details));
		expect(evidence.raw).toBe(RAW);
		expect(DateTime.toEpochMillis(evidence.retrievedAt)).toBe(NOW);
		expect(evidence.provider).toBe("scripted");
	});

	it("turns a provider failure into an error result the model reads, and the run goes on", async () => {
		const provider = scripted(() =>
			Effect.fail(new SearchRateLimited({ provider: "scripted", retryAfterMillis: 7000 })),
		);
		const seen = await run("web_search", { query: "effect" }, {}, provider.layer);
		expect(provider.calls).toHaveLength(1);
		expect(seen.results).toHaveLength(1);
		expect(seen.results[0]).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "scripted is rate limited. Retry after 7 s." }],
		});
		expect(seen.results[0]).not.toHaveProperty("details");
		// The model was asked again with that result, and answered: the task did not fail.
		expect(seen).toMatchObject({ status: "done", requests: 2 });
	});

	it("refuses a search no limit lets through, without asking the provider", async () => {
		const provider = scripted(() => Effect.succeed({ raw: RAW, hits: HITS }));
		const outside = await run(
			"web_search",
			{ query: "effect", includeDomains: ["evil.example"] },
			{ allowedDomains: ["effect.website"] },
			provider.layer,
		);
		expect(outside.results[0]).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "None of these domains may be searched: evil.example." }],
		});
		const noDates = await run(
			"web_search",
			{ query: "effect", publishedAfter: "2025-06-01T00:00:00.000Z" },
			{ publishedBefore: DateTime.makeUnsafe("2025-01-01T00:00:00.000Z") },
			provider.layer,
		);
		expect(noDates.results[0]).toMatchObject({
			isError: true,
			content: [
				{
					type: "text",
					text: "No page is published after 2025-06-01T00:00:00.000Z and before 2025-01-01T00:00:00.000Z.",
				},
			],
		});
		expect(provider.calls).toEqual([]);
		expect([outside.status, noDates.status]).toEqual(["done", "done"]);
	});
});

describe("web_fetch", () => {
	const page = (text: string): Script => ({
		raw: '{"results":[{"url":"https://effect.website/docs"}]}',
		hits: [{ url: "https://effect.website/docs", title: "Docs", text }],
		unfetched: [{ url: "https://effect.website/gone", reason: "CRAWL_NOT_FOUND, HTTP 404" }],
	});

	it("reads the permitted pages up to the limit, and cuts the text with a note", async () => {
		const provider = scripted(() => Effect.succeed(page("a".repeat(50))));
		const seen = await run(
			"web_fetch",
			{
				urls: [
					"https://effect.website/docs",
					"https://ads.effect.website/track",
					"ftp://effect.website/file",
					"https://effect.website/gone",
					"https://effect.website/third",
				],
				maxCharacters: 1_000_000,
			},
			{ maxUrls: 2, maxCharacters: 20, blockedDomains: ["ads.effect.website"] },
			provider.layer,
		);
		expect(provider.calls).toStrictEqual([
			{
				kind: "fetch",
				urls: ["https://effect.website/docs", "https://effect.website/gone"],
				options: { maxCharacters: 20 },
			},
		]);
		expect(seen.results[0]).toMatchObject({
			toolName: "web_fetch",
			isError: false,
			content: [
				{
					type: "text",
					text: [
						"# Docs",
						"https://effect.website/docs",
						"",
						"a".repeat(20),
						"",
						"[Cut at 20 characters.]",
						"",
						"---",
						"",
						"Not fetched: https://effect.website/gone (CRAWL_NOT_FOUND, HTTP 404)",
						"Not fetched: https://ads.effect.website/track (this domain may not be fetched)",
						"Not fetched: ftp://effect.website/file (not a web address)",
						"Not fetched: https://effect.website/third (over the limit of 2 pages)",
					].join("\n"),
				},
			],
			details: {
				provider: "scripted",
				request: {
					method: "POST",
					url: "https://search.test/fetch",
					body: { urls: ["https://effect.website/docs", "https://effect.website/gone"] },
				},
				retrievedAt: "2026-11-25T12:00:00.000Z",
				raw: '{"results":[{"url":"https://effect.website/docs"}]}',
			},
		});
	});

	it("shows a short page whole, without a note, and lets the model ask for less than the limit", async () => {
		const provider = scripted(() => Effect.succeed({ ...page("Short page."), unfetched: [] }));
		const seen = await run(
			"web_fetch",
			{ urls: ["https://effect.website/docs"], maxCharacters: 40 },
			{},
			provider.layer,
		);
		expect(provider.calls).toMatchObject([{ options: { maxCharacters: 40 } }]);
		expect(seen.results[0]).toMatchObject({
			content: [{ type: "text", text: "# Docs\nhttps://effect.website/docs\n\nShort page." }],
		});
	});

	it("refuses a fetch with no permitted page, without asking the provider", async () => {
		const provider = scripted(() => Effect.succeed(page("never read")));
		const seen = await run(
			"web_fetch",
			{ urls: ["https://evil.example/a"] },
			{ allowedDomains: ["effect.website"] },
			provider.layer,
		);
		expect(provider.calls).toEqual([]);
		expect(seen.results[0]).toMatchObject({
			isError: true,
			content: [
				{ type: "text", text: "No page can be fetched: https://evil.example/a (this domain may not be fetched)." },
			],
		});
		expect(seen).toMatchObject({ status: "done", requests: 2 });
	});
});

describe("replay", () => {
	/** Memory that outlives its harness, so a second harness reopens what the first left. */
	class KeptStorage extends MemoryStorage {
		override async close(): Promise<void> {}
	}

	it("asks the provider again for a call a close cut off, and stores the evidence of that second answer", async () => {
		const storage = Storage.custom(new KeptStorage());
		const started = Promise.withResolvers<void>();
		// The first harness: the provider never answers, and the harness closes while the call waits.
		const hanging = scripted(() =>
			Effect.andThen(
				Effect.sync(() => started.resolve()),
				Effect.never,
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const root = yield* TestHarness.root;
				yield* root.submit({ type: "input", content: "Look it up.", requestId: "ask" });
				yield* Effect.promise(() => started.promise);
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [SearchTools.extension()],
						responses: [toolCall("web_search", { query: "effect" }, { id: "call-1" })],
						storage,
					}),
				),
				Effect.provide(hanging.layer),
				Effect.provide(TestClock.layer()),
			),
		);
		// The second harness, an hour later: the same call runs again.
		const answering = scripted(() => Effect.succeed({ raw: RAW, hits: HITS }));
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Harness.waitForIdle;
				const root = yield* TestHarness.root;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return entries.flatMap(toolResult);
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [SearchTools.extension()], responses: [answer("Done.")], storage }),
				),
				Effect.provide(answering.layer),
				Effect.provide(Layer.effectDiscard(TestClock.setTime(NOW + 3_600_000))),
				Effect.provide(TestClock.layer()),
			),
		);
		expect(hanging.calls).toHaveLength(1);
		expect(answering.calls).toStrictEqual(hanging.calls);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			isError: false,
			details: { provider: "scripted", raw: RAW, retrievedAt: "2026-11-25T13:00:00.000Z" },
		});
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the registry", () => {
	it("requires a SearchProvider: without one it does not compile", () => {
		const registry = Registry.layer([SearchTools.extension()]);
		const needs: Equal<Layer.Services<typeof registry>, SearchProvider> = true;
		// @ts-expect-error The tools need a SearchProvider, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, Layer.Error<typeof registry>> = registry;
		const provided: Layer.Layer<Registry.Registry, Layer.Error<typeof registry>> = registry.pipe(
			Layer.provide(scripted(() => Effect.succeed({ raw: RAW, hits: [] })).layer),
		);
		// @ts-expect-error The same holds for a harness built on the tools.
		const harness: Layer.Layer<TestHarness.Provided, DurableError | Layer.Error<typeof registry>> = TestHarness.layer(
			{
				extensions: [SearchTools.extension()],
			},
		);
		expect(needs).toBe(true);
		expect([unprovided, provided, harness].every(Layer.isLayer)).toBe(true);
	});

	it("installs both tools under the extension `search`, replay-safe", async () => {
		const tools = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.succeed(registry.snapshot().tools())).pipe(
				Effect.provide(Registry.layer([SearchTools.extension()])),
				Effect.provide(scripted(() => Effect.succeed({ raw: RAW, hits: [] })).layer),
			),
		);
		expect(tools.map(({ extension, tool }) => [extension.name, tool.name, tool.replay])).toEqual([
			["search", "web_search", "safe"],
			["search", "web_fetch", "safe"],
		]);
		// What a model is told about each argument: only the query and the addresses are required.
		const optional = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
		const count = { type: "integer", exclusiveMinimum: 0 };
		const list = { type: "array", items: { type: "string" } };
		expect(tools.map(({ tool }) => tool.parameters)).toMatchObject([
			{
				type: "object",
				properties: {
					query: { type: "string", description: "What to look for, in plain words." },
					maxResults: optional({ ...count, description: "How many results to return." }),
					includeDomains: optional({
						...list,
						description: "Only results from these domains, such as example.com.",
					}),
					excludeDomains: optional({ ...list, description: "No results from these domains." }),
					publishedAfter: optional({
						type: "string",
						description: "Only pages published after this ISO 8601 date.",
					}),
					publishedBefore: optional({
						type: "string",
						description: "Only pages published before this ISO 8601 date.",
					}),
				},
				required: ["query"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					urls: { ...list, description: "The addresses of the pages to read, each with https://." },
					maxCharacters: optional({ ...count, description: "How much of each page's text to return." }),
				},
				required: ["urls"],
				additionalProperties: false,
			},
		]);
	});
});
