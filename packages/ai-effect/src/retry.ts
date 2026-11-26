// pi-ai's retry of a failed assistant call as an Effect: its classifier, its backoff and its order of notifications,
// with the backoff waited on `Clock`.

import {
	type AssistantMessage,
	isRetryableAssistantError,
	type RetryPolicy,
	retryDelayMs,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";

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
 * interruption: unlike pi-ai, which turns an abort during the backoff into an `aborted` response.
 */
export function retryAssistantCall<E, R, R2 = never>(
	produce: Effect.Effect<AssistantMessage, E, R>,
	policy: RetryPolicy | undefined,
	notifications: RetryNotifications<R2> = {},
): Effect.Effect<AssistantMessage, E, R | R2> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
	const finish = (lastAttempt: number | undefined, success: boolean, finalError?: string) =>
		lastAttempt === undefined || notifications.onRetryFinished === undefined
			? Effect.void
			: notifications.onRetryFinished({
					success,
					attempt: lastAttempt,
					...(finalError === undefined ? {} : { finalError }),
				});
	const loop = (attempt: number, lastAttempt: number | undefined): Effect.Effect<AssistantMessage, E, R | R2> =>
		Effect.flatMap(produce, (response) => {
			if (response.stopReason === "aborted") return Effect.as(finish(lastAttempt, false), response);
			if (response.stopReason !== "error") return Effect.as(finish(lastAttempt, true), response);
			if (policy === undefined || attempt >= maxAttempts || !isRetryableAssistantError(response)) {
				return Effect.as(finish(lastAttempt, false, response.errorMessage), response);
			}
			const next = attempt + 1;
			const delayMs = retryDelayMs(policy, next);
			const errorMessage = response.errorMessage || "Unknown error";
			return Effect.andThen(
				notifications.onRetryScheduled?.({ attempt: next, maxAttempts, delayMs, errorMessage }) ?? Effect.void,
				Effect.andThen(
					Effect.sleep(delayMs),
					Effect.andThen(notifications.onRetryAttemptStart ?? Effect.void, loop(next, next)),
				),
			);
		});
	return Effect.suspend(() => loop(0, undefined));
}
