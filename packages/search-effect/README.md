# @effectified/pi-search

Web search and page fetch for Pi Durable agents, in Effect 4.1:

- A **provider port**, `SearchProvider`: `search` and `fetch` as Effects with typed errors. Every result keeps the
  provider's response body exactly as it came, the request without credentials, and the retrieval time, so a product
  can store what a conclusion was based on.
- An **Exa provider**, on Effect's `HttpClient`. No client library.
- Two **tools**, `web_search` and `web_fetch`, as an extension for
  [`@effectified/pi-durable`](../durable-effect/README.md). The model reads compact text; the host finds the evidence
  in the tool result's details. A product fixes limits the model cannot exceed.

The port needs no harness: `@effectified/pi-search/provider` imports only `effect`.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install $R/effectified-pi-search-0.1.0.tgz $R/effectified-pi-durable-0.1.0.tgz @earendil-works/pi-durable effect
```

| Import | Holds |
|---|---|
| `@effectified/pi-search` | The port, the limits and the tools |
| `@effectified/pi-search/provider` | The port alone: `SearchProvider`, its options, results and errors |
| `@effectified/pi-search/exa` | The Exa provider |

## The provider port

```ts
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Exa from "@effectified/pi-search/exa";
import { SearchProvider } from "@effectified/pi-search/provider";

const program = Effect.gen(function* () {
	const provider = yield* SearchProvider;
	const found = yield* provider.search("effect schema", { maxResults: 3, includeDomains: ["effect.website"] });
	const pages = yield* provider.fetch([found.hits[0].url], { maxCharacters: 5000 });
	return { titles: found.hits.map((hit) => hit.title), text: pages.hits[0].text, raw: found.raw };
});

// EXA_API_KEY comes from the ConfigProvider: the environment by default.
const live = Exa.layer().pipe(Layer.provide(FetchHttpClient.layer));
Effect.runPromise(Effect.provide(program, live));
```

Both calls give a `Retrieval`:

| Field | |
|---|---|
| `hits` | Pages in one shape for every provider: `url`, and when the provider gave them `title`, `snippet` (a search), `text` (a fetch), `publishedDate`, `author`, `score` |
| `unfetched` | Pages a fetch asked for and the provider could not read: `url`, `reason` |
| `raw` | The response body as the provider sent it: the JSON text itself, never parsed and written again |
| `request` | `method`, `url` and `body` as sent. No headers: they carry the key |
| `provider`, `retrievedAt` | The provider's name, and when the response had arrived, on Effect's `Clock` |

`Retrieval`, `Hit` and the options (`SearchOptions`: `maxResults`, `snippetCharacters`, `includeDomains`,
`excludeDomains`, `publishedAfter`, `publishedBefore`; `FetchOptions`: `maxCharacters`) are `Schema`s. The four
evidence fields are the schema `Evidence.Evidence`; `Evidence.toJson` and `Evidence.fromJson` are its JSON form.

A call fails with one of five tagged errors, `SearchError`. A provider never retries: the caller decides.

```ts
const patient = provider.search("effect").pipe(
	Effect.catchTag("SearchRateLimited", (error) =>
		Effect.andThen(Effect.sleep(error.retryAfterMillis ?? 1000), provider.search("effect")),
	),
);
```

| Error | When | Fields besides `provider` |
|---|---|---|
| `SearchRateLimited` | Too many requests | `retryAfterMillis`, when the provider gave a hint |
| `SearchUnauthorized` | The key is missing, wrong or not entitled | `status` |
| `SearchProviderFailure` | Any other failure status | `status`, `detail` (what the provider said) |
| `SearchTransportFailure` | No response arrived, or its body could not be read | `detail` |
| `SearchResponseInvalid` | A success whose body is not what the API promises | `detail` |

Each `message` is one sentence a model can read. Interrupting a call aborts its request.

## The Exa provider

`Exa.layer(options?)` gives `SearchProvider` and requires an `HttpClient` (`FetchHttpClient.layer`, or your own with
a proxy, a timeout or tracing). It reads its configuration when the Layer is built, so a missing key fails there.

| Option | Default | |
|---|---|---|
| `apiKey` | `Config.Redacted("EXA_API_KEY")` | Sent as `x-api-key` and nowhere else |
| `baseUrl` | `EXA_BASE_URL`, else `https://api.exa.ai` | For a proxy or a test server. It is recorded in `request`: keep secrets out of it |
| `searchType` | Exa's (`auto`) | Exa's `type` for every search: `auto`, `lite`, `deep`, ... It decides cost |
| `category` | none | Exa's `category` for every search |
| `maxAgeHours` | Exa's | How old stored page content may be: `0` reads live, `-1` never does |

