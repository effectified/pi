import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, fauxAssistantMessage, fauxToolCall, held, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Subagents } from "../src/index.ts";
import {
	CHILD,
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	parent,
	routed,
	toolResults,
	worker,
} from "./scene.ts";

const { foreground, background } = Subagents.TOOLS;

describe("a subagent that is not declared", () => {
	it("is refused with the names there are, and nothing is created", async () => {
		const { layer } = harness({
			config: { subagents: [worker("researcher"), worker("writer")], maxDepth: 1, maxLive: 1 },
			responses: routed({ parent: [toolCall(foreground, { subagent: "painter", task: "Paint." }), answer("No.")] }),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				return { children: (yield* children).length, results: toolResults(yield* entriesOf(root)) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			children: 0,
			results: [
				{
					tool: "subagent",
					isError: true,
					text: 'There is no subagent named "painter". Declared: researcher, writer',
					details: { status: "refused", reason: "UnknownSubagent" },
				},
			],
		});
	});
});

describe("the depth limit", () => {
	// A lead that may delegate itself, and a researcher that may not.
	const subagents = [worker("lead", { agent: { model: CHILD, tools: [foreground] } }), worker("researcher")];
	/** The root delegates to `lead`, whose model then delegates to `researcher`: what both levels left. */
	const nested = (maxDepth: number) => {
		const { layer } = harness({
			config: { subagents, maxDepth, maxLive: 1 },
			responses: routed({
				parent: [toolCall(foreground, { subagent: "lead", task: "Lead." }), answer("Done.")],
				// The lead asks first; a researcher, when there is one, answers before the lead's last turn.
				child: [
					toolCall(foreground, { subagent: "researcher", task: "Research." }),
					...(maxDepth > 1 ? [answer("Researched.")] : []),
					answer("Led."),
				],
			}),
		});
		return Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				const made = yield* children;
				const lead = made[0]?.id as ConversationId;
				return {
					lead,
					records: yield* Effect.forEach(made, (record) => childOf(record.id)),
					ofLead: toolResults(yield* entriesOf(yield* conversation(lead))),
					ofRoot: toolResults(yield* entriesOf(root)).map((result) => result.text),
				};
			}).pipe(Effect.provide(layer)),
		);
	};

	it("refuses a child's own child at `maxDepth: 1`, with an error result the child's model reads", async () => {
		const seen = await nested(1);
		expect(seen.records.map((record) => [record.subagent, record.depth])).toEqual([["lead", 1]]);
		expect(seen.ofLead).toEqual([
			{
				tool: "subagent",
				isError: true,
				text: "Subagents may nest 1 deep at most, and this agent is at depth 1: do the task yourself",
				details: { status: "refused", reason: "DepthExceeded" },
			},
		]);
		expect(seen.ofRoot).toEqual(["Led."]);
	});

	it("lets a child start its own child at `maxDepth: 2`, one level deeper and owned by the child's conversation", async () => {
		const seen = await nested(2);
		expect(seen.records.map((record) => [record.subagent, record.depth, record.parent])).toEqual([
			["lead", 1, 1],
			["researcher", 2, seen.lead],
		]);
		expect(seen.ofLead.map((result) => [result.isError, result.text])).toEqual([[false, "Researched."]]);
		expect(seen.ofRoot).toEqual(["Led."]);
	});
});

describe("the limit on live children", () => {
	const config: Subagents.Config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 };
	const start = (task: string, id: string) => fauxToolCall(background, { subagent: "researcher", task }, { id });

	it("lets one of two calls of the same round through, and a later one once the first child ended", async () => {
		const first = held(answer("First."));
		const { layer } = harness({
			config,
			responses: routed({
				parent: [
					// Two calls in one round: Pi runs them at once, and the commits decide.
					fauxAssistantMessage([start("One.", "call-1"), start("Two.", "call-2")], { stopReason: "toolUse" }),
					answer("One is running."),
					answer("Noted."),
					fauxAssistantMessage([start("Three.", "call-3")], { stopReason: "toolUse" }),
					answer("Three is running."),
					answer("Noted again."),
				],
				child: [first.response, answer("Third.")],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Start two.");
				yield* root.waitForIdle;
				const round = toolResults(yield* entriesOf(root));
				const [child] = yield* children;
				yield* first.release;
				yield* Harness.waitForTask((yield* childOf(child?.id as ConversationId)).task);
				yield* root.waitForIdle;
				yield* root.prompt("Start a third.");
				yield* root.waitForIdle;
				yield* Harness.waitForIdle;
				return { round, later: toolResults(yield* entriesOf(root)).slice(2), children: (yield* children).length };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.round.map((result) => result.isError).toSorted()).toEqual([false, true]);
		expect(seen.round.find((result) => result.isError)).toEqual({
			tool: "subagent_start",
			isError: true,
			text: "This agent already has as many subagents at work as it may have (1): wait for one to finish",
			details: { status: "refused", reason: "TooManyChildren" },
		});
		expect(seen.later.map((result) => result.isError)).toEqual([false]);
		expect(seen.children).toBe(2);
	});

	it("counts a foreground child and a background child alike", async () => {
		const working = held(answer("Background."));
		const { layer } = harness({
			config,
			responses: routed({
				parent: [
					toolCall(background, { subagent: "researcher", task: "Work." }),
					toolCall(foreground, { subagent: "researcher", task: "Also work." }),
					answer("Only one."),
					answer("Noted."),
				],
				child: [working.response],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Start both.");
				yield* root.waitForIdle;
				const results = toolResults(yield* entriesOf(root)).map((result) => [result.tool, result.isError]);
				yield* working.release;
				yield* Harness.waitForIdle;
				return results;
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual([
			["subagent_start", false],
			["subagent", true],
		]);
	});
});
