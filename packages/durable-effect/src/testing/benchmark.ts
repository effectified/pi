// Pi Durable's storage benchmarks on the storage of the context: seeding a storage directly, and the read and write
// samples, each an Effect.

import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import {
	commitWrites as piCommitWrites,
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
	type StorageBenchmarkDataset,
	type StorageBenchmarkScale,
	seedStorageBenchmark,
	seedStorageWriteBenchmark,
} from "@earendil-works/pi-durable/testing";
import type { Effect } from "effect";
import { call } from "../call.ts";
import type { DurableError } from "../errors.ts";
import { HarnessStorage } from "../storage.ts";

/**
 * Commits `writes` to the storage of the context as one batch, straight through Pi's storage contract with no harness:
 * for seeding a storage. Succeeds with the batch's seq; fails with the storage's refusal.
 */
export function commitWrites(writes: ReadonlyArray<StorageWrite>): Effect.Effect<Seq, DurableError, HarnessStorage> {
	return HarnessStorage.use((storage) => call((context) => piCommitWrites(storage, writes, context)));
}

/** Seeds the storage of the context with Pi's deterministic benchmark data at `scale` (Pi's `TIMING_SCALE` by default). */
export function seed(
	scale?: StorageBenchmarkScale,
): Effect.Effect<StorageBenchmarkDataset, DurableError, HarnessStorage> {
	return HarnessStorage.use((storage) => call(() => seedStorageBenchmark(storage, scale)));
}

/** Seeds the storage of the context with the state every write sample expects. */
export const seedWrites: Effect.Effect<void, DurableError, HarnessStorage> = HarnessStorage.use((storage) =>
	call(() => seedStorageWriteBenchmark(storage)),
);

/** One read sample: what it reads from a seeded storage, and the value it must find. */
export interface ReadSample {
	readonly name: string;
	readonly run: (dataset: StorageBenchmarkDataset) => Effect.Effect<number, DurableError, HarnessStorage>;
	readonly expected: (dataset: StorageBenchmarkDataset) => number;
}

/** Pi's read samples (`STORAGE_READ_BENCHMARKS`). */
export const reads: ReadonlyArray<ReadSample> = STORAGE_READ_BENCHMARKS.map((sample) => ({
	name: sample.name,
	run: (dataset) => HarnessStorage.use((storage) => call(() => sample.run(storage, dataset))),
	expected: (dataset) => sample.expected(dataset),
}));

/** One write sample: what it writes to a storage seeded with `seedWrites`, and the count it must report. */
export interface WriteSample {
	readonly name: string;
	readonly expected: number;
	readonly run: Effect.Effect<number, DurableError, HarnessStorage>;
}

/** Pi's write samples (`STORAGE_WRITE_BENCHMARKS`). */
export const writes: ReadonlyArray<WriteSample> = STORAGE_WRITE_BENCHMARKS.map((sample) => ({
	name: sample.name,
	expected: sample.expected,
	run: HarnessStorage.use((storage) => call(() => sample.run(storage))),
}));
