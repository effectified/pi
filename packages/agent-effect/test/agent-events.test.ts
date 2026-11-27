import type { AgentEvent, AgentMessage } from "@effectified/pi-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { AgentEvents } from "../src/index.ts";

const user: AgentMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };

describe("AgentEvents.messages", () => {
	it("is the messages of the agent_end event that ends a run", async () => {
		const events: AgentEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message: user },
			{ type: "message_end", message: user },
			{ type: "agent_end", messages: [user] },
		];
		const messages = await runTest(Stream.run(Stream.fromIterable(events), AgentEvents.messages));
		expect(messages).toEqual([user]);
	});

	it("is a defect for events that end without agent_end", async () => {
		const exit = await runTest(
			Effect.exit(Stream.run(Stream.fromIterable<AgentEvent>([{ type: "agent_start" }]), AgentEvents.messages)),
		);
		expect(Exit.hasDies(exit)).toBe(true);
	});
});
