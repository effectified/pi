import { describe, expect, it } from "vitest";
import { InvalidPlan, InvalidValue, SwarmFaulted, SwarmIdTaken, SwarmNotFound } from "../src/errors.ts";
import { SwarmId } from "../src/ids.ts";

describe("the failures of the host operations", () => {
	it("are tagged errors whose messages say what failed", () => {
		const errors = [
			new InvalidPlan({ swarmId: SwarmId.make("s"), reason: "Two jobs have the same key" }),
			new SwarmIdTaken({ swarmId: SwarmId.make("s"), heldBy: "measure" }),
			new SwarmNotFound({ swarmId: SwarmId.make("s") }),
			new SwarmFaulted({ swarmId: SwarmId.make("s"), reason: "copied" }),
			new InvalidValue({ what: "result", issues: "Expected number" }),
		];
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			["InvalidPlan", "Swarm s cannot start: Two jobs have the same key"],
			["SwarmIdTaken", "Swarm id s is held by a swarm of measure"],
			["SwarmNotFound", "No swarm s"],
			["SwarmFaulted", "Swarm s ended without a result: copied"],
			["InvalidValue", "The job result does not match its schema: Expected number"],
		]);
		expect(errors.every((error) => error instanceof Error)).toBe(true);
	});
});
