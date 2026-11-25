// The README's example of another provider, whole: one file that exports `layer`. It speaks to a made-up API
// (`GET /v1/search?q=`, `POST /v1/pages`), so it shows the shape of a provider file and nothing of a real service.

import { Config, DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
	type Retrieval,
	type SearchError,
	SearchProvider,
	SearchProviderFailure,
	SearchRateLimited,
	SearchResponseInvalid,
	SearchTransportFailure,
	SearchUnauthorized,
} from "../src/provider/index.ts";

/** The provider's name in results and errors. */
export const name = "acme";

/** The search port on the Acme API: the key from `ACME_API_KEY`, the requests through the `HttpClient`. */
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

const decode = Schema.decodeUnknownEffect(
	Schema.fromJsonString(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ link: Schema.String, name: Schema.String, excerpt: Schema.String })),
		}),
	),
);

const unreachable = (error: { readonly message: string }): Effect.Effect<never, SearchError> =>
	Effect.fail(new SearchTransportFailure({ provider: name, detail: error.message }));

const unreadable = (error: { readonly message: string }): Effect.Effect<never, SearchError> =>
	Effect.fail(new SearchResponseInvalid({ provider: name, detail: error.message }));
