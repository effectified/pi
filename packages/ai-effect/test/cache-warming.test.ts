// Prompt cache warming in Effect terms: the entry's lifetime with the environment read through Config, and the
// refresh request with pi-ai's refresh options.

import {
	type Api,
	type Model,
	getPromptCacheTtlMs as piGetPromptCacheTtlMs,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ConfigProvider, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { getPromptCacheTtlMs, type RequestOptions, warmCache } from "../src/index.ts";
import { fauxAssistantMessage, runTest, ScriptedModels } from "../src/testing/index.ts";

const MODEL: Model<Api> = {
	id: "cached",
	name: "cached",
	api: "faux",
	provider: "faux",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 1000,
	maxTokens: 100,
	promptCache: { short: 300, long: 3600 },
};

const ttl = (options: RequestOptions<SimpleStreamOptions> | undefined, env: Record<string, string> = {}) =>
	runTest(
		getPromptCacheTtlMs(MODEL, options).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
	);

describe("getPromptCacheTtlMs", () => {
	it("is pi-ai's lifetime for the retention the request names", async () => {
		for (const cacheRetention of ["short", "long", "none"] as const) {
			expect(await ttl({ cacheRetention })).toEqual(
				Option.fromUndefinedOr(piGetPromptCacheTtlMs(MODEL, { cacheRetention })),
			);
		}
	});

	it("takes PI_CACHE_RETENTION from the request's env first, then from Config, short otherwise", async () => {
		expect(await ttl({ env: { PI_CACHE_RETENTION: "long" } }, { PI_CACHE_RETENTION: "short" })).toEqual(
			Option.some(3600000),
		);
		expect(await ttl(undefined, { PI_CACHE_RETENTION: "long" })).toEqual(Option.some(3600000));
		expect(await ttl(undefined, { PI_CACHE_RETENTION: "other" })).toEqual(Option.some(300000));
		expect(await ttl(undefined)).toEqual(Option.some(300000));
	});
});

describe("warmCache", () => {
	it("sends the request again with pi-ai's refresh options", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const options: Array<SimpleStreamOptions | undefined> = [];
				yield* scripted.setResponses([
					(_context, streamOptions) => {
						options.push(streamOptions);
						return fauxAssistantMessage("");
					},
				]);
				yield* warmCache(scripted.model, { messages: [] }, { maxTokens: 50, cacheRetention: "long" });
				return options[0];
			}).pipe(Effect.provide(ScriptedModels.layer())),
		);
		expect(seen).toMatchObject({ maxTokens: 1, maxRetries: 0, disableContinuation: true, cacheRetention: "long" });
	});
});
