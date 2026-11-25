// Which stop reasons answered: Pi Durable's rule, one entry per stop reason of pi-ai.

import { describe, expect, it } from "vitest";
import { ANSWERED } from "../src/index.ts";

describe("ANSWERED", () => {
	it("holds for stop, length and toolUse only", () => {
		const answered = Object.entries(ANSWERED).flatMap(([reason, yes]) => (yes ? [reason] : []));
		expect(answered.sort()).toEqual(["length", "stop", "toolUse"]);
	});

	it("does not hold for a failed, aborted, partial or deferred response", () => {
		expect([ANSWERED.error, ANSWERED.aborted, ANSWERED.pending, ANSWERED.deferred]).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});
