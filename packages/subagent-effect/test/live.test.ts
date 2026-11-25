import { Task } from "@gunta/pi-durable-effect";
import { describe, expect, it } from "vitest";
import { LIVE } from "../src/live.ts";

describe("LIVE", () => {
	it("is every status Pi has not settled, completing included although its outcome is decided", () => {
		expect([...LIVE].sort()).toEqual(["completing", "pending", "running", "sleeping", "waiting"]);
		// The one status at work whose task has ended: its run's child may still be running.
		expect(LIVE.filter((status) => Task.ended(status))).toEqual(["completing"]);
	});
});
