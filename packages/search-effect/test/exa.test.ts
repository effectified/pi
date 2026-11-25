import { Config, ConfigProvider, DateTime, Effect, Fiber, Layer, Redacted } from "effect";
import { HttpClient, HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Exa from "../src/exa.ts";
import { type SearchError, SearchProvider } from "../src/provider/index.ts";

const KEY = "exa-key-3f9a7c21";
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** One request as the test client received it. */
interface Received {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
}

/** What the test client does with a request: a response, or the failure of a connection that never answered. */
type Reply =
	| { readonly kind: "response"; readonly status: number; readonly body: string; readonly headers?: HeadersInit }
	| { readonly kind: "refused"; readonly cause: Error };

const ok = (body: string): Reply => ({ kind: "response", status: 200, body });

/** An `HttpClient` that reaches no network: it records each request and answers with `reply`. */
function recording(reply: Reply) {
	const received: Received[] = [];
	const client = HttpClient.make((request) => {
		received.push(seen(request));
		switch (reply.kind) {
			case "response":
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response(reply.body, { status: reply.status, headers: reply.headers ?? {} }),
					),
				);
			case "refused":
				return Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({ request, cause: reply.cause }),
					}),
				);
		}
	});
	return { received, client };
}

function seen(request: HttpClientRequest.HttpClientRequest): Received {
	const body =
		request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined;
	return { method: request.method, url: request.url, headers: { ...request.headers }, body };
}

/** Runs `effect` on the Exa provider over `client`, with the key given directly and the clock standing at `NOW`. */
function onExa<A, E>(
	effect: Effect.Effect<A, E, SearchProvider>,
	client: HttpClient.HttpClient,
	options: Exa.Options = {},
): Promise<A> {
	const provider = Exa.layer({ apiKey: Config.succeed(Redacted.make(KEY)), ...options }).pipe(
		Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
	);
	return Effect.runPromise(
		Effect.andThen(TestClock.setTime(NOW), effect).pipe(Effect.provide(provider), Effect.provide(TestClock.layer())),
	);
}

const search = SearchProvider.use((provider) => provider.search("effect schema"));
const failed = (reply: Reply): Promise<SearchError> => onExa(Effect.flip(search), recording(reply).client);

// Written by hand, with spacing and number forms a parser would not keep, and fields the adapter does not read.
const SEARCH_BODY = `{"requestId":"req-1",  "resolvedSearchType":"neural",
 "results":[{"id":"https://a.example/post","title":"Alpha","url":"https://a.example/post","publishedDate":"2026-01-02T00:00:00.000Z","author":"Ada","score":0.50,"highlights":["first  excerpt","second"],"image":"https://a.example/i.png","favicon":null},
  {"id":"https://b.example/","title":null,"url":"https://b.example/","author":"","highlights":[]}],
 "costDollars":{"total":5e-3},"addedLater":{"x":[1,2.0,"\\u00e9"]}}`;

