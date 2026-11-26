import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Storage } from "../../src/index.ts";
import { memory } from "../../src/storage/memory.ts";
import { storageConformance } from "../../src/testing/index.ts";

describe("memory", () => {
	it("is Storage.memory", () => {
		expect(memory).toBe(Storage.memory);
	});
});

describe("Pi's storage conformance on memory", () => {
	for (const testCase of Effect.runSync(storageConformance(memory, expect))) {
		it(testCase.name, () => Effect.runPromise(testCase.run));
	}
});
