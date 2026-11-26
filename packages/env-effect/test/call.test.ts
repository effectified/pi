import type { Result } from "@earendil-works/pi-durable/env";
import { runLive } from "@effectified/pi-ai/testing";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { Deferred, Effect, Exit, Fiber, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { abortable, result, unabortable } from "../src/call.ts";

describe("result", () => {
	it("succeeds with Pi's value and fails with its error result", async () => {
		const ok = await runLive(result(async () => ({ ok: true, value: 42 }), String));
		const failed = await runLive(
			Effect.exit(
				result(
					async () => ({ ok: false, error: 7 }),
					(n: number) => `e${n}`,
				),
			),
		);
		expect(ok).toBe(42);
		expect(failed).toEqual(Exit.fail("e7"));
	});

	it("dies when Pi rejects: an environment returns its failures", async () => {
		const exit = await runLive(Effect.exit(result(() => Promise.reject(new Error("bug")), String)));
		expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true);
	});

	it("gives the call a Chord context that interruption aborts", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const started = yield* Deferred.make<AbortSignal>();
				const fiber = yield* Effect.forkChild(
					result(
						(context) =>
							new Promise<Result<number, string>>((resolve) => {
								Deferred.doneUnsafe(started, Exit.succeed(context.abortSignal!));
								context.abortSignal!.addEventListener("abort", () => resolve({ ok: true, value: 0 }));
							}),
						String,
					),
					{ startImmediately: true },
				);
				const signal = yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				return signal.aborted;
			}),
		);
		expect(seen).toBe(true);
	});

	it("runs the call under the fiber's current span, so the spans Pi starts are its children", async () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		await runLive(
			result(
				(context) => context.telemetry.startSpan({ name: "pi.env.read" }, async () => ({ ok: true, value: 0 })),
				String,
			).pipe(
				Effect.withSpan("app.read"),
				Effect.provide(PiTelemetry.layer),
				Effect.provideService(Tracer.Tracer, tracer),
			),
		);
		expect(spans.map((span) => [span.name, Option.getOrUndefined(span.parent)?.spanId])).toEqual([
			["app.read", undefined],
			["pi.env.read", spans[0]?.spanId],
		]);
	});
});

describe("abortable", () => {
	it("waits until Pi settled the aborted call before the interruption completes", async () => {
		const order: string[] = [];
		await runLive(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					abortable(
						(signal) =>
							new Promise<number>((resolve) => {
								Deferred.doneUnsafe(started, Exit.void);
								signal.addEventListener("abort", () =>
									queueMicrotask(() => {
										order.push("pi settled");
										resolve(0);
									}),
								);
							}),
						Effect.die,
					),
					{ startImmediately: true },
				);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				order.push("interrupted");
			}),
		);
		expect(order).toEqual(["pi settled", "interrupted"]);
	});

	it("turns a rejection into the failure `onRejection` gives", async () => {
		const exit = await runLive(
			Effect.exit(
				abortable(
					() => Promise.reject(new Error("refused")),
					(cause) => Effect.fail(String(cause)),
				),
			),
		);
		expect(exit).toEqual(Exit.fail("Error: refused"));
	});
});

describe("unabortable", () => {
	it("stops waiting at once when interrupted; Pi's call goes on", async () => {
		const pending = Promise.withResolvers<number>();
		const exit = await runLive(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					unabortable(() => pending.promise, String),
					{ startImmediately: true },
				);
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		pending.resolve(1);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});

	it("maps a rejection with `onRejection`", async () => {
		const exit = await runLive(
			Effect.exit(
				unabortable(
					() => Promise.reject(new Error("x")),
					() => "mapped",
				),
			),
		);
		expect(exit).toEqual(Exit.fail("mapped"));
	});
});
