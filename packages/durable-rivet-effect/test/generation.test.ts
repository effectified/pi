// One wake's scoped runtime: what a Layer builds, what runs on it, and that closing leaves nothing behind.

import { Context, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as Generation from "../src/generation.ts";

class Counter extends Context.Service<Counter, { readonly next: () => number }>()("test/Counter") {}

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

describe("Generation.open", () => {
	it("builds the Layer once and runs Effects on what it built", async () => {
		const log: string[] = [];
		const generation = await Effect.runPromise(Generation.open(counter(log)));
		const next = Counter.use((service) => Effect.sync(service.next));
		expect(await generation.run(next)).toEqual(Exit.succeed(1));
		expect(await generation.run(next)).toEqual(Exit.succeed(2));
		expect(await generation.run(Effect.fail("no"))).toEqual(Exit.fail("no"));
		expect(log).toEqual(["built"]);
		await Effect.runPromise(generation.close);
		expect(log).toEqual(["built", "released"]);
	});

	it("interrupts what still runs, waits for it, and only then closes the scope", async () => {
		const log: string[] = [];
		const generation = await Effect.runPromise(Generation.open(counter(log)));
		const started = Promise.withResolvers<void>();
		const running = generation.run(
			Effect.onInterrupt(
				Effect.andThen(
					Effect.sync(() => started.resolve()),
					Effect.never,
				),
				() => Effect.sync(() => log.push("handler interrupted")),
			),
		);
		await started.promise;
		await Effect.runPromise(generation.close);
		expect(log).toEqual(["built", "handler interrupted", "released"]);
		expect(Exit.isFailure(await running)).toBe(true);
	});

	it("fails with the Layer's failure and leaves nothing open", async () => {
		const log: string[] = [];
		const failing = Layer.effectDiscard(Effect.fail("cannot open")).pipe(Layer.provideMerge(counter(log)));
		expect(await Effect.runPromise(Effect.flip(Generation.open(failing)))).toBe("cannot open");
		expect(log).toEqual(["built", "released"]);
	});
});
