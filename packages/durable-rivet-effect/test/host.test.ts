// The registry record of this package's actors. `serve` itself needs an engine: engine.test.ts starts one through it.

import { describe, expect, it } from "vitest";
import { Host } from "../src/index.ts";
import * as ExitGuard from "../src/node/exit-guard.ts";
import { Agent } from "./agent.ts";

describe("Host.use", () => {
	it("gives each actor's rivetkit definition under the name it was made with", () => {
		const other = { name: "other", actions: {}, rivet: Agent.rivet };
		expect(Host.use([Agent, other])).toEqual({ agent: Agent.rivet, other: Agent.rivet });
	});
});

describe("Host.holdBackExit", () => {
	it("is the exit guard that is kept for good", () => {
		// What it does is asked of a process of its own: exit-guard.test.ts.
		expect(Host.holdBackExit).toBe(ExitGuard.keep);
	});
});
