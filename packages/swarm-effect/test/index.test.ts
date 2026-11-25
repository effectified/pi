import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Port from "../src/driver.ts";
import * as Package from "../src/index.ts";

describe("the public surface", () => {
	it("is the definition, the host operations, the driver port and the in-storage driver", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"ConversationForks",
			"Fork",
			"ForkDriver",
			"ForkGone",
			"ForkRetryLater",
			"ForkSetup",
			"ForkSetupFailed",
			"InvalidPlan",
			"InvalidValue",
			"JobState",
			"JobStatus",
			"Notice",
			"Place",
			"Reason",
			"Stored",
			"SwarmFaulted",
			"SwarmIdTaken",
			"SwarmNotFound",
			"cancel",
			"destroyFork",
			"events",
			"extension",
			"make",
			"named",
			"onStorageFork",
			"result",
			"start",
			"status",
			"typed",
		]);
		expect(Object.keys(Package.ConversationForks).sort()).toEqual(["attach", "layer"]);
		expect(Object.keys(Package.ForkSetup).sort()).toEqual(["ForkSetup", "none"]);
	});

	it("has the port on a subpath of its own, with the same values as the main entry", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.exports["./driver"]).toEqual({
			source: "./src/driver.ts",
			types: "./dist/driver.d.ts",
			import: "./dist/driver.js",
		});
		expect(Object.keys(Port).sort()).toEqual([
			"Fork",
			"ForkDriver",
			"ForkGone",
			"ForkRetryLater",
			"JobStatus",
			"Notice",
			"Place",
		]);
		expect(Port.ForkDriver).toBe(Package.ForkDriver);
		expect(Port.ForkGone).toBe(Package.ForkGone);
	});
});
