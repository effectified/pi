// One request in Effect terms, against a hand-driven start function: Pi's timer off, the deadline on the test clock,
// the signal aborted on interruption and on timeout with Pi's reason.

import { McpConnectionClosedError, type ProgressNotification } from "@earendil-works/pi-mcp";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { type PiRequestOptions, request } from "../src/request.ts";

/** A start function that records what Pi would have been given and settles when the test says. */
function pending() {
	const seen: { options?: PiRequestOptions } = {};
	let settle: { resolve: (value: string) => void; reject: (error: unknown) => void } | undefined;
	const start = (options: PiRequestOptions) => {
		seen.options = options;
		return new Promise<string>((resolve, reject) => {
			settle = { resolve, reject };
			options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	};
	return { start, seen, settle: () => settle };
}

describe("request", () => {
	it("turns Pi's timer off and succeeds with what the request resolves with", async () => {
		const call = pending();
		const value = await runTest(
			Effect.gen(function* () {
				const running = yield* Effect.forkChild(request(call.start, "30 seconds", undefined), {
					startImmediately: true,
				});
				call.settle()?.resolve("answer");
				return yield* Fiber.join(running);
			}),
		);
		expect(value).toBe("answer");
		expect(call.seen.options).toMatchObject({ timeoutMs: 0, onProgress: undefined });
	});

	it("fails with Pi's error tagged", async () => {
		const call = pending();
		const error = await runTest(
			Effect.gen(function* () {
				const running = yield* Effect.forkChild(Effect.flip(request(call.start, "30 seconds", undefined)), {
					startImmediately: true,
				});
				call.settle()?.reject(new McpConnectionClosedError());
				return yield* Fiber.join(running);
			}),
		);
		expect(error._tag).toBe("McpConnectionClosedError");
	});

	it("times out on the clock and aborts with Pi's reason", async () => {
		const call = pending();
		const error = await runTest(
			Effect.gen(function* () {
				const running = yield* Effect.forkChild(Effect.flip(request(call.start, "2 seconds", undefined)), {
					startImmediately: true,
				});
				yield* TestClock.adjust("1999 millis");
				expect(call.seen.options?.signal.aborted).toBe(false);
				yield* TestClock.adjust("1 millis");
				return yield* Fiber.join(running);
			}),
		);
		expect(error).toMatchObject({ _tag: "McpTimeoutError", timeoutMs: 2000 });
		expect(call.seen.options?.signal.reason).toBe("Request timed out");
	});

	it("restarts the deadline on progress and passes the progress on", async () => {
		const call = pending();
		const seen = await runTest(
			Effect.gen(function* () {
				const progress = yield* Queue.unbounded<ProgressNotification>();
				const running = yield* Effect.forkChild(request(call.start, "2 seconds", progress), {
					startImmediately: true,
				});
				yield* TestClock.adjust("1500 millis");
				call.seen.options?.onProgress?.({ progressToken: 1, progress: 0.5 });
				yield* TestClock.adjust("1500 millis");
				call.settle()?.resolve("late but in time");
				return { value: yield* Fiber.join(running), progress: yield* Queue.take(progress) };
			}),
		);
		expect(seen).toEqual({ value: "late but in time", progress: { progressToken: 1, progress: 0.5 } });
	});

	it("aborts the signal without a reason of its own when the fiber is interrupted", async () => {
		const call = pending();
		const exit = await runTest(
			Effect.gen(function* () {
				const running = yield* Effect.forkChild(request(call.start, "30 seconds", undefined), {
					startImmediately: true,
				});
				yield* Fiber.interrupt(running);
				return yield* Fiber.await(running);
			}),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
		expect(call.seen.options?.signal.aborted).toBe(true);
		expect(call.seen.options?.signal.reason).toBeInstanceOf(DOMException);
	});
});
