// The agent change of a swarm's forks as it crosses to a thread actor: what `ForkAgent.toWire` makes of a change.

import { Extension, Tool } from "@gunta/pi-durable-effect";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ForkAgent } from "../src/rivet.ts";

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: ({ id }) => Effect.succeed(`Record ${id}`),
});

const Office = Extension.make({ name: "office", tools: [Lookup] });

const crossed = (agent: ForkAgent.ForkAgent) => Effect.runPromise(ForkAgent.toWire("t1/covers-1", agent));

describe("an agent change as it crosses", () => {
	it("is the model, the level, the instructions and the turns as they are, and tools and extensions by name", async () => {
		const wire = await crossed({
			model: { provider: "router", modelId: "cheap" },
			thinkingLevel: "low",
			instructions: "Answer briefly.",
			maxTurns: 3,
			extensions: [Office, "search"],
			tools: [Lookup, "write_note"],
			modelTools: { add: [Lookup], remove: ["write_note"] },
		});
		expect(wire).toEqual({
			model: { provider: "router", modelId: "cheap" },
			thinkingLevel: "low",
			instructions: "Answer briefly.",
			maxTurns: 3,
			extensions: ["office", "search"],
			tools: ["lookup", "write_note"],
			modelTools: { add: ["lookup"], remove: ["write_note"] },
		});
		// Plain JSON: it is the action's input after a trip through text.
		expect(Schema.decodeUnknownSync(ForkAgent.Wire)(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
	});

	it("keeps a cleared field cleared and an absent one absent, and an edit of a selection as an edit", async () => {
		expect(await crossed({})).toEqual({});
		expect(await crossed({ model: null, instructions: null, tools: null })).toEqual({
			model: null,
			instructions: null,
			tools: null,
		});
		expect(await crossed({ tools: { remove: [Lookup] }, extensions: { remove: ["review"] } })).toEqual({
			tools: { remove: ["lookup"] },
			extensions: { remove: ["review"] },
		});
	});

	it("does not cross when it is no data of that shape, and leaves out what the type does not have", async () => {
		const refused = await Effect.runPromise(Effect.flip(ForkAgent.toWire("t1/covers-1", { maxTurns: 0 })));
		expect(refused).toMatchObject({ _tag: "InvalidPlan", swarmId: "t1/covers-1" });
		expect(refused.message).toContain("The agent change of the forks cannot cross");
		// Only a cast lets a field of `Agent.Change` that is not `ForkAgent`'s through: it stays with the caller.
		const wider = { maxTurns: 2, cwd: "/tmp" } as ForkAgent.ForkAgent;
		expect(await crossed(wider)).toEqual({ maxTurns: 2 });
	});
});