```ts
import { Config, Redacted } from "effect";

const exa = Exa.layer({
	apiKey: Config.succeed(Redacted.make(keyFromYourVault)),
	baseUrl: Config.succeed("https://exa.proxy.internal"),
	searchType: "auto",
	maxAgeHours: 24,
});
```

- `search` is `POST /search` with `numResults`, `includeDomains`, `excludeDomains`, `startPublishedDate`,
  `endPublishedDate` and `contents.highlights` (`maxCharacters` from `snippetCharacters`). A hit's snippet is Exa's
  highlights.
- `fetch` is `POST /contents` with `urls` and `text` (`maxCharacters`). A URL Exa reports with status `error` is in
  `unfetched`, with Exa's tag and the page's own HTTP status.
- Statuses: 429 is `SearchRateLimited` (with `Retry-After`, seconds or a date); 401 and 403 are `SearchUnauthorized`;
  everything else outside 2xx is `SearchProviderFailure` with Exa's `error` and `tag`.
- The response is decoded leniently: only `results[].url` is required, `null` and empty fields are absent in the hit,
  and fields Exa adds are ignored. They are still in `raw`.
- The key is a `Redacted`. It is in no result, no recorded request and no error: an error text that quotes it has it
  replaced by `<redacted>`. Nothing is logged.
- Effect's `HttpClient` adds its trace headers (`traceparent`, `b3`) to every request, so Exa receives them too.
  Provide `HttpClient.TracerPropagationEnabled` as `false` to send none.

## The tools

```ts
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Harness, Registry } from "@effectified/pi-durable";
import { Evidence, SearchTools } from "@effectified/pi-search";
import * as Exa from "@effectified/pi-search/exa";

const registry = Registry.layer([SearchTools.extension({ maxResults: 5, blockedDomains: ["example.org"] })]).pipe(
	// Does not type check without a SearchProvider: the tools' handlers need one.
	Layer.provide(Exa.layer()),
	Layer.provide(FetchHttpClient.layer),
);

// The host: the evidence of every search and fetch a conversation made.
const evidence = Effect.gen(function* () {
	const root = yield* Harness.root;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return yield* Effect.forEach(
		entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role === "toolResult")),
		(result) => Effect.option(Evidence.fromJson(result.details)),
	);
});
```

`SearchTools.extension(limits?)` is the extension `search` with both tools. It has no hooks, so its place in
`Registry.layer([...])` does not matter; put guard extensions first, as always. `SearchTools.search(limits)` and
`SearchTools.fetch(limits)` are the tools alone.

| Tool | The model gives | The model reads |
|---|---|---|
| `web_search` | `query`; optionally `maxResults`, `includeDomains`, `excludeDomains`, `publishedAfter`, `publishedBefore` | A numbered list: title, address, date and author when given, a one-line snippet |
| `web_fetch` | `urls`; optionally `maxCharacters` | Each page's text under its title and address, cut to the limit with the note `[Cut at N characters.]`, then one line per page that was not read, with the reason |

**The host gets** the result's `details`, which the model never reads: `{ provider, request, retrievedAt, raw }`,
the JSON form of `Evidence.Evidence`. `Evidence.fromJson(details)` decodes it.

**A failure** is an error result, never a failed task: the model reads the error's message, such as
`exa is rate limited. Retry after 7 s.`, and the run goes on. So is a call no limit lets through.

**Replay.** Both tools are `replay: "safe"`: a call that a crash or a close cut off runs again on reopen. That is a
second provider call. The stored evidence is that of the second answer, the one the model read, with its own
retrieval time; the first answer was never stored.

**A large raw response.** Pi Durable bounds what the model reads (50 KiB and 2,000 lines per result by default; past
that it keeps the head and adds a `truncated` diagnostic) and puts no limit on details. The raw body is stored whole,
as one JSON string in the `pi.tool-result` entry, and is read with that entry by whatever reads the transcript: a
host's `entries`, a UI's window, a fork. It is never sent to a model. Its size follows from the limits: about
`maxResults × snippetCharacters` for a search and `maxUrls × maxCharacters` for a fetch, plus the provider's
metadata; around 60 kB for a fetch at the defaults. Raise the limits knowing that.

