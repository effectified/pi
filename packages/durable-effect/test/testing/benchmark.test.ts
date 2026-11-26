import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Storage } from "../../src/index.ts";
import { Benchmark, STORAGE_MEMORY_SCALES, storageBenchmarkPrimaryRecordCount } from "../../src/testing/index.ts";

const SMALL = { name: "small", entryCount: 50, taskCount: 10, documentCount: 10 };

describe("Benchmark", () => {
	it("seeds a storage at Pi's timing scale and every read sample finds what it expects", async () => {
		const found = await Effect.runPromise(
			Effect.gen(function* () {
				// Pi's timing scale: the read samples page over at least 100 entries.
				const dataset = yield* Benchmark.seed();
				return yield* Effect.forEach(Benchmark.reads, (sample) =>
					Effect.map(sample.run(dataset), (value) => [sample.name, value === sample.expected(dataset)] as const),
				);
			}).pipe(Effect.provide(Storage.memory)),
		);
		expect(found.length).toBeGreaterThan(0);
		expect(found.filter(([, ok]) => !ok)).toEqual([]);
	});

	it("seeds the write state and every write sample reports what it expects", async () => {
		const reported = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Benchmark.seedWrites;
				return yield* Effect.forEach(Benchmark.writes, (sample) =>
					Effect.map(sample.run, (count) => [sample.name, count === sample.expected] as const),
				);
			}).pipe(Effect.provide(Storage.memory)),
		);
		expect(reported.filter(([, ok]) => !ok)).toEqual([]);
	});

	it("offers Pi's scales and the count of a scale's primary records", () => {
		expect(STORAGE_MEMORY_SCALES.map((scale) => scale.name)).toEqual(["1k", "10k"]);
		expect(storageBenchmarkPrimaryRecordCount(SMALL)).toBeGreaterThan(70);
	});
});
