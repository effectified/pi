// pi-ai's prompt cache warming in Effect terms: the lifetime of a cache entry with the environment read through
// `Config`, and the refresh request itself. The numbers and the warm-or-stop decision are pi-ai's, offered as they are.

import {
	type Api,
	type AssistantMessage,
	getCacheWarmingRequestOptions,
	type Model,
	type Context as PiContext,
	getPromptCacheTtlMs as piGetPromptCacheTtlMs,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Config, Effect, Option } from "effect";
import type { ModelRequestError } from "./errors.ts";
import type { Models } from "./models.ts";
import { completeSimple, type RequestOptions } from "./request.ts";

/**
 * How long the prompt cache entry a request writes lives, in milliseconds, from the model's `promptCache` tier for
 * the retention the request used (pi-ai's `getPromptCacheTtlMs`). Without `cacheRetention` in `options`, the retention
 * is `PI_CACHE_RETENTION` (`long`, or `short` otherwise) from `options.env`, or else from `Config`. None when the model
 * has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(
	model: Model<Api>,
	options?: RequestOptions<SimpleStreamOptions>,
): Effect.Effect<Option.Option<number>, Config.ConfigError> {
	return Effect.map(cacheRetention(options), (cacheRetention) =>
		Option.fromUndefinedOr(piGetPromptCacheTtlMs(model, { ...options, cacheRetention })),
	);
}

/**
 * Sends the refresh of a request's prompt cache entry: the request again with pi-ai's refresh options (one output
 * token, no retries, the conversation's provider thread state untouched; `getCacheWarmingRequestOptions`). Whether
 * to send it is pi-ai's `evaluateCacheWarming` and `isCacheWarmingReplayable`; when, `getCacheWarmingDelayMs` of the
 * entry's lifetime, waited with `Effect.sleep`.
 */
export function warmCache(
	model: Model<Api>,
	context: PiContext,
	options?: RequestOptions<SimpleStreamOptions>,
): Effect.Effect<AssistantMessage, ModelRequestError, Models> {
	return Effect.suspend(() => {
		// pi-ai puts the given signal in the options; the request below owns cancellation and adds its own.
		const { signal: _signal, ...refresh } = getCacheWarmingRequestOptions(
			options ?? {},
			new AbortController().signal,
		);
		return completeSimple(model, context, refresh);
	});
}

const RETENTION = "PI_CACHE_RETENTION";

/**
 * The retention pi-ai would use: the request's own, else `PI_CACHE_RETENTION` of its `env`, else of `Config` (where
 * pi-ai would read the process environment). Given to pi-ai explicitly so it never reads the environment itself.
 */
function cacheRetention(
	options: SimpleStreamOptions | undefined,
): Effect.Effect<NonNullable<SimpleStreamOptions["cacheRetention"]>, Config.ConfigError> {
	if (options?.cacheRetention !== undefined) return Effect.succeed(options.cacheRetention);
	const scoped = options?.env?.[RETENTION];
	const value = scoped ? Effect.succeed(Option.some(scoped)) : Config.option(Config.String(RETENTION));
	return Effect.map(value, (retention) => (Option.getOrUndefined(retention) === "long" ? "long" : "short"));
}
