import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withAbortSignal,
	withCancel,
	withContextValue,
} from "@earendil-works/chord/context";
import { type ConversationId, ConversationBusy as PiConversationBusy } from "@earendil-works/pi-durable";
import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { call, ParentContext, step } from "../src/call.ts";

/** A Pi call that settles only when its context is cancelled, a little later, as Pi's waits do. */
function cancellable(onSettled: () => void): (context: Context) => Promise<never> {
	return (context) =>
		new Promise((_resolve, reject) => {
			context.abortSignal?.addEventListener("abort", () => {
				setTimeout(() => {
					onSettled();
					reject(context.abortSignal?.reason);
				}, 10);
			});
		});
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
		let settled = false;
		const fiber = Effect.runFork(
			call(
				cancellable(() => {
					settled = true;
				}),
			),
		);
		await Effect.runPromise(Effect.yieldNow);
		const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
		// The interruption waited until Pi had settled the call.
		expect(settled).toBe(true);
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
	});

	it("runs under the parent context it is given: its values carry over, and its cancellation cancels the call", async () => {
		const key = createContextKey<string>("test.trace");
		const { context: parent, cancel } = withCancel(withContextValue(key, "trace-1", BACKGROUND_CONTEXT));
		const value = await Effect.runPromise(call(async (context) => context.value(key), parent));
		expect(value).toBe("trace-1");
		const fiber = Effect.runFork(
			Effect.flip(
				call(
					cancellable(() => {}),
					parent,
				),
			),
		);
		await Effect.runPromise(Effect.yieldNow);
		cancel(new DOMException("The invocation was aborted", "AbortError"));
		expect((await Effect.runPromise(Fiber.join(fiber)))._tag).toBe("Cancelled");
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
		const deadline = AbortSignal.timeout(5);
		const host = withAbortSignal(deadline, BACKGROUND_CONTEXT);
		const failure = await Effect.runPromise(
			Effect.flip(call(cancellable(() => {}))).pipe(Effect.provideService(ParentContext, host)),
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
		const fiber = Effect.runFork(
			step(async () => {
				await settle.promise;
				settled = true;
			}),
		);
		await Effect.runPromise(Effect.yieldNow);
		setTimeout(() => settle.resolve(), 10);
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(settled).toBe(true);
	});
});
