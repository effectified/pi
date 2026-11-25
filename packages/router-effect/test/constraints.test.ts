import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { constraintsFromMetadata, constraintsToMetadata, METADATA_KEY } from "../src/index.ts";

describe("constraintsToMetadata", () => {
	it("puts the constraints under the router's metadata key", () => {
		expect(METADATA_KEY).toBe("pi-router");
		expect(constraintsToMetadata({ classification: "internal", regions: ["eu", "jp"] })).toEqual({
			"pi-router": { classification: "internal", regions: ["eu", "jp"] },
		});
		expect(constraintsToMetadata({ requires: ["zero-data-retention", "batch"] })).toEqual({
			"pi-router": { requires: ["zero-data-retention", "batch"] },
		});
	});

	it("leaves out what the request does not say", () => {
		expect(constraintsToMetadata({ regions: ["eu"] })).toEqual({ "pi-router": { regions: ["eu"] } });
		expect(constraintsToMetadata({})).toEqual({ "pi-router": {} });
	});
});

describe("constraintsFromMetadata", () => {
	it("reads back what constraintsToMetadata wrote, beside other metadata", async () => {
		const constraints = { classification: "secret", regions: ["eu"], requires: ["zero-data-retention"] };
		const metadata = { user_id: "u1", ...constraintsToMetadata(constraints) };
		expect(await Effect.runPromise(constraintsFromMetadata("fast", metadata))).toEqual(constraints);
	});

	it("is undefined for a request without metadata or without the key", async () => {
		expect(await Effect.runPromise(constraintsFromMetadata("fast", undefined))).toBeUndefined();
		expect(await Effect.runPromise(constraintsFromMetadata("fast", { user_id: "u1" }))).toBeUndefined();
	});

	it("fails with InvalidConstraints for a value that is not constraints, never with a default", async () => {
		const regions = await Effect.runPromise(
			Effect.flip(constraintsFromMetadata("fast", { "pi-router": { regions: "eu" } })),
		);
		expect(regions._tag).toBe("InvalidConstraints");
		expect(regions.alias).toBe("fast");
		expect(regions.reason).toMatch(/^metadata\["pi-router"\]: /);
		expect(regions.reason).toContain('["regions"]');
		expect(regions.message).toBe(`The constraints of a request to alias "fast" are not usable: ${regions.reason}`);

		const text = await Effect.runPromise(Effect.flip(constraintsFromMetadata("fast", { "pi-router": "secret" })));
		expect(text._tag).toBe("InvalidConstraints");
		const label = await Effect.runPromise(
			Effect.flip(constraintsFromMetadata("fast", { "pi-router": { classification: 3 } })),
		);
		expect(label.reason).toContain('["classification"]');
		// A required label is checked as a table's labels are: not empty, no white space.
		const required = await Effect.runPromise(
			Effect.flip(constraintsFromMetadata("fast", { "pi-router": { requires: ["zero data retention"] } })),
		);
		expect(required._tag).toBe("InvalidConstraints");
		expect(required.reason).toContain('["requires"][0]');
	});
});
