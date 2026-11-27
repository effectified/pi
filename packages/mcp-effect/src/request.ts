// One request of an MCP client in Effect terms: interrupting the fiber cancels it, and its timeout runs on `Clock`.

import type { McpRequestOptions, ProgressNotification } from "@earendil-works/pi-mcp";
import { Cause, Duration, Effect, Exit, Option, Queue } from "effect";
import { fromPi, McpFailure, McpTimeoutError } from "./errors.ts";

/** pi-mcp's request options in Effect terms: the fiber owns cancellation, and `Clock` the timeout. */
export interface RequestOptions {
	/**
	 * How long the server may go without answering or reporting progress before the request fails with
	 * `McpTimeoutError` and is cancelled; each progress notification starts it again, as in Pi. `"Infinity"`: never.
	 * Default: the client's `requestTimeout`.
	 */
	readonly timeout?: Duration.Input;
	/** Where the server's progress notifications for this request go. Asking for them sends a progress token. */
	readonly progress?: Queue.Enqueue<ProgressNotification>;
}

/** Pi's request options this module sets in place of the caller: the signal, Pi's own timer and the progress hook. */
export type PiRequestOptions = Required<Pick<McpRequestOptions, "signal" | "timeoutMs">> &
	Pick<McpRequestOptions, "onProgress">;

/**
 * Runs the Pi request `start` begins. Interrupting the fiber aborts the request's signal, so Pi cancels it and tells
 * the server; so does the timeout, with Pi's reason, "Request timed out". Pi's own timer is turned off (`timeoutMs: 0`):
 * the deadline is kept on `Clock`, so `TestClock` drives it. Untraced: the client's calls carry the span.
 */
export const request: <A>(
	start: (options: PiRequestOptions) => Promise<A>,
	timeout: Duration.Input,
	progress: Queue.Enqueue<ProgressNotification> | undefined,
) => Effect.Effect<A, McpFailure> = Effect.fnUntraced(function* <A>(
	start: (options: PiRequestOptions) => Promise<A>,
	timeout: Duration.Input,
	progress: Queue.Enqueue<ProgressNotification> | undefined,
) {
	const limit = Duration.fromInputUnsafe(timeout);
	// One element per progress notification; only the latest matters, as each starts the timeout again.
	const beats = yield* Queue.sliding<void>(1);
	return yield* Effect.acquireUseRelease(
		Effect.sync(() => new AbortController()),
		(controller) => {
			const call = Effect.tryPromise({
				try: () =>
					start({
						signal: controller.signal,
						timeoutMs: 0,
						// Pi asks for progress only when this is set: without a queue, no progress token is sent.
						onProgress:
							progress === undefined
								? undefined
								: (notification) => {
										Queue.offerUnsafe(beats, undefined);
										Queue.offerUnsafe(progress, notification);
									},
					}),
				catch: fromPi,
			});
			const timeoutMs = Duration.toMillis(limit);
			if (!Duration.isFinite(limit) || timeoutMs <= 0) return call;
			// Waits for each progress notification at most `limit`; one that does not come in time is the timeout.
			const expired = Effect.forever(
				Effect.timeoutOrElse(Queue.take(beats), {
					duration: limit,
					orElse: () => Effect.fail(McpTimeoutError.make({ timeoutMs })),
				}),
			);
			return Effect.raceFirst(call, expired);
		},
		(controller, exit) =>
			Effect.sync(() => {
				// A settled request no longer listens to its signal, so this aborts only one still in flight.
				const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
				const timedOut = Option.exists(failure, McpFailure.guards.McpTimeoutError);
				controller.abort(timedOut ? "Request timed out" : undefined);
			}),
	);
});
