// pi-ai's UUIDv7 with the time of Clock.

import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

/** The millisecond timestamp in the first 48 bits of a UUIDv7. */
const timestampOf = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

describe("uuidv7", () => {
	it("stamps ids with the clock's time, unique and in order within one millisecond", async () => {
		const ids = await runTest(
			Effect.gen(function* () {
				yield* TestClock.adjust(1234);
				return [yield* uuidv7, yield* uuidv7];
			}),
		);
		expect(ids.map(timestampOf)).toEqual([1234, 1234]);
		expect(ids[0]).not.toBe(ids[1]);
		expect([...ids].sort()).toEqual(ids);
		expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
