import { describe, expect, it } from "vitest";
import * as Package from "../src/index.ts";

describe("the public surface", () => {
	it("exports the declaration, the extension, the port, the child document, the errors and the storage-fork step", () => {
		expect(Object.keys(Package).toSorted()).toEqual([
			"Child",
			"ChildSetup",
			"ChildSetupFailed",
			"DepthExceeded",
			"ResultMismatch",
			"Subagent",
			"Subagents",
			"TooManyChildren",
			"UnknownSubagent",
			"onStorageFork",
		]);
		expect(Object.keys(Package.Subagent).toSorted()).toEqual(["DEFAULT_CORRECTIONS", "exactly", "make", "result"]);
		expect(Object.keys(Package.Subagents).toSorted()).toEqual(["EXTENSION", "REPORT", "TASK", "TOOLS", "extension"]);
		expect(Object.keys(Package.ChildSetup).toSorted()).toEqual(["ChildSetup", "none"]);
		expect(Object.keys(Package.Child).toSorted()).toEqual(["Document", "Mode", "Record", "State", "key"]);
	});

	it("names its extension, its tools, its task and its documents with its own prefix", () => {
		expect(Package.Subagents.EXTENSION).toBe("subagent");
		expect(Package.Subagents.TOOLS).toEqual({
			foreground: "subagent",
			background: "subagent_start",
			status: "subagent_status",
		});
		expect([Package.Subagents.TASK, Package.Subagents.REPORT]).toEqual(["subagent.run", "subagent.report"]);
		expect(Package.Child.Document.kind).toBe("subagent.child");
	});

	it("says in each error what the parent's model should do", () => {
		expect(new Package.DepthExceeded({ depth: 2, maxDepth: 2 }).message).toBe(
			"Subagents may nest 2 deep at most, and this agent is at depth 2: do the task yourself",
		);
		expect(new Package.TooManyChildren({ live: 3, maxLive: 3 }).message).toBe(
			"This agent already has as many subagents at work as it may have (3): wait for one to finish",
		);
		expect(new Package.ChildSetupFailed({ reason: "No grant." }).message).toBe(
			"The subagent could not be set up: No grant.",
		);
	});
});
