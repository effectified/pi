// The README's example of another provider, whole: one file that exports `layer`. It speaks to a made-up API
// (`GET /v1/search?q=`, `POST /v1/pages`), so it shows the shape of a provider file and nothing of a real service.

import { Array as Arr, Config, DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
	ProviderName,
	type Retrieval,
	SearchProvider,
	SearchProviderFailure,
	SearchRateLimited,
	SearchResponseInvalid,
	SearchTransportFailure,
	SearchUnauthorized,
} from "../src/provider/index.ts";

/** The provider's name in results and errors. */
export const name = ProviderName.make("acme");

/** The search port on the Acme API: the key from `ACME_API_KEY`, the requests through the `HttpClient`. */
export const layer: Layer.Layer<SearchProvider, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
	SearchProvider,
	Effect.gen(function* () {
		const key = yield* Config.Redacted("ACME_API_KEY");
		const client = yield* HttpClient.HttpClient;
		const call = Effect.fn("Acme.call")(
			function* (request: HttpClientRequest.HttpClientRequest, sent: Retrieval["request"]) {
				const response = yield* client.execute(HttpClientRequest.bearerToken(request, key));
				const raw = yield* response.text;
				const retrievedAt = yield* DateTime.now;
				if (response.status === 429) return yield* SearchRateLimited.make({ provider: name });
				if (response.status === 401) return yield* SearchUnauthorized.make({ provider: name, status: 401 });
				if (response.status !== 200) {
					return yield* SearchProviderFailure.make({ provider: name, status: response.status });
				}
				const { items } = yield* decode(raw);
				const hits = Arr.map(items, (item) => ({ url: item.link, title: item.name, snippet: item.excerpt }));
				return { provider: name, request: sent, retrievedAt, raw, hits, unfetched: [] };
			},
			Effect.catchTags({
				HttpClientError: (error) =>
					Effect.fail(SearchTransportFailure.make({ provider: name, detail: error.message })),
				SchemaError: (error) => Effect.fail(SearchResponseInvalid.make({ provider: name, detail: error.message })),
			}),
		);
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

// The HTTP boundary: the API's body, decoded with the schema of what the provider reads of it.
const decode = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ link: Schema.String, name: Schema.String, excerpt: Schema.String })),
		}),
	),
);
