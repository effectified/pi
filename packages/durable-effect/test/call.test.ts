import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withAbortSignal,
	withCancel,
	withContextValue,
} from "@earendil-works/chord/context";
import { type ConversationId, ConversationBusy as PiConversationBusy } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Cause, Effect, Exit, Fiber, Latch } from "effect";
import { describe, expect, it } from "vitest";
import { call, ParentContext, step } from "../src/call.ts";

/**
 * A Pi call that settles only when its context is cancelled, as Pi's waits do, and then only once the test calls
 * `settle` (at once when it was called before). `cancelled` succeeds when the cancellation reached the call.
 */
function cancellable() {
	const cancelled = Latch.makeUnsafe();
	const released = Promise.withResolvers<void>();
	let settled = false;
	const run = (context: Context): Promise<never> =>
		new Promise((_resolve, reject) => {
			context.abortSignal?.addEventListener("abort", () => {
				cancelled.openUnsafe();
				void released.promise.then(() => {
					settled = true;
					reject(context.abortSignal?.reason);
				});
			});
		});
	return { run, cancelled: cancelled.await, settle: () => released.resolve(), settled: () => settled };
}

describe("call", () => {
	it("succeeds with what Pi resolves, under a context that is not cancelled", async () => {
		const seen = await Effect.runPromise(call(async (context) => context.abortSignal?.aborted));
		expect(seen).toBe(false);
	});

	it("fails with the tagged error of what Pi rejects with", async () => {
		const error = await Effect.runPromise(
			Effect.flip(call(() => Promise.reject(new PiConversationBusy(3 as ConversationId)))),
		);
		expect(error).toMatchObject({ _tag: "ConversationBusy", conversationId: 3 });
	});

	it("fails with UnexpectedError when the call throws before it returns a promise", async () => {
		const cause = new Error("Session is closed");
		const error = await Effect.runPromise(
			Effect.flip(
				call((): Promise<void> => {
					throw cause;
				}),
			),
		);
		expect(error).toMatchObject({ _tag: "UnexpectedError", cause });
	});

	it("cancels the Chord context when the fiber is interrupted, and is interrupted itself, not failed", async () => {
		const pi = cancellable();
		const seen = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(call(pi.run), { startImmediately: true });
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
				yield* pi.cancelled;
				// The interruption waits until Pi settled the call.
				const waiting = interrupting.pollUnsafe() === undefined;
				pi.settle();
				yield* Fiber.join(interrupting);
				return { waiting, settled: pi.settled(), exit: yield* Fiber.await(fiber) };
			}),
		);
		expect(seen.waiting).toBe(true);
		expect(seen.settled).toBe(true);
		expect(Exit.isFailure(seen.exit) && Cause.hasInterruptsOnly(seen.exit.cause)).toBe(true);
	});

	it("runs under the parent context it is given: its values carry over, and its cancellation cancels the call", async () => {
		const key = createContextKey<string>("test.trace");
		const { context: parent, cancel } = withCancel(withContextValue(key, "trace-1", BACKGROUND_CONTEXT));
		const value = await Effect.runPromise(call(async (context) => context.value(key), parent));
		expect(value).toBe("trace-1");
		const pi = cancellable();
		pi.settle();
		const failure = await runTest(
			Effect.gen(function* () {
				// Started at once, the call is with Pi when its fork returns.
				const fiber = yield* Effect.forkChild(Effect.flip(call(pi.run, parent)), { startImmediately: true });
				cancel(new DOMException("The invocation was aborted", "AbortError"));
				return yield* Fiber.join(fiber);
			}),
		);
		expect(failure._tag).toBe("Cancelled");
	});

	it("fails with Cancelled when Pi cancels a call the fiber did not interrupt", async () => {
		const error = await Effect.runPromise(
			Effect.flip(call(() => Promise.reject(new DOMException("The operation was aborted", "AbortError")))),
		);
		expect(error._tag).toBe("Cancelled");
	});
});

describe("ParentContext", () => {
	it("is Chord's background context unless a host provides another", async () => {
		expect(await Effect.runPromise(Effect.service(ParentContext))).toBe(BACKGROUND_CONTEXT);
		const seen = await Effect.runPromise(call(async (context) => context.abortSignal?.aborted));
		expect(seen).toBe(false);
	});

	it("carries a host's context into every Pi call of the fibers it is provided to", async () => {
		const key = createContextKey<string>("test.span");
		const host = withContextValue(key, "span-of-the-request", BACKGROUND_CONTEXT);
		const seen = await Effect.runPromise(
			Effect.all([call(async (context) => context.value(key)), call(async (context) => context.value(key))], {
				concurrency: 2,
			}).pipe(Effect.provideService(ParentContext, host)),
		);
		expect(seen).toEqual(["span-of-the-request", "span-of-the-request"]);
	});

	it("fails a call with Cancelled when the host's context is past its deadline", async () => {
		const deadline = new AbortController();
		const host = withAbortSignal(deadline.signal, BACKGROUND_CONTEXT);
		const pi = cancellable();
		pi.settle();
		const failure = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Effect.flip(call(pi.run)).pipe(Effect.provideService(ParentContext, host)),
					{ startImmediately: true },
				);
				// What `AbortSignal.timeout` does once its time is up.
				deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
				return yield* Fiber.join(fiber);
			}),
		);
		expect(failure._tag).toBe("Cancelled");
		expect(failure).toMatchObject({ cause: { name: "TimeoutError" } });
	});

	it("gives way to a parent passed to the call itself", async () => {
		const key = createContextKey<string>("test.span");
		const host = withContextValue(key, "host", BACKGROUND_CONTEXT);
		const invocation = withContextValue(key, "invocation", BACKGROUND_CONTEXT);
		const seen = await Effect.runPromise(
			call(async (context) => context.value(key), invocation).pipe(Effect.provideService(ParentContext, host)),
		);
		expect(seen).toBe("invocation");
	});
});

describe("step", () => {
	it("succeeds with what Pi's transaction resolves, and fails with the tagged error of a rejection", async () => {
		expect(await Effect.runPromise(step(async () => 7))).toBe(7);
		const failure = await Effect.runPromise(
			Effect.flip(step(() => Promise.reject(new PiConversationBusy(3 as ConversationId)))),
		);
		expect(failure).toMatchObject({ _tag: "ConversationBusy", conversationId: 3 });
	});

	it("waits for Pi to settle the call when the fiber is interrupted", async () => {
		const settle = Promise.withResolvers<void>();
		let settled = false;
		const waiting = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					step(async () => {
						await settle.promise;
						settled = true;
					}),
					{ startImmediately: true },
				);
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
				const waiting = interrupting.pollUnsafe() === undefined;
				settle.resolve();
				yield* Fiber.join(interrupting);
				return waiting;
			}),
		);
		expect(waiting).toBe(true);
		expect(settled).toBe(true);
	});
});
