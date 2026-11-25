import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@gunta/pi-durable-effect";
import { toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ResultMismatch, Subagent, Subagents } from "../src/index.ts";
import { CHILD, children, conversation, harness, offering, PARENT, routed, worker } from "./scene.ts";

const { foreground, background, status } = Subagents.TOOLS;

describe("Subagent.exactly", () => {
	it("names every field of Pi's agent change: a declared one as it is, an undeclared one cleared", () => {
		expect(Subagent.exactly({ model: CHILD, tools: ["c"] })).toEqual({
			model: CHILD,
			tools: ["c"],
			thinkingLevel: null,
			extensions: null,
			modelTools: null,
			instructions: null,
			cwd: null,
			maxTurns: null,
			compaction: null,
		});
		const whole = {
			model: CHILD,
			tools: ["c", "a"],
			thinkingLevel: "high",
			extensions: ["app"],
			modelTools: ["c"],
			instructions: "Child rules.",
			cwd: "/child",
			maxTurns: 3,
			compaction: { enabled: false },
		} as const;
		expect(Subagent.exactly(whole)).toEqual(whole);
	});
});

describe("a child's agent", () => {
	/** A parent with tools `a` and `b` and settings of its own delegates once; what the child ran with. */
	const delegated = (subagent: Subagent.Subagent) => {
		const offered: string[][] = [];
		const { layer } = harness({
			config: { subagents: [subagent], maxDepth: 1, maxLive: 1 },
			responses: routed({
				parent: [toolCall(foreground, { subagent: subagent.name, task: "Work." }), offering(offered, "Done.")],
				child: [offering(offered, "Worked.")],
			}),
		});
		return Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({
					agent: {
						model: PARENT,
						tools: ["a", "b", foreground, background, status],
						instructions: "Parent rules.",
						thinkingLevel: "high",
						cwd: "/parent",
						maxTurns: 7,
					},
				});
				// What a conversation runs with when nothing was chosen for it.
				const fresh = yield* Effect.flatMap(
					Harness.createConversation({ ownership: { kind: "ownerless" } }),
					(empty) => empty.agent,
				);
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				const [child] = yield* children;
				const agent = yield* (yield* conversation(child?.id as ConversationId)).agent;
				return {
					offered,
					child: {
						model: agent.model,
						tools: agent.tools.map((tool) => tool.name),
						callable: agent.callable.map((tool) => tool.name),
						extensions: agent.extensions.map((extension) => extension.name),
						instructions: agent.instructions,
						thinkingLevel: agent.thinkingLevel,
						cwd: agent.cwd,
						maxTurns: agent.maxTurns,
					},
					host: {
						extensions: fresh.extensions.map((extension) => extension.name),
						thinkingLevel: fresh.thinkingLevel,
					},
				};
			}).pipe(Effect.provide(layer)),
		);
	};

	it("is offered exactly the declared tool, and keeps none of its parent's tools, instructions, level, cwd or turns", async () => {
		const seen = await delegated(worker("researcher"));
		// The child's request, then the parent's: the parent has `a` and `b`, the declaration names only `c`.
		expect(seen.offered).toEqual([["c"], ["a", "b", "subagent", "subagent_start", "subagent_status"]]);
		expect(seen.child).toEqual({
			model: CHILD,
			tools: ["c"],
			callable: ["c"],
			// The host's selection and level, as a conversation nobody configured has them.
			extensions: seen.host.extensions,
			instructions: undefined,
			thinkingLevel: seen.host.thinkingLevel,
			cwd: undefined,
			maxTurns: undefined,
		});
		expect(seen.host.extensions).toEqual(["app", "subagent"]);
		expect(seen.host.thinkingLevel).not.toBe("high");
	});

	it("gets every field its declaration names", async () => {
		const seen = await delegated(
			worker("researcher", {
				agent: {
					model: CHILD,
					tools: ["c", "a"],
					modelTools: ["c"],
					extensions: ["app"],
					instructions: "Child rules.",
					thinkingLevel: "low",
					cwd: "/child",
					maxTurns: 3,
				},
			}),
		);
		expect(seen.offered[0]).toEqual(["c"]);
		expect(seen.child).toEqual({
			model: CHILD,
			tools: ["c"],
			callable: ["c", "a"],
			extensions: ["app"],
			instructions: "Child rules.",
			thinkingLevel: "low",
			cwd: "/child",
			maxTurns: 3,
		});
	});
});

describe("Subagent.result", () => {
	const City = Schema.Struct({ capital: Schema.String, founded: Schema.DateFromString });
	const cities = worker("cities", { result: City });

	it("decodes a stored typed result with the declared schema", async () => {
		const decoded = await Effect.runPromise(
			Subagent.result(cities, { capital: "Paris", founded: "0250-01-01T00:00:00.000Z" }),
		);
		expect(decoded).toEqual({ capital: "Paris", founded: new Date("0250-01-01T00:00:00.000Z") });
	});

	it("fails with ResultMismatch for a value the schema does not accept", async () => {
		const failed = await Effect.runPromise(Effect.flip(Subagent.result(cities, { capital: 7 })));
		expect(failed).toBeInstanceOf(ResultMismatch);
		expect(failed.subagent).toBe("cities");
		expect(failed.message).toContain('The result of subagent "cities" does not match its declared schema');
	});
});
