// pi-ai's retry of a failed assistant call as an Effect: its classifier, its backoff and its order of notifications,
// with the backoff waited on `Clock`.

import {
	type AssistantMessage,
	isRetryableAssistantError,
	type RetryPolicy,
	retryDelayMs,
} from "@earendil-works/pi-ai";
import { Effect, String as Str } from "effect";
import { dual } from "effect/Function";

/** pi-ai's `RetryCallbacks` as Effects, run in order by `retryAssistantCall`. */
export interface RetryNotifications<R = never> {
	/** Before the backoff of each retry (`attempt` counts from 1). */
	readonly onRetryScheduled?: (retry: {
		readonly attempt: number;
		readonly maxAttempts: number;
		readonly delayMs: number;
		readonly errorMessage: string;
	}) => Effect.Effect<void, never, R>;
	/** After the backoff, right before the retried call. */
	readonly onRetryAttemptStart?: Effect.Effect<void, never, R>;
	/** Once, when a loop that retried ends: `success` when a later call answered. */
	readonly onRetryFinished?: (finish: {
		readonly success: boolean;
		readonly attempt: number;
		readonly finalError?: string;
	}) => Effect.Effect<void, never, R>;
}

/**
 * Runs `produce` and retries it by pi-ai's rule (`retryAssistantCall`): a response that answered, or was aborted, is
 * returned at once; an `error` response is retried while `isRetryableAssistantError` says it was transient and the
 * policy has retries left, after `retryDelayMs` of the policy (exponential from `baseDelayMs`, capped by
 * `maxAgentDelayMs`); the last response is returned otherwise. Without a policy, or with one not `enabled`, the
 * first response is returned. The backoff is `Effect.sleep`, so `TestClock` moves it. Interrupting the fiber is
 * interruption: unlike pi-ai, which turns an abort during the backoff into an `aborted` response. Data-first, or
 * data-last in a pipe: `complete(model, context).pipe(retryAssistantCall(policy))`.
 */
export const retryAssistantCall: {
	<R2 = never>(
		policy: RetryPolicy | undefined,
		notifications?: RetryNotifications<R2>,
	): <E, R>(produce: Effect.Effect<AssistantMessage, E, R>) => Effect.Effect<AssistantMessage, E, R | R2>;
	<E, R, R2 = never>(
		produce: Effect.Effect<AssistantMessage, E, R>,
		policy: RetryPolicy | undefined,
		notifications?: RetryNotifications<R2>,
	): Effect.Effect<AssistantMessage, E, R | R2>;
} = dual(
	(args) => Effect.isEffect(args[0]),
	Effect.fn("Retry.retryAssistantCall")(function* <E, R, R2 = never>(
		produce: Effect.Effect<AssistantMessage, E, R>,
		policy: RetryPolicy | undefined,
		notifications: RetryNotifications<R2> = {},
	): Effect.fn.Return<AssistantMessage, E, R | R2> {
		const maxAttempts = policy?.enabled === true ? policy.maxRetries : 0;
		// pi-ai tells the end only of a loop that retried: a first call that settles it is not reported.
		const finish = (attempt: number, success: boolean, finalError?: string): Effect.Effect<void, never, R2> =>
			attempt === 0 || notifications.onRetryFinished === undefined
				? Effect.void
				: notifications.onRetryFinished({ success, attempt, ...(finalError === undefined ? {} : { finalError }) });
		for (let attempt = 0; ; attempt++) {
			const response = yield* produce;
			if (response.stopReason !== "error") {
				yield* finish(attempt, response.stopReason !== "aborted");
				return response;
			}
			if (policy === undefined || attempt >= maxAttempts || !isRetryableAssistantError(response)) {
				yield* finish(attempt, false, response.errorMessage);
				return response;
			}
			const next = attempt + 1;
			const delayMs = retryDelayMs(policy, next);
			const message = response.errorMessage;
			const errorMessage = message !== undefined && Str.isNonEmpty(message) ? message : "Unknown error";
			if (notifications.onRetryScheduled !== undefined) {
				yield* notifications.onRetryScheduled({ attempt: next, maxAttempts, delayMs, errorMessage });
			}
			yield* Effect.sleep(delayMs);
			if (notifications.onRetryAttemptStart !== undefined) yield* notifications.onRetryAttemptStart;
		}
	}),
);
