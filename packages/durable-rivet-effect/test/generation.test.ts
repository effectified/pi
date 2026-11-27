// One wake's scoped runtime: what a Layer builds, what runs on it, and that closing leaves nothing behind.

import { runTest } from "@effectified/pi-ai/testing";
import { Context, Effect, Exit, Fiber, FiberSet, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Generation from "../src/generation.ts";

class Counter extends Context.Service<Counter, { readonly next: () => number }>()("test/Counter") {}

/** The context a Layer was built in, kept as a service. */
class Kept extends Context.Service<Kept, Context.Context<never>>()("test/Kept") {}

/** A Layer that records in `log` when it is built and when it is released. */
const counter = (log: string[]) =>
	Layer.effect(
		Counter,
		Effect.acquireRelease(
			Effect.sync(() => {
				log.push("built");
				let count = 0;
				return { next: () => ++count };
			}),
			() => Effect.sync(() => log.push("released")),
		),
	);

/** A handler that records its interruption in `log`, and never ends otherwise. */
const endless = (log: string[], name: string) =>
	Effect.onInterrupt(Effect.never, () => Effect.sync(() => log.push(`${name} interrupted`)));

describe("Generation.open", () => {
	it("builds the Layer once and runs Effects on what it built", () =>
		runTest(
			Effect.gen(function* () {
				const log: string[] = [];
				const generation = yield* Generation.open(counter(log));
				const next = Counter.use((service) => Effect.sync(service.next));
				const ran = <A, E>(effect: Effect.Effect<A, E, Counter>) =>
					Effect.flatMap(generation.run(effect), Fiber.await);
				expect(yield* ran(next)).toEqual(Exit.succeed(1));
				expect(yield* ran(next)).toEqual(Exit.succeed(2));
				expect(yield* ran(Effect.fail("no"))).toEqual(Exit.fail("no"));
				expect(log).toEqual(["built"]);
				yield* generation.close;
				expect(log).toEqual(["built", "released"]);
			}),
		));

	it("interrupts what still runs, waits for it, and only then closes the scope", () =>
		runTest(
			Effect.gen(function* () {
				const log: string[] = [];
				const generation = yield* Generation.open(counter(log));
				const running = yield* generation.run(endless(log, "handler"));
				yield* generation.close;
				expect(log).toEqual(["built", "handler interrupted", "released"]);
				expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
			}),
		));

	it("interrupts at once an Effect it is given after it closed", () =>
		runTest(
			Effect.gen(function* () {
				const generation = yield* Generation.open(counter([]));
				yield* generation.close;
				const late = yield* Fiber.await(yield* generation.run(Effect.succeed("ran")));
				expect(Exit.hasInterrupts(late)).toBe(true);
			}),
		));

	it("runs the work its Layer does while it closes, and interrupts the wake's work left after the Layer", () =>
		runTest(
			Effect.gen(function* () {
				const log: string[] = [];
				// A Layer with work on the wake's fibers: one piece runs until the wake ends, one when it is released.
				const working = Layer.effectDiscard(
					Effect.gen(function* () {
						const work = yield* Generation.Work;
						yield* FiberSet.run(work, endless(log, "work"));
						yield* Effect.addFinalizer(() =>
							Effect.flatMap(
								FiberSet.run(
									work,
									Effect.sync(() => log.push("work at close")),
								),
								Fiber.join,
							),
						);
					}),
				);
				const generation = yield* Generation.open(Layer.provideMerge(working, counter(log)));
				const running = yield* generation.run(endless(log, "handler"));
				yield* generation.close;
				expect(log).toEqual(["built", "handler interrupted", "work at close", "released", "work interrupted"]);
				expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
			}),
		));

	it("builds its Layer outside the span of the call that opened it: what a Layer keeps runs later under its own caller", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				// A context a Layer keeps for later work, as the swarm's driver and the thread's outcome delivery do.
				const keeping = Layer.effect(Kept, Effect.context<never>());
				const generation = yield* Generation.open(keeping).pipe(Effect.withSpan("call"));
				const kept = Context.get(generation.context, Kept);
				// The span of "call" has ended: later work on the kept context finds no span, or its own caller's.
				const alone = yield* Effect.provideContext(Effect.option(Effect.currentSpan), kept);
				const later = yield* Effect.provideContext(Effect.currentSpan, kept).pipe(Effect.withSpan("later"));
				yield* generation.close;
				return { alone, later: later.name };
			}),
		);
		expect(seen).toEqual({ alone: Option.none(), later: "later" });
	});

	it("fails with the Layer's failure and leaves nothing open", () =>
		runTest(
			Effect.gen(function* () {
				const log: string[] = [];
				const failing = Layer.effectDiscard(Effect.fail("cannot open")).pipe(Layer.provideMerge(counter(log)));
				expect(yield* Effect.flip(Generation.open(failing))).toBe("cannot open");
				expect(log).toEqual(["built", "released"]);
			}),
		));
});