## Limits

A product fixes these when it makes the tools. A model's request is brought within them: a number above its cap
becomes the cap.

```ts
import { DateTime } from "effect";

const tools = SearchTools.extension({
	maxResults: 5,
	allowedDomains: ["patents.google.com", "epo.org"],
	publishedBefore: DateTime.makeUnsafe("2024-03-01T00:00:00Z"),
});
```

| Limit | Default | |
|---|---|---|
| `maxResults` | 10 | The most hits one search asks for. A model asking for 1,000 gets this |
| `defaultResults` | 5 | The hits asked for when the model names no count |
| `snippetCharacters` | 500 | Each hit's snippet: asked of the provider, and shown at most |
| `maxUrls` | 5 | The most pages one fetch reads; the rest are listed as not fetched |
| `maxCharacters` | 10,000 | Each page's text: asked of the provider, and shown at most |
| `allowedDomains` | any | The only domains searched and fetched; `example.com` covers its subdomains |
| `blockedDomains` | none | Never searched or fetched, also inside an allowed domain |
| `publishedAfter`, `publishedBefore` | none | A search finds only pages inside this range; the model can narrow it |

A search for domains of which none is permitted, a date range that is empty inside the fixed one, and a fetch with no
permitted page are refused with an error result; the provider is not asked. An empty `allowedDomains` permits
nothing. A page's host is read by the platform's URL parser, as a fetcher reads it, so `https://example.com@evil.test/`
is a page of `evil.test`. Domain limits on a search are the provider's filters: the tools do not check its hits again.
`Limits` is a `Schema`, so limits can be read from configuration.

## Writing another provider

A provider is one file. It imports `@effectified/pi-search/provider` and `effect`, and exports:

- `layer`: a `Layer` that gives `SearchProvider`. Credentials come from `Config` as `Redacted`.
- `name`: the string it writes into `provider`.

In `search` and `fetch` it must: put the body's text, unchanged, in `raw`; put the request without credentials in
`request`; take `retrievedAt` from `DateTime.now`; map its hits to `Hit` and leave out what it was not given; and
fail only with the five errors. This is a whole provider for a made-up API
([`test/example-provider.ts`](test/example-provider.ts), with its test):

```ts
export const name = "acme";

export function layer(): Layer.Layer<SearchProvider, Config.ConfigError, HttpClient.HttpClient> {
	return Layer.effect(
		SearchProvider,
		Effect.gen(function* () {
			const key = yield* Config.Redacted("ACME_API_KEY");
			const client = yield* HttpClient.HttpClient;
			const call = (request: HttpClientRequest.HttpClientRequest, sent: Retrieval["request"]) =>
				Effect.gen(function* () {
					const response = yield* client.execute(HttpClientRequest.bearerToken(request, key));
					const raw = yield* response.text;
					const retrievedAt = yield* DateTime.now;
					if (response.status === 429) return yield* new SearchRateLimited({ provider: name });
					if (response.status === 401) return yield* new SearchUnauthorized({ provider: name, status: 401 });
					if (response.status !== 200) {
						return yield* new SearchProviderFailure({ provider: name, status: response.status });
					}
					const { items } = yield* decode(raw);
					const hits = items.map((item) => ({ url: item.link, title: item.name, snippet: item.excerpt }));
					return { provider: name, request: sent, retrievedAt, raw, hits, unfetched: [] };
				}).pipe(Effect.catchTags({ HttpClientError: unreachable, SchemaError: unreadable }));
			return {
				search: (query, options = {}) => {
					const url = `https://api.acme.test/v1/search?q=${encodeURIComponent(query)}&n=${options.maxResults ?? 10}`;
					return call(HttpClientRequest.get(url), { method: "GET", url, body: null });
				},
				fetch: (urls) => {
					const url = "https://api.acme.test/v1/pages";
					const body = { urls };
					return call(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body), {
						method: "POST",
						url,
						body,
					});
				},
			};
		}),
	);
}
```

A provider inside this package also gets a subpath in `package.json` `exports`; one in a product needs nothing more.

## License

MIT
