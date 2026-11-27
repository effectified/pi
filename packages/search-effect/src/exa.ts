// The Exa provider: the search port on Exa's HTTP API (`POST /search`, `POST /contents`) through Effect's
// `HttpClient`. A provider is one file like this one: it exports `layer`, which gives `SearchProvider`.

import {
	Array as Arr,
	Config,
	DateTime,
	Effect,
	Layer,
	Number as Num,
	Option,
	pipe,
	Predicate,
	Redacted,
	Schema,
	String as Str,
} from "effect";
import { Headers, HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http";
import {
	type FetchOptions,
	type Hit,
	ProviderName,
	type Retrieval,
	type SearchError,
	type SearchOptions,
	SearchProvider,
	SearchProviderFailure,
	type SearchProviderService,
	SearchRateLimited,
	SearchResponseInvalid,
	SearchTransportFailure,
	SearchUnauthorized,
	Unfetched,
} from "./provider/index.ts";

/** What `layer` takes. Everything here is fixed for the provider's life; nothing of it comes from a caller. */
export interface Options {
	/** The API key, sent as `x-api-key` and nowhere else. Default: `Config.Redacted("EXA_API_KEY")`. */
	readonly apiKey?: Config.Config<Redacted.Redacted>;
	/** Where Exa's API is, for a proxy or a test server. Default: `EXA_BASE_URL`, else `https://api.exa.ai`. */
	readonly baseUrl?: Config.Config<string>;
	/** Exa's search `type` for every search, such as `auto`, `lite` or `deep`: it decides cost. Default: Exa's. */
	readonly searchType?: string;
	/** Exa's `category` for every search, such as `news` or `publication`. Default: none. */
	readonly category?: string;
	/** How old stored page content may be, in hours: `0` reads every page live, `-1` never does. Default: Exa's. */
	readonly maxAgeHours?: number;
}

/** The provider's name in results and errors. */
export const name: ProviderName = ProviderName.make("exa");

/**
 * The search port on Exa. Building it reads the configuration, so a missing key fails here and not at the first
 * call. A call sends one request and does not retry; interrupting it aborts the request. Each call is a span,
 * `Exa.search` or `Exa.fetch`. Nothing is cached: each answer is evidence of its own call.
 */
export function layer(options: Options = {}): Layer.Layer<SearchProvider, Config.ConfigError, HttpClient.HttpClient> {
	return Layer.effect(SearchProvider, make(options));
}

const DEFAULT_BASE_URL = "https://api.exa.ai";

/** The provider: its configuration read once, its calls on the `HttpClient` of the context it is built in. */
const make = Effect.fn("Exa.make")(function* (options: Options) {
	const apiKey = yield* options.apiKey ?? Config.Redacted("EXA_API_KEY");
	const configured = yield* options.baseUrl ?? Config.withDefault(Config.String("EXA_BASE_URL"), DEFAULT_BASE_URL);
	const client = yield* HttpClient.HttpClient;
	const post = poster(client, apiKey, pipe(configured, Str.replace(/\/+$/, "")));
	const service: SearchProviderService = {
		search: Effect.fn("Exa.search")(function* (query: string, asked: SearchOptions = {}) {
			return yield* post("/search", searchBody(query, asked, options));
		}),
		fetch: Effect.fn("Exa.fetch")(function* (urls: ReadonlyArray<string>, asked: FetchOptions = {}) {
			return yield* post("/contents", contentsBody(urls, asked, options));
		}),
	};
	return service;
});

/** One call: the request with the key, the response classified, the body kept as it came and normalised. */
function poster(
	client: HttpClient.HttpClient,
	apiKey: Redacted.Redacted,
	baseUrl: string,
): (path: string, body: Schema.JsonObject) => Effect.Effect<Retrieval, SearchError> {
	const secret = Redacted.value(apiKey);
	// Exa may quote the key it was sent in an error body: nothing that leaves this file may hold it.
	const scrub = (text: string) => (secret === "" ? text : pipe(text, Str.replaceAll(secret, "<redacted>")));
	const unreachable = (error: HttpClientError.HttpClientError) =>
		SearchTransportFailure.make({ provider: name, detail: scrub(transportDetail(error)) });
	// Untraced: the span of the port's call (`Exa.search`, `Exa.fetch`) covers it.
	return Effect.fnUntraced(function* (path: string, body: Schema.JsonObject) {
		const url = `${baseUrl}${path}`;
		const request = HttpClientRequest.post(url).pipe(
			HttpClientRequest.setHeader("x-api-key", secret),
			HttpClientRequest.acceptJson,
			HttpClientRequest.bodyJsonUnsafe(body),
		);
		const response = yield* client.execute(request).pipe(
			// A client that fails on a status (`HttpClient.filterStatusOk`) still holds the response to classify.
			Effect.catch((error) =>
				error.response === undefined ? Effect.fail(unreachable(error)) : Effect.succeed(error.response),
			),
		);
		const raw = yield* Effect.mapError(response.text, unreachable);
		const retrievedAt = yield* DateTime.now;
		if (response.status < 200 || response.status >= 300) return yield* failure(response, scrub(raw), retrievedAt);
		// The HTTP boundary: Exa's body, decoded with the schema of what this file reads of it.
		const decoded = yield* Effect.mapError(decodeResponse(raw), (error) =>
			SearchResponseInvalid.make({ provider: name, detail: brief(scrub(error.message)) }),
		);
		const failed = Arr.filter(decoded.statuses ?? [], (status) => status.status === "error");
		const unfetched = Arr.map(failed, toUnfetched);
		return {
			provider: name,
			request: { method: "POST", url, body },
			retrievedAt,
			raw,
			hits: Arr.map(decoded.results, toHit),
			unfetched,
		};
	});
}

/** The body of `POST /search`. Snippets are Exa's highlights: excerpts chosen for the query. */
function searchBody(query: string, asked: SearchOptions, options: Options): Schema.JsonObject {
	return {
		query,
		...(options.searchType === undefined ? {} : { type: options.searchType }),
		...(options.category === undefined ? {} : { category: options.category }),
		...(asked.maxResults === undefined ? {} : { numResults: asked.maxResults }),
		// An empty list is no filter: Exa would read `[]` as one.
		...(asked.includeDomains === undefined || Arr.isReadonlyArrayEmpty(asked.includeDomains)
			? {}
			: { includeDomains: asked.includeDomains }),
		...(asked.excludeDomains === undefined || Arr.isReadonlyArrayEmpty(asked.excludeDomains)
			? {}
			: { excludeDomains: asked.excludeDomains }),
		...(asked.publishedAfter === undefined ? {} : { startPublishedDate: DateTime.formatIso(asked.publishedAfter) }),
		...(asked.publishedBefore === undefined ? {} : { endPublishedDate: DateTime.formatIso(asked.publishedBefore) }),
		contents: {
			highlights: asked.snippetCharacters === undefined ? true : { maxCharacters: asked.snippetCharacters },
			...(options.maxAgeHours === undefined ? {} : { maxAgeHours: options.maxAgeHours }),
		},
	};
}

/** The body of `POST /contents`: the pages' text. */
function contentsBody(urls: ReadonlyArray<string>, asked: FetchOptions, options: Options): Schema.JsonObject {
	return {
		urls,
		text: asked.maxCharacters === undefined ? true : { maxCharacters: asked.maxCharacters },
		...(options.maxAgeHours === undefined ? {} : { maxAgeHours: options.maxAgeHours }),
	};
}

/** What a request that got no readable response failed with: Effect's summary, and the cause's own words. */
function transportDetail(error: HttpClientError.HttpClientError): string {
	const cause = error.reason.cause;
	return Predicate.isError(cause) && cause.message !== "" ? `${error.message}: ${cause.message}` : error.message;
}

/** The port's error for a response outside 2xx, by Exa's documented statuses. `body` is already scrubbed. */
function failure(response: HttpClientResponse.HttpClientResponse, body: string, now: DateTime.Utc): SearchError {
	const status = response.status;
	if (status === 429) {
		return SearchRateLimited.make({
			provider: name,
			retryAfterMillis: Option.getOrUndefined(retryAfterMillis(response.headers, now)),
		});
	}
	// 401: no key or a wrong one. 403: the key may not use the feature, or policy blocked the request.
	if (status === 401 || status === 403) return SearchUnauthorized.make({ provider: name, status });
	return SearchProviderFailure.make({ provider: name, status, detail: Option.getOrUndefined(said(body)) });
}

/** `Retry-After` as milliseconds from `now`: Exa documents seconds; HTTP also allows a date. */
function retryAfterMillis(headers: Headers.Headers, now: DateTime.Utc): Option.Option<number> {
	return Option.flatMap(Headers.get(headers, "retry-after"), (value) =>
		Option.match(Option.filter(Num.parse(value), Number.isFinite), {
			onSome: (seconds) => Option.some(Math.max(0, seconds * 1000)),
			onNone: () =>
				Option.map(DateTime.make(value), (at) =>
					Math.max(0, DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)),
				),
		}),
	);
}

