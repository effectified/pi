import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Agent, Extension, Harness, Registry, Tool, ToolName } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, harnessLayer } from "./scripted.ts";

/** A tool of this package that answers with its own name. */
function tool<const Name extends string>(name: Name) {
	return Tool.make(name, {
		description: `The ${name} tool.`,
		parameters: Schema.Struct({}),
		success: Schema.String,
		handler: () => Effect.succeed(name),
	});
}

/** The same tool as plain Pi defines it. */
function piTool(name: string) {
	return defineTool({
		name,
		description: `The ${name} tool.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({ output: [{ type: "text", text: name }] }),
	});
}

const Lookup = tool("lookup");
const Read = tool("read");
const Write = tool("write");
const Files = Extension.make({ name: "files", tools: [Lookup, Read, Write] });
const Extra = Extension.make({ name: "extra", tools: [tool("extra")] });

const PiTools = [piTool("lookup"), piTool("read"), piTool("write")] as const;
const PiFiles = defineExtension({ name: "files", tools: [...PiTools] });
const PiExtra = defineExtension({ name: "extra", tools: [piTool("extra")] });

const extensions = { effect: Registry.layer([Files, Extra]), pi: [PiFiles, PiExtra] };

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("toPi", () => {
	it("turns names, this package's values and Pi's objects into what Pi stores by name", () => {
		const change = Agent.toPi({
			model: null,
			instructions: "Only read.",
			extensions: { add: ["extra"], remove: [Files] },
			tools: [ToolName.make("lookup"), Read, PiTools[2]],
			modelTools: { remove: [Write], add: [ToolName.make("extra")] },
		});
		expect(change).toEqual({
			model: null,
			instructions: "Only read.",
			extensions: { add: [{ name: "extra" }], remove: [Files] },
			tools: [{ name: "lookup" }, Read, PiTools[2]],
			modelTools: { remove: [Write], add: [{ name: "extra" }] },
		});
	});

	it("keeps null, which clears a field, and leaves absent fields absent", () => {
		expect(Agent.toPi({ tools: null, extensions: null, modelTools: null })).toEqual({
			tools: null,
			extensions: null,
			modelTools: null,
		});
		expect(Agent.toPi({ cwd: "/work" })).toEqual({ cwd: "/work" });
		expect(Agent.creation({ ownership: { kind: "ownerless" } })).toEqual({ ownership: { kind: "ownerless" } });
	});
});

describe("byName and ByName", () => {
	it("give a change as plain JSON, every tool and extension by its name, the rest as it is", () => {
		const json = Agent.byName({
			model: { provider: "faux", modelId: "small" },
			thinkingLevel: "high",
			extensions: { add: ["extra"], remove: [Files] },
			tools: { remove: [Read, PiTools[2]] },
			modelTools: [Lookup],
			maxTurns: 3,
			compaction: { enabled: false, modelOverrides: { "faux/small": { reserveTokens: 100 } } },
		});
		expect(json).toEqual({
			model: { provider: "faux", modelId: "small" },
			thinkingLevel: "high",
			extensions: { add: ["extra"], remove: ["files"] },
			tools: { remove: ["read", "write"] },
			modelTools: ["lookup"],
			maxTurns: 3,
			compaction: { enabled: false, modelOverrides: { "faux/small": { reserveTokens: 100 } } },
		});
		const decoded = Schema.decodeUnknownSync(Agent.ByName)(JSON.parse(JSON.stringify(json)));
		expect(decoded).toEqual(json);
		// What a decoded change is: a change `configure` takes.
		expect(Agent.toPi(decoded).tools).toEqual({ remove: [{ name: "read" }, { name: "write" }] });
	});

	it("refuses what Pi's configure would refuse: turns below 1, a negative token count, a level pi-ai has not", () => {
		const accepts = Schema.is(Agent.ByName);
		expect(accepts({ maxTurns: 1, compaction: { reserveTokens: 0 }, thinkingLevel: "max" })).toBe(true);
		expect(accepts({ maxTurns: 0 })).toBe(false);
		expect(accepts({ compaction: { keepRecentTokens: -1 } })).toBe(false);
		expect(accepts({ thinkingLevel: "extreme" })).toBe(false);
		expect(accepts({ model: { provider: "faux" } })).toBe(false);
	});

	it("brands the tool names it decodes, and takes no extension for a tool", () => {
		const decoded = Schema.decodeUnknownSync(Agent.ByName)({ tools: ["read"], extensions: ["files"] });
		const typed: Equal<
			typeof decoded.tools,
			ReadonlyArray<ToolName> | { readonly remove: ReadonlyArray<ToolName> } | null | undefined
		> = true;
		expect([typed, decoded]).toEqual([true, { tools: ["read"], extensions: ["files"] }]);
		// An extension carries a name, but not a tool's: a change does not take it for one.
		// @ts-expect-error An extension is not a tool.
		const mixed: Agent.Change = { tools: [Files] };
		expect(Agent.byName(mixed)).toEqual({ tools: ["files"] });
	});

	it("keeps null, which clears a field", () => {
		const cleared = { model: null, tools: null, modelTools: null, maxTurns: null, compaction: null };
		expect(Agent.byName(cleared)).toEqual(cleared);
		expect(Schema.is(Agent.ByName)(cleared)).toBe(true);
	});
});

describe("parity with Pi Durable", () => {
	it("configure by names restricts a conversation to exactly the tools named, as Pi's objects do", async () => {
		const both = await runBoth({
			responses: () => [],
			extensions,
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.configure({ tools: [ToolName.make("lookup"), ToolName.make("read")], extensions: [Files] });
				const agent = yield* root.agent;
				return {
					tools: agent.tools.map((offered) => offered.name),
					extensions: agent.extensions.map((e) => e.name),
				};
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await root.configure({ tools: [PiTools[0], PiTools[1]], extensions: [PiFiles] }, context);
				const agent = await root.agent(context);
				return {
					tools: agent.tools.map((offered) => offered.name),
					extensions: agent.extensions.map((e) => e.name),
				};
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual({ tools: ["lookup", "read"], extensions: ["files"] });
		const stored = both.effect.records.documents.find((document) => document.record.kind === "pi.agent");
		expect(stored?.value).toEqual({ ...AGENT, tools: ["lookup", "read"], extensions: ["files"] });
	});

	it("rootWith, createConversation and fork take the same change", async () => {
		const both = await runBoth({
			responses: () => [],
			extensions,
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: { ...AGENT, tools: { remove: [Write] } } });
				const note = yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "app.note" }));
				const other = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { extensions: { remove: ["extra"] }, modelTools: [Lookup] },
				});
				const fork = yield* root.fork({ at: note.id, ownership: { kind: "ownerless" }, agent: { tools: [Read] } });
				const offered = (conversation: typeof root) =>
					Effect.map(conversation.agent, (agent) => agent.tools.map((given) => given.name));
				return { root: yield* offered(root), other: yield* offered(other), fork: yield* offered(fork) };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: { ...AGENT, tools: { remove: [PiTools[2]] } } });
				const note = await root.commit((tx) => tx.appendEntry(root.id, { kind: "app.note" }), context);
				const other = await harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: { extensions: { remove: [PiExtra] }, modelTools: [PiTools[0]] },
					},
					context,
				);
				const fork = await root.fork(
					note.id,
					{ ownership: { kind: "ownerless" }, agent: { tools: [PiTools[1]] } },
					context,
				);
				const offered = async (conversation: typeof root) =>
					(await conversation.agent(context)).tools.map((given) => given.name);
				return { root: await offered(root), other: await offered(other), fork: await offered(fork) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual({ root: ["lookup", "read", "extra"], other: ["lookup"], fork: ["read"] });
	});
});

describe("a name nothing is registered under", () => {
	it("is stored and offers nothing, as Pi's stored names outlive their code", async () => {
		const offered = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({
					agent: { ...AGENT, tools: [ToolName.make("lookup"), ToolName.make("gone")] },
				});
				const stored = Option.getOrThrow(yield* Harness.conversation(root.id));
				return (yield* stored.agent).tools.map((given) => given.name);
			}).pipe(Effect.provide(harnessLayer({ registry: extensions.effect }))),
		);
		expect(offered).toEqual(["lookup"]);
	});
});
