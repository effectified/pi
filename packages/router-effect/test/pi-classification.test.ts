// What `classify` reads of failures pi-ai's own adapters report: the error text and the HTTP answer come from a real
// adapter (OpenAI's chat completions and Anthropic's messages) on a `fetch` that answers as a provider would, not from
// strings written here. The rate-limit wordings of `classify` and pi-ai's text for a server's wait are restated from
// pi-ai, which exports neither: a wording pi-ai changes fails here.

import {
	type AssistantMessage,
	type FetchFunction,
	type Model,
	normalizeContext,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openAi } from "@earendil-works/pi-ai/api/openai-completions";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { classify } from "../src/classify.ts";

const NOW = Date.parse("2026-11-24T00:00:00Z");

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

/** What a provider answers: a status, its headers and a JSON body. */
interface Answer {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly body: unknown;
}

type Adapter = "openai-completions" | "anthropic-messages";

/** What pi-ai's adapter of `api` makes of `answer`: the failed message and the HTTP answer it reported. */
function failure(api: Adapter, answer: Answer, maxRetries = 0) {
	return Effect.promise(async () => {
		const reported: ProviderResponse[] = [];
		const fetch: FetchFunction = async () =>
			new Response(JSON.stringify(answer.body), {
				status: answer.status,
				headers: { "content-type": "application/json", ...answer.headers },
			});
		const options = {
			apiKey: "test-key",
			fetch,
			maxRetries,
			onResponse: (response: ProviderResponse) => void reported.push(response),
		};
		const message: AssistantMessage =
			api === "openai-completions"
				? await openAi(model("openai-completions"), context, options).result()
				: await anthropic(model("anthropic-messages"), context, options).result();
		return { message, response: reported.at(-1) };
	});
}

function model<TApi extends Adapter>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

/** The rate limit each adapter's provider answers with: its own error body. */
const rateLimited: Record<Adapter, unknown> = {
	"openai-completions": {
		error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
	},
	"anthropic-messages": {
		type: "error",
		error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
	},
};

const ADAPTERS: ReadonlyArray<Adapter> = ["openai-completions", "anthropic-messages"];

describe("classify on what pi-ai's adapters report", () => {
	it("reads a 429 as a rate limit with the wait of its header, with and without the reported answer", () =>
		runTest(
			Effect.gen(function* () {
				for (const api of ADAPTERS) {
					const { message, response } = yield* failure(api, {
						status: 429,
						headers: { "retry-after": "7" },
						body: rateLimited[api],
					});
					expect(message.stopReason, api).toBe("error");
					expect(response?.status, api).toBe(429);
					expect(classify(message, response, NOW), api).toEqual({ _tag: "RateLimited", retryAfterMillis: 7_000 });
					// An adapter that reported no answer: the text alone says rate limit.
					expect(classify(message, undefined, NOW), api).toEqual({
						_tag: "RateLimited",
						retryAfterMillis: undefined,
					});
				}
			}),
		));

	it("takes the wait from pi-ai's text when the server asked for more than the request allows", () =>
		runTest(
			Effect.gen(function* () {
				for (const api of ADAPTERS) {
					// One retry is allowed, so pi-ai reads the server's wait of two minutes, which is past its cap of one.
					const { message } = yield* failure(
						api,
						{ status: 429, headers: { "retry-after": "120" }, body: rateLimited[api] },
						1,
					);
					expect(message.errorMessage, api).toContain("retry delay");
					expect(classify(message, undefined, NOW), api).toEqual({
						_tag: "RateLimited",
						retryAfterMillis: 120_000,
					});
				}
			}),
		));

	it("lets the next route try after a server error, and ends the request for a refused key or an exhausted quota", () =>
		runTest(
			Effect.gen(function* () {
				for (const api of ADAPTERS) {
					const overloaded = yield* failure(api, {
						status: 503,
						body: { error: { message: "Service Unavailable" } },
					});
					expect(classify(overloaded.message, overloaded.response, NOW), api).toEqual({ _tag: "Retryable" });
					const refused = yield* failure(api, { status: 401, body: { error: { message: "invalid x-api-key" } } });
					expect(classify(refused.message, refused.response, NOW), api).toEqual({ _tag: "Final" });
					const quota = yield* failure(api, {
						status: 429,
						body: { error: { message: "You exceeded your current quota", type: "insufficient_quota" } },
					});
					expect(classify(quota.message, quota.response, NOW), api).toEqual({ _tag: "Final" });
				}
			}),
		));
});