const CONTENTS_BODY = JSON.stringify({
	requestId: "req-2",
	results: [{ id: "https://a.example/post", url: "https://a.example/post", title: "Alpha", text: "Page text." }],
	statuses: [
		{ id: "https://a.example/post", status: "success", source: "cached" },
		{ id: "https://gone.example/", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
		{ id: "https://odd.example/", status: "error", error: null },
	],
	costDollars: { total: 0.001 },
});

describe("the request Exa receives", () => {
	it("is POST /search with the key in x-api-key and the options as Exa's body", async () => {
		const { received, client } = recording(ok(SEARCH_BODY));
		const retrieval = await onExa(
			SearchProvider.use((provider) =>
				provider.search("effect schema", {
					maxResults: 3,
					snippetCharacters: 200,
					includeDomains: ["effect.website"],
					excludeDomains: ["spam.example"],
					publishedAfter: DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"),
					publishedBefore: DateTime.makeUnsafe("2026-06-30T12:00:00.000Z"),
				}),
			),
			client,
			{ searchType: "auto", category: "news", maxAgeHours: 24 },
		);
		const body = {
			query: "effect schema",
			type: "auto",
			category: "news",
			numResults: 3,
			includeDomains: ["effect.website"],
			excludeDomains: ["spam.example"],
			startPublishedDate: "2025-01-01T00:00:00.000Z",
			endPublishedDate: "2026-06-30T12:00:00.000Z",
			contents: { highlights: { maxCharacters: 200 }, maxAgeHours: 24 },
		};
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ method: "POST", url: "https://api.exa.ai/search", body });
		expect(received[0]?.headers).toMatchObject({
			"x-api-key": KEY,
			"content-type": "application/json",
			accept: "application/json",
		});
		// The recorded request is what was sent, without the headers that carry the key.
		expect(retrieval.request).toStrictEqual({ method: "POST", url: "https://api.exa.ai/search", body });
		expect(JSON.stringify(retrieval)).not.toContain(KEY);
	});

	it("asks for Exa's own defaults when no option is given, and sends no empty domain filter", async () => {
		const { received, client } = recording(ok(SEARCH_BODY));
		await onExa(
			SearchProvider.use((provider) => provider.search("effect", { includeDomains: [], excludeDomains: [] })),
			client,
		);
		expect(received[0]?.body).toStrictEqual({ query: "effect", contents: { highlights: true } });
	});

	it("is POST /contents with the pages and the text length for a fetch", async () => {
		const { received, client } = recording(ok(CONTENTS_BODY));
		const retrieval = await onExa(
			SearchProvider.use((provider) =>
				provider.fetch(["https://a.example/post", "https://gone.example/"], { maxCharacters: 1000 }),
			),
			client,
			{ maxAgeHours: 0 },
		);
		const body = {
			urls: ["https://a.example/post", "https://gone.example/"],
			text: { maxCharacters: 1000 },
			maxAgeHours: 0,
		};
		expect(received[0]).toMatchObject({ method: "POST", url: "https://api.exa.ai/contents", body });
		expect(received[0]?.headers).toMatchObject({ "x-api-key": KEY, "content-type": "application/json" });
		expect(retrieval.request).toStrictEqual({ method: "POST", url: "https://api.exa.ai/contents", body });
		expect(JSON.stringify(retrieval)).not.toContain(KEY);
	});

	it("goes to the configured base URL, and reads the key and the URL from Config by default", async () => {
		const { received, client } = recording(ok(SEARCH_BODY));
		const config = ConfigProvider.fromUnknown({ EXA_API_KEY: "from-config", EXA_BASE_URL: "http://proxy.test/exa/" });
		await Effect.runPromise(
			search.pipe(
				Effect.provide(Exa.layer().pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
				Effect.provide(ConfigProvider.layer(config)),
			),
		);
		expect(received[0]?.url).toBe("http://proxy.test/exa/search");
		expect(received[0]?.headers["x-api-key"]).toBe("from-config");
	});

	it("fails when the Layer is built without a key, before any request", async () => {
		const { received, client } = recording(ok(SEARCH_BODY));
		const error = await Effect.runPromise(
			Effect.flip(
				search.pipe(
					Effect.provide(Exa.layer().pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
				),
			),
		);
		expect(error._tag).toBe("ConfigError");
		expect(received).toEqual([]);
	});
});

describe("the response", () => {
	it("decodes a search to normalised hits and keeps the body byte for byte", async () => {
		const retrieval = await onExa(search, recording(ok(SEARCH_BODY)).client);
		expect(retrieval.hits).toStrictEqual([
			{
				url: "https://a.example/post",
				title: "Alpha",
				snippet: "first  excerpt\nsecond",
				publishedDate: "2026-01-02T00:00:00.000Z",
				author: "Ada",
				score: 0.5,
			},
			// A null title, an empty author and no highlights are absent fields, not empty ones.
			{ url: "https://b.example/" },
		]);
		expect(retrieval.unfetched).toStrictEqual([]);
		expect(retrieval.raw).toBe(SEARCH_BODY);
		expect(JSON.parse(retrieval.raw).addedLater).toEqual({ x: [1, 2, "é"] });
		expect(retrieval.provider).toBe("exa");
		expect(DateTime.toEpochMillis(retrieval.retrievedAt)).toBe(NOW);
	});

	it("decodes a fetch to page text, and lists the pages Exa could not read with its reason", async () => {
		const retrieval = await onExa(
			SearchProvider.use((provider) => provider.fetch(["https://a.example/post", "https://gone.example/"])),
			recording(ok(CONTENTS_BODY)).client,
		);
		expect(retrieval.hits).toStrictEqual([{ url: "https://a.example/post", title: "Alpha", text: "Page text." }]);
		expect(retrieval.unfetched).toStrictEqual([
			{ url: "https://gone.example/", reason: "CRAWL_NOT_FOUND, HTTP 404" },
			{ url: "https://odd.example/", reason: "not readable" },
		]);
		expect(retrieval.raw).toBe(CONTENTS_BODY);
	});
});

describe("a failure", () => {
	const errorBody = (error: string, tag: string) => JSON.stringify({ requestId: "req-9", error, tag });

	it("401 and 403 are SearchUnauthorized", async () => {
		const unauthorized = await failed({ kind: "response", status: 401, body: errorBody("Invalid API key", "X") });
		expect(unauthorized).toMatchObject({ _tag: "SearchUnauthorized", provider: "exa", status: 401 });
		expect(unauthorized.message).toBe("exa rejected the credentials (HTTP 401).");
		expect(await failed({ kind: "response", status: 403, body: "" })).toMatchObject({
			_tag: "SearchUnauthorized",
			status: 403,
		});
	});

	it("429 is SearchRateLimited with the hint Exa gave: seconds, a date, or none", async () => {
		const limited = (headers?: HeadersInit) =>
			failed({ kind: "response", status: 429, body: errorBody("Slow down", "RATE_LIMIT_EXCEEDED"), headers });
		const seconds = await limited({ "retry-after": "7" });
		expect(seconds).toMatchObject({ _tag: "SearchRateLimited", provider: "exa", retryAfterMillis: 7000 });
		expect(seconds.message).toBe("exa is rate limited. Retry after 7 s.");
		const date = await limited({ "retry-after": new Date(NOW + 30_000).toUTCString() });
		expect(date).toMatchObject({ _tag: "SearchRateLimited", retryAfterMillis: 30_000 });
		const none = await limited();
		expect(none._tag).toBe("SearchRateLimited");
		expect(none).not.toHaveProperty("retryAfterMillis", expect.anything());
		expect(none.message).toBe("exa is rate limited.");
		expect(await limited({ "retry-after": "soon" })).not.toHaveProperty("retryAfterMillis", expect.anything());
	});

	it("any other status is SearchProviderFailure with the status and what Exa said", async () => {
		const failure = await failed({
			kind: "response",
			status: 500,
			body: errorBody("Internal error", "INTERNAL_ERROR"),
		});
		expect(failure).toMatchObject({
			_tag: "SearchProviderFailure",
			provider: "exa",
			status: 500,
			detail: "Internal error (INTERNAL_ERROR)",
		});
		expect(failure.message).toBe("exa failed with HTTP 500: Internal error (INTERNAL_ERROR)");
		// A body that is not Exa's error shape is quoted, on one line; an empty one gives no detail.
		expect(await failed({ kind: "response", status: 502, body: "<html>\n  Bad gateway</html>" })).toMatchObject({
			_tag: "SearchProviderFailure",
			status: 502,
			detail: "<html> Bad gateway</html>",
		});
		const empty = await failed({ kind: "response", status: 503, body: "" });
		expect(empty.message).toBe("exa failed with HTTP 503.");
	});

	it("a connection that never answers is SearchTransportFailure", async () => {
		const failure = await failed({ kind: "refused", cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
		expect(failure).toMatchObject({ _tag: "SearchTransportFailure", provider: "exa" });
		expect(failure.message).toBe(
			"exa could not be reached: Transport error (POST https://api.exa.ai/search): connect ECONNREFUSED 127.0.0.1:443",
		);
	});

	it("a success whose body is not Exa's is SearchResponseInvalid", async () => {
		const notJson = await failed(ok("<html>maintenance</html>"));
		expect(notJson).toMatchObject({ _tag: "SearchResponseInvalid", provider: "exa" });
		expect(notJson.message).toMatch(/^exa answered with a response that could not be read: /);
		const wrongShape = await failed(ok(JSON.stringify({ results: [{ title: "no url" }] })));
		expect(wrongShape._tag).toBe("SearchResponseInvalid");
		expect(wrongShape.message).toContain("url");
	});

	it("is the same when the client itself fails on a status", async () => {
		const { client } = recording({ kind: "response", status: 429, body: "", headers: { "retry-after": "2" } });
		const error = await onExa(Effect.flip(search), HttpClient.filterStatusOk(client));
		expect(error).toMatchObject({ _tag: "SearchRateLimited", retryAfterMillis: 2000 });
	});

	it("never holds the key, even when Exa or the connection quotes it", async () => {
		const quoting: Reply[] = [
			{ kind: "response", status: 401, body: errorBody(`Invalid API key ${KEY}`, "INVALID_API_KEY") },
			{ kind: "response", status: 429, body: errorBody(`Key ${KEY} is over its rate`, "RATE_LIMIT_EXCEEDED") },
			{ kind: "response", status: 500, body: errorBody(`Failed for key ${KEY}`, "INTERNAL_ERROR") },
			{ kind: "response", status: 502, body: `upstream said: x-api-key ${KEY} rejected` },
			{ kind: "refused", cause: new Error(`could not send header x-api-key: ${KEY}`) },
			ok(`{"results": "${KEY}"}`),
			ok(`not json ${KEY}`),
		];
		const tags: string[] = [];
		for (const reply of quoting) {
			const error = await failed(reply);
			tags.push(error._tag);
			for (const text of [error.message, String(error), JSON.stringify(error), `${error.stack}`]) {
				expect(text, error._tag).not.toContain(KEY);
			}
		}
		expect(tags).toEqual([
			"SearchUnauthorized",
			"SearchRateLimited",
			"SearchProviderFailure",
			"SearchProviderFailure",
			"SearchTransportFailure",
			"SearchResponseInvalid",
			"SearchResponseInvalid",
		]);
		// The words around the key are kept, so the failure still says what happened.
		expect((await failed(quoting[2] as Reply)).message).toBe(
			"exa failed with HTTP 500: Failed for key <redacted> (INTERNAL_ERROR)",
		);
	});
});

describe("interruption", () => {
	it("aborts the request in flight", async () => {
		const arrived = Promise.withResolvers<AbortSignal>();
		const client = HttpClient.make((_request, _url, signal) => {
			arrived.resolve(signal);
			return Effect.never;
		});
		const signal = await onExa(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(search);
				const signal = yield* Effect.promise(() => arrived.promise);
				const before = signal.aborted;
				yield* Fiber.interrupt(fiber);
				return { before, after: signal.aborted };
			}),
			client,
		);
		expect(signal).toEqual({ before: false, after: true });
	});
});
