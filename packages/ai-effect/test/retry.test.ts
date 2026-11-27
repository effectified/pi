// pi-ai's retry rule as an Effect: the same responses and the same notifications as pi-ai's own loop, with the
// backoff on the test clock.

import {
	type AssistantMessage,
	retryAssistantCall as piRetryAssistantCall,
	type RetryPolicy,
} from "@earendil-works/pi-ai";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { emptyUsage, retryAssistantCall } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

function response(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: emptyUsage(),
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 0,
	};
}

const OVERLOADED = response("error", "529 overloaded");
const BILLING = response("error", "insufficient_quota");
const ANSWER = response("stop");
const ABORTED = response("aborted");
const POLICY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };

/** pi-ai's loop over `responses`, with its notifications as text. Its backoff runs on real timers, so it is 0 here. */
async function pi(responses: AssistantMessage[], policy: RetryPolicy | undefined) {
	const queue = [...responses];
	const seen: string[] = [];
	const result = await piRetryAssistantCall(
		async () => queue.shift() ?? ANSWER,
		policy === undefined ? undefined : { ...policy, baseDelayMs: 0 },
		undefined,
		{
			onRetryScheduled: (attempt, max, _delay, error) => void seen.push(`scheduled ${attempt}/${max} ${error}`),
			onRetryAttemptStart: () => void seen.push("start"),
			onRetryFinished: (success, attempt, error) => void seen.push(`finished ${success} ${attempt} ${error}`),
		},
	);
	return { result, seen };
}

/** The Effect form over `responses`, moving the test clock until it ends. */
function ours(responses: AssistantMessage[], policy: RetryPolicy | undefined) {
	return Effect.gen(function* () {
		const queue = [...responses];
		const seen: string[] = [];
		const delays: number[] = [];
		const fiber = yield* Effect.forkChild(
			retryAssistantCall(
				Effect.sync(() => queue.shift() ?? ANSWER),
				policy,
				{
					onRetryScheduled: ({ attempt, maxAttempts, delayMs, errorMessage }) =>
						Effect.sync(() => {
							delays.push(delayMs);
							seen.push(`scheduled ${attempt}/${maxAttempts} ${errorMessage}`);
						}),
					onRetryAttemptStart: Effect.sync(() => void seen.push("start")),
					onRetryFinished: ({ success, attempt, finalError }) =>
						Effect.sync(() => void seen.push(`finished ${success} ${attempt} ${finalError}`)),
				},
			),
			{ startImmediately: true },
		);
		for (let step = 0; step < 4; step++) yield* TestClock.adjust(1000 * 2 ** step);
		return { result: yield* Fiber.join(fiber), seen, delays };
	});
}

const CASES: ReadonlyArray<readonly [string, AssistantMessage[], RetryPolicy | undefined]> = [
	["an answer after two transient errors", [OVERLOADED, OVERLOADED, ANSWER], POLICY],
	["the last error once the retries are spent", [OVERLOADED, OVERLOADED, OVERLOADED], POLICY],
	["a billing error at once", [BILLING], POLICY],
	["an abort after a retry", [OVERLOADED, ABORTED], POLICY],
	["the first error without a policy", [OVERLOADED], undefined],
	["the first error with a disabled policy", [OVERLOADED], { ...POLICY, enabled: false }],
];

describe("retryAssistantCall", () => {
	it.each(CASES)("returns what pi-ai returns, with its notifications: %s", async (_name, responses, policy) => {
		const expected = await pi(responses, policy);
		const actual = await runTest(ours(responses, policy));
		expect(actual.result).toEqual(expected.result);
		expect(actual.seen).toEqual(expected.seen);
	});

	it("waits pi-ai's backoff on the clock: the base delay, doubled each retry", async () => {
		const { delays } = await runTest(ours([OVERLOADED, OVERLOADED, ANSWER], POLICY));
		expect(delays).toEqual([1000, 2000]);
	});

	it("does not retry before the backoff has passed", async () => {
		const calls = await runTest(
			Effect.gen(function* () {
				let calls = 0;
				const fiber = yield* Effect.forkChild(
					retryAssistantCall(
						Effect.sync(() => (calls++ === 0 ? OVERLOADED : ANSWER)),
						POLICY,
					),
					{ startImmediately: true },
				);
				yield* TestClock.adjust(999);
				const before = calls;
				yield* TestClock.adjust(1);
				yield* Fiber.join(fiber);
				return [before, calls];
			}),
		);
		expect(calls).toEqual([1, 2]);
	});

	it("pipes: the policy first, the call to retry last", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const queue = [OVERLOADED, ANSWER];
				const fiber = yield* Effect.forkChild(
					Effect.sync(() => queue.shift() ?? ANSWER).pipe(retryAssistantCall(POLICY)),
					{ startImmediately: true },
				);
				yield* TestClock.adjust(1000);
				return yield* Fiber.join(fiber);
			}),
		);
		expect(result).toEqual(ANSWER);
	});
});
