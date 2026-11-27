import { Effect, Exit, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { fromIterable, toIterable } from "../src/iterable.ts";
import { run } from "./run.ts";

class Broken extends Schema.TaggedError<Broken, { readonly brand: unique symbol }>()("Broken", {}) {}

describe("fromIterable", () => {
	it("streams what the iterable yields, and aborts its context when the stream ends early", async () => {
		let signal: AbortSignal | undefined;
		const taken = await run(
			Stream.runCollect(
				Stream.take(
					fromIterable((context) => {
						signal = context.abortSignal;
						return (async function* () {
							yield* [1, 2, 3];
						})();
					}, Effect.die),
					2,
				),
			),
		);
		expect(taken).toEqual([1, 2]);
		expect(signal?.aborted).toBe(true);
	});

	it("hands what the iterable or its making throws to its rejection", async () => {
		const thrown = new Error("refused");
		const rejected = (cause: unknown) => Effect.fail(cause === thrown ? "mapped" : "other");
		const [making, iterating] = await run(
			Effect.all([
				Effect.exit(
					Stream.runCollect(
						fromIterable(() => {
							throw thrown;
						}, rejected),
					),
				),
				Effect.exit(
					Stream.runCollect(
						fromIterable(
							() =>
								(async function* () {
									yield 1;
									throw thrown;
								})(),
							rejected,
						),
					),
				),
			]),
		);
		expect(making).toEqual(Exit.fail("mapped"));
		expect(iterating).toEqual(Exit.fail("mapped"));
	});
});

describe("toIterable", () => {
	it("hands a Stream to Chord as an iterable, and keeps its failure apart", async () => {
		const [values, chord, failure] = await run(
			Effect.gen(function* () {
				const ok = yield* toIterable(Stream.make(1, 2));
				const values = yield* Effect.promise(() => collect(ok.iterable));
				// The Stream did not fail: a rejection of Chord's is what `otherwise` makes of it.
				const chord = yield* Effect.flip(ok.rejected(Effect.fail)("refused"));
				const broken = yield* toIterable(Stream.fail(Broken.make()));
				yield* Effect.promise(() => collect(broken.iterable).catch(() => []));
				// The Stream failed: Chord rejected with its failure, which wins.
				const failure = yield* Effect.flip(broken.rejected(Effect.die)("rejected"));
				return [values, chord, failure] as const;
			}),
		);
		expect(values).toEqual([1, 2]);
		expect(chord).toBe("refused");
		expect(failure).toEqual(Broken.make());
	});
});

/** Every value of `iterable`. */
async function collect<A>(iterable: AsyncIterable<A>): Promise<A[]> {
	const values: A[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}
