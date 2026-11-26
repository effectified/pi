// One request of an MCP client in Effect terms: interrupting the fiber cancels it, and its timeout runs on `Clock`.

import type { McpRequestOptions, ProgressNotification } from "@earendil-works/pi-mcp";
import { Cause, Clock, Duration, Effect, Exit, Option, Queue } from "effect";
import { fromPi, type McpFailure, McpTimeoutError } from "./errors.ts";

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
 * the deadline is kept on `Clock`, so `TestClock` drives it.
 */
export function request<A>(
	start: (options: PiRequestOptions) => Promise<A>,
	timeout: Duration.Input,
	progress: Queue.Enqueue<ProgressNotification> | undefined,
): Effect.Effect<A, McpFailure> {
	return Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const limit = Duration.fromInputUnsafe(timeout);
		const timeoutMs = Duration.toMillis(limit);
		let deadline = clock.currentTimeMillisUnsafe() + timeoutMs;
		return yield* Effect.acquireUseRelease(
			Effect.sync(() => new AbortController()),
			(controller) => {
				const call = Effect.tryPromise({
					try: () =>
						start({
							signal: controller.signal,
							timeoutMs: 0,
							// Pi asks for progress only when this is set: without a queue, no progress token is sent.
							onProgress: progress
								? (notification) => {
										deadline = clock.currentTimeMillisUnsafe() + timeoutMs;
										Queue.offerUnsafe(progress, notification);
									}
								: undefined,
						}),
					catch: fromPi,
				});
				if (!Duration.isFinite(limit) || timeoutMs <= 0) return call;
				const expired = Effect.gen(function* () {
					while (true) {
						const left = deadline - (yield* Clock.currentTimeMillis);
						if (left <= 0) return yield* new McpTimeoutError({ timeoutMs });
						yield* Effect.sleep(left);
					}
				});
				return Effect.raceFirst(call, expired);
			},
			(controller, exit) =>
				Effect.sync(() => {
					// A settled request no longer listens to its signal, so this aborts only one still in flight.
					const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
					const timedOut = Option.isSome(failure) && failure.value._tag === "McpTimeoutError";
					controller.abort(timedOut ? "Request timed out" : undefined);
				}),
		);
	});
}
