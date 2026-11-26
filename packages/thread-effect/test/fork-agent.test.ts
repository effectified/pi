// The agent change of a swarm's forks as it crosses to a thread actor: what `ForkAgent.toWire` makes of a change.

import { Extension, Registry, Tool } from "@effectified/pi-durable";
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

	it("is the working directory and the compaction settings as they are", async () => {
		const compaction = {
			enabled: true,
			reserveTokens: 2_000,
			keepRecentTokens: 0,
			modelOverrides: { "router/cheap": { enabled: false, backgroundTokens: 500 } },
		};
		const wire = await crossed({ cwd: "/work/covers", compaction });
		expect(wire).toEqual({ cwd: "/work/covers", compaction });
		expect(Schema.decodeUnknownSync(ForkAgent.Wire)(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
	});

	it("keeps a cleared field cleared and an absent one absent, and an edit of a selection as an edit", async () => {
		expect(await crossed({})).toEqual({});
		expect(await crossed({ model: null, instructions: null, tools: null, cwd: null, compaction: null })).toEqual({
			model: null,
			instructions: null,
			tools: null,
			cwd: null,
			compaction: null,
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
		// Only a cast lets a field through that `Agent.Change` does not have: it stays with the caller.
		const wider = { maxTurns: 2, owner: "covers" } as ForkAgent.ForkAgent;
		expect(await crossed(wider)).toEqual({ maxTurns: 2 });
	});

	it("does not cross with a token count of its compaction that Pi's configure would refuse", async () => {
		// Pi throws a `RangeError` in the fork's creating commit for each of these: the fork would never exist.
		const refusedFor = (compaction: NonNullable<ForkAgent.ForkAgent["compaction"]>) =>
			Effect.runPromise(Effect.flip(ForkAgent.toWire("t1/covers-1", { compaction })));
		for (const compaction of [
			{ reserveTokens: -1 },
			{ keepRecentTokens: 1.5 },
			{ modelOverrides: { "router/cheap": { backgroundTokens: Number.POSITIVE_INFINITY } } },
		]) {
			expect(await refusedFor(compaction)).toMatchObject({ _tag: "InvalidPlan", swarmId: "t1/covers-1" });
		}
	});
});

describe("an agent change held against the registry of the actor", () => {
	const held = (agent: ForkAgent.Wire) =>
		Effect.runPromise(
			Effect.result(ForkAgent.requireInstalled("t1/covers-1", agent)).pipe(
				Effect.provide(Registry.layer([Office])),
				Effect.map((result) => (result._tag === "Success" ? "installed" : result.failure.reason)),
			),
		);

	it("passes when every name is installed, and when it names nothing", async () => {
		expect(await held({})).toBe("installed");
		expect(await held({ model: null, tools: null, extensions: null, modelTools: null })).toBe("installed");
		expect(
			await held({ extensions: ["office"], tools: ["lookup"], modelTools: { add: ["lookup"], remove: ["lookup"] } }),
		).toBe("installed");
	});

	it("names every tool and extension nothing is installed under, in a list and in an edit", async () => {
		expect(await held({ tools: ["lookup", "lokup"] })).toBe("Nothing is installed under: tool lokup");
		expect(await held({ tools: { remove: ["lokup"] } })).toBe("Nothing is installed under: tool lokup");
		expect(
			await held({ modelTools: { add: ["a"], remove: ["b"] }, extensions: { add: ["c"], remove: ["office"] } }),
		).toBe("Nothing is installed under: extension c, tool a, tool b");
		// A tool's name is no extension's, and the reverse.
		expect(await held({ tools: ["office"], extensions: ["lookup"] })).toBe(
			"Nothing is installed under: extension lookup, tool office",
		);
	});
});
