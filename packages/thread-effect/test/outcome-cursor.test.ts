// The stored delivery cursor of a thread's outcome events: what it decodes, also as earlier versions wrote it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { OutcomeCursor } from "../src/index.ts";

describe("the stored cursor", () => {
	it("keeps the time of the next attempt as it is: a schedule's delay may be a fraction of a millisecond", async () => {
		// As 0.2.0 stored it after a failed attempt under `Schedule.spaced("1500 micros")`.
		const stored = {
			delivered: null,
			pending: null,
			courier: 3,
			stamp: 2,
			waiting: "outcome-1",
			retryAt: 1_764_000_000_001.5,
		};
		const decoded = await Effect.runPromise(OutcomeCursor.Document.decode(stored));
		expect(decoded).toEqual(stored);
	});
});
