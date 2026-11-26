import * as PiAgentCore from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What this package does with every value pi-agent-core exports. */
const COVERAGE = {
	Agent: replaced("Agent.make: a scoped agent whose runs are Effects and whose events are Streams"),
	agentLoop: replaced("AgentLoop.stream"),
	agentLoopContinue: replaced("AgentLoop.streamContinue"),
	runAgentLoop: replaced("AgentLoop.stream for the events, AgentLoop.run for the messages"),
	runAgentLoopContinue: replaced("AgentLoop.streamContinue for the events, AgentLoop.runContinue for the messages"),
	runToolCall: replaced("runToolCall"),
	streamProxy: replaced("StreamFn.proxy"),
	setDefaultStreamFn: replaced("StreamFn: the stream function is a service of the program, not a global default"),
	DEFAULT_AGENT_IDENTITY: offered,
} satisfies Record<keyof typeof PiAgentCore, Coverage>;

describe("the coverage of pi-agent-core", () => {
	it("offers every value it records as offered, Pi's own and not copies", () => {
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !(name in Package))
			.map(([name]) => name);
		expect(missing).toEqual([]);
		expect(Package.DEFAULT_AGENT_IDENTITY).toBe(PiAgentCore.DEFAULT_AGENT_IDENTITY);
	});

	it("has every Effect form it names", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"Agent",
			"AgentBusy",
			"AgentLoop",
			"CannotContinue",
			"DEFAULT_AGENT_IDENTITY",
			"SchemaConversionError",
			"StreamFn",
			"Tool",
			"runToolCall",
		]);
		expect(Object.keys(Package.Agent).sort()).toEqual(["make"]);
		expect(Object.keys(Package.AgentLoop).sort()).toEqual(["run", "runContinue", "stream", "streamContinue"]);
		expect(Object.keys(Package.Tool).sort()).toEqual(["error", "make", "result"]);
		expect([typeof Package.StreamFn.models, typeof Package.StreamFn.proxy]).toEqual(["object", "function"]);
	});
});
