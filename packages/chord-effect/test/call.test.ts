import { ChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context, withContextValue } from "@earendil-works/chord/context";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { attempt, chordCall, chordSync, storeRejection } from "../src/call.ts";
import { createContextKey } from "../src/context.ts";
import { ChordFailed, SqliteError } from "../src/errors.ts";
import { ParentContext } from "../src/parent-context.ts";
import { run } from "./run.ts";

describe("chordCall", () => {
	it("succeeds with what Chord resolves, and fails a ChordError as ChordFailed", async () => {
		const [value, exit] = await run(
			Effect.all([
				chordCall(async () => "done"),
				Effect.exit(
					chordCall(() =>
						Promise.reject(new ChordError({ code: "released", reason: "closed", message: "closed" })),
					),
				),
			]),
		);
		expect(value).toBe("done");
		expect(exit).toEqual(Exit.fail(new ChordFailed({ code: "released", reason: "closed", message: "closed" })));
	});

	it("makes anything else Chord's runtime rejects with a defect", async () => {
		const exit = await run(Effect.exit(chordCall(() => Promise.reject(new TypeError("bug")))));
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag).toBe("Die");
	});

	it("keeps the values of the fiber's ParentContext", async () => {
		const key = createContextKey<string>("example.tenant");
		const tenant = await run(
			Effect.provideService(
				chordCall(async (context) => context.value(key)),
				ParentContext,
				withContextValue(key, "acme", BACKGROUND_CONTEXT),
			),
		);
		expect(tenant).toBe("acme");
	});

	it("aborts the call when the fiber is interrupted, and waits until Chord settled it", async () => {
		const settled = await run(
			Effect.gen(function* () {
				const started = yield* Deferred.make<Context>();
				let settled = false;
				const fiber = yield* Effect.forkChild(
					chordCall(
						(context) =>
							new Promise<never>((_, reject) => {
								Deferred.doneUnsafe(started, Exit.succeed(context));
								context.abortSignal?.addEventListener("abort", () => {
									setTimeout(() => {
										settled = true;
										reject(new ChordError({ code: "aborted", message: "aborted" }));
									}, 0);
								});
							}),
					),
					{ startImmediately: true },
				);
				const context = yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				return [context.abortSignal?.aborted, settled];
			}),
		);
		expect(settled).toEqual([true, true]);
	});
});

describe("attempt and storeRejection", () => {
	it("fails what the database rejects with as SqliteError", async () => {
		const cause = new Error("disk full");
		const exit = await run(Effect.exit(attempt(() => Promise.reject(cause), storeRejection)));
		expect(exit).toEqual(Exit.fail(new SqliteError({ cause })));
	});
});

describe("chordSync", () => {
	it("fails what a synchronous Chord call throws as its tag", async () => {
		const exit = await run(
			Effect.exit(
				chordSync(() => {
					throw new ChordError({ code: "not_ready", message: "before load" });
				}),
			),
		);
		expect(exit).toEqual(Exit.fail(new ChordFailed({ code: "not_ready", message: "before load" })));
	});
});