/** Exa's error body, `{ requestId, error, tag }`. A decode boundary: wire input, read leniently. */
const ErrorBody = Schema.fromJsonString(
	Schema.Struct({ error: Schema.optional(Schema.String), tag: Schema.optional(Schema.String) }),
);

/** What Exa said went wrong: its message and tag, else the start of whatever it sent; none for an empty body. */
function said(body: string): Option.Option<string> {
	const text = Option.match(Schema.decodeOption(ErrorBody)(body), {
		onNone: () => body,
		onSome: ({ error, tag }) => (error === undefined ? body : tag === undefined ? error : `${error} (${tag})`),
	});
	return Str.isEmpty(Str.trim(text)) ? Option.none() : Option.some(brief(text));
}

/** `text` on one line, cut to what an error message should carry. */
function brief(text: string): string {
	const line = pipe(text, Str.replace(/\s+/g, " "), Str.trim);
	return line.length > MAX_DETAIL ? `${pipe(line, Str.slice(0, MAX_DETAIL))}...` : line;
}

const MAX_DETAIL = 300;

/**
 * The response of both endpoints, as far as this file reads it. A decode boundary: every field but `url` may be
 * absent or `null`, and fields Exa adds are ignored (they stay in the raw body).
 */
const ExaResult = Schema.Struct({
	url: Schema.String,
	title: Schema.optional(Schema.NullOr(Schema.String)),
	publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
	author: Schema.optional(Schema.NullOr(Schema.String)),
	score: Schema.optional(Schema.NullOr(Schema.Finite)),
	text: Schema.optional(Schema.NullOr(Schema.String)),
	highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

/** How Exa fared with one URL of `POST /contents`: `id` is the URL asked for. */
const ExaStatus = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	error: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				tag: Schema.optional(Schema.NullOr(Schema.String)),
				httpStatusCode: Schema.optional(Schema.NullOr(Schema.Finite)),
			}),
		),
	),
});

