import { Effect, Exit, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { fromIterable, toIterable } from "../src/iterable.ts";
import { run } from "./run.ts";

class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}

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
		const [values, failure] = await run(
			Effect.gen(function* () {
				const ok = yield* toIterable(Stream.make(1, 2));
				const values = yield* Effect.promise(() => collect(ok.iterable));
				const broken = yield* toIterable(Stream.fail(new Broken()));
				yield* Effect.promise(() => collect(broken.iterable).catch(() => []));
				return [values, broken.failure()] as const;
			}),
		);
		expect(values).toEqual([1, 2]);
		expect(failure).toEqual(Option.some(new Broken()));
	});
});

/** Every value of `iterable`. */
async function collect<A>(iterable: AsyncIterable<A>): Promise<A[]> {
	const values: A[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}