const decodeResponse = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			results: Schema.Array(ExaResult),
			statuses: Schema.optional(Schema.NullOr(Schema.Array(ExaStatus))),
		}),
	),
);

/** A hit of Exa's in the port's shape: empty and `null` fields are absent, highlights become the snippet. */
function toHit(result: typeof ExaResult.Type): Hit {
	const snippet = Arr.join(result.highlights ?? [], "\n");
	return {
		url: result.url,
		...(present(result.title) ? { title: result.title } : {}),
		...(snippet === "" ? {} : { snippet }),
		...(present(result.text) ? { text: result.text } : {}),
		...(present(result.publishedDate) ? { publishedDate: result.publishedDate } : {}),
		...(present(result.author) ? { author: result.author } : {}),
		...(result.score === undefined || result.score === null ? {} : { score: result.score }),
	};
}

/** Whether Exa gave the field a value: it writes a missing title or author as `null` or as an empty string. */
function present(value: string | null | undefined): value is string {
	return value !== undefined && value !== null && value !== "";
}

/** A page Exa could not read: its tag, and the page's own HTTP status when Exa got one. */
function toUnfetched(status: typeof ExaStatus.Type): Unfetched {
	const tag = status.error?.tag ?? undefined;
	const code = status.error?.httpStatusCode ?? undefined;
	const parts = Arr.filter([tag, code === undefined ? undefined : `HTTP ${code}`], Predicate.isNotUndefined);
	const reason = Arr.join(parts, ", ");
	return Unfetched.make({ url: status.id, reason: reason === "" ? "not readable" : reason });
}
