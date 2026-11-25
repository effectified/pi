import type { ConversationId } from "@earendil-works/pi-durable";
import { Doc, Harness, Registry, type SchemaConversionError } from "@gunta/pi-durable-effect";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ChildSetup, ChildSetupFailed, Subagents } from "../src/index.ts";
import {
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	offering,
	parent,
	routed,
	toolResults,
	worker,
} from "./scene.ts";

const config: Subagents.Config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 2 };
const { foreground } = Subagents.TOOLS;

/** A product's own document, as a guard's grant would be: written by the setup inside the creating commit. */
const Grant = Doc.make({
	kind: "test.grant",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ tools: Schema.Array(Schema.String) }),
	initial: () => ({ tools: [] as ReadonlyArray<string> }),
	checkpointWhen: () => false,
});

/** One delegation to `researcher` under `setup`, and what it left. */
function delegate(setup: Layer.Layer<ChildSetup.ChildSetup>, offered: string[][] = []) {
	const asked: string[] = [];
	const { layer } = harness({
		config,
		setup,
		responses: routed(
			{
				parent: [toolCall(foreground, { subagent: "researcher", task: "Work." }), answer("Reported.")],
				child: [offering(offered, "Worked.")],
			},
			asked,
		),
	});
	return Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* parent;
			const settled = yield* root.prompt("Delegate.");
			yield* root.waitForIdle;
			const made = yield* children;
			const runs = yield* Harness.commit((tx) =>
				Effect.promise(() => tx.pi.scanTasks({ kind: "subagent.run" }, 10)),
			);
			const child = made[0]?.id;
			return {
				settled: settled.status,
				asked,
				children: made.map((record) => record.id),
				runs: runs.items.length,
				results: toolResults(yield* entriesOf(root)),
				grant: child === undefined ? undefined : yield* Harness.snapshot(Grant, child),
				record: child === undefined ? undefined : yield* childOf(child),
				entries: child === undefined ? [] : yield* entriesOf(yield* conversation(child)),
			};
		}).pipe(Effect.provide(layer)),
	);
}

describe("the child setup port", () => {
	it("runs once in the commit that creates the child, and what it writes there exists with the child", async () => {
		const created: ChildSetup.Child[] = [];
		const started: ChildSetup.Child[] = [];
		const seen = await delegate(
			Layer.succeed(ChildSetup.ChildSetup, {
				created: (tx, child) =>
					Effect.gen(function* () {
						created.push(child);
						yield* (yield* tx.doc(Grant, child.conversationId)).set({ tools: ["c"] });
					}).pipe(
						Effect.mapError((cause) => new ChildSetupFailed({ reason: "The grant was not stored.", cause })),
					),
				beforeStart: (child) => Effect.sync(() => void started.push(child)),
			}),
		);
		const id = seen.children[0] as ConversationId;
		const child = { conversationId: id, parentId: 1, subagent: "researcher", mode: "foreground", depth: 1 };
		expect(created).toEqual([child]);
		expect(started).toEqual([child]);
		expect(seen.grant).toEqual(Option.some({ tools: ["c"] }));
		expect(seen.results.map((result) => [result.isError, result.text])).toEqual([[false, "Worked."]]);
	});

	it("runs after the declared agent, so what it configures is what the child gets", async () => {
		const offered: string[][] = [];
		await delegate(
			Layer.succeed(ChildSetup.ChildSetup, {
				// A guard narrows the declared tools to its grant: here to none.
				created: (tx, child) => Effect.orDie(tx.configure(child.conversationId, { tools: [] })),
				beforeStart: () => Effect.void,
			}),
			offered,
		);
		expect(offered).toEqual([[]]);
	});

	it("fails the creating commit when it fails: no child, no run, and an error result that says why", async () => {
		const seen = await delegate(
			Layer.succeed(ChildSetup.ChildSetup, {
				created: (tx, child) =>
					Effect.gen(function* () {
						// A write of the failing commit: it must not be stored either.
						yield* Effect.orDie(tx.doc(Grant, child.conversationId));
						return yield* new ChildSetupFailed({ reason: `No grant is defined for ${child.subagent}.` });
					}),
				beforeStart: () => Effect.void,
			}),
		);
		expect(seen.children).toEqual([]);
		expect(seen.runs).toBe(0);
		expect(seen.results).toEqual([
			{
				tool: "subagent",
				isError: true,
				text: "The subagent could not be set up: No grant is defined for researcher.",
				details: { status: "refused", reason: "ChildSetupFailed" },
			},
		]);
		// The parent's run goes on and answers; the child's model was never asked.
		expect(seen.settled).toBe("done");
		expect(seen.asked).toEqual(["parent", "parent"]);
	});

	it("ends a child whose `beforeStart` fails before any provider request, with an error result that says why", async () => {
		const seen = await delegate(
			Layer.succeed(ChildSetup.ChildSetup, {
				created: () => Effect.void,
				beforeStart: () => Effect.fail(new ChildSetupFailed({ reason: "The budget has no room for a child." })),
			}),
		);
		const id = seen.children[0] as ConversationId;
		expect(seen.entries).toEqual([]);
		expect(seen.asked).toEqual(["parent", "parent"]);
		expect(seen.record?.state).toEqual({
			_tag: "Failed",
			reason: "setup_failed",
			message: "The subagent could not be set up: The budget has no room for a child.",
			answer: null,
		});
		expect(seen.results).toEqual([
			{
				tool: "subagent",
				isError: true,
				text: "The subagent could not be set up: The budget has no room for a child.",
				details: {
					conversationId: id,
					handle: String(id),
					subagent: "researcher",
					mode: "foreground",
					status: "failed",
					reason: "setup_failed",
				},
			},
		]);
	});
});

describe("the decision that the port is required", () => {
	const registry = Registry.layer([Subagents.extension(config)]);

	it("makes a registry with the subagent extension require ChildSetup, in its type", () => {
		type Needs = typeof registry extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
		const requires: [ChildSetup.ChildSetup] extends [Needs] ? true : false = true;
		// @ts-expect-error A registry nobody gave a ChildSetup still requires one: a harness on it does not compile.
		const unprovided: Layer.Layer<Registry.Registry, SchemaConversionError> = registry;
		const provided: Layer.Layer<Registry.Registry, SchemaConversionError> = Layer.provide(registry, ChildSetup.none);
		expect([requires, Layer.isLayer(unprovided), Layer.isLayer(provided)]).toEqual([true, true, true]);
	});

	it("builds once the product named a setup, `none` included", async () => {
		const tools = await Effect.runPromise(
			Registry.Registry.use((built) =>
				Effect.succeed(
					built
						.snapshot()
						.tools()
						.map(({ tool }) => tool.name),
				),
			).pipe(Effect.provide(Layer.provide(registry, ChildSetup.none))),
		);
		expect(tools).toEqual(["subagent", "subagent_start", "subagent_status"]);
	});
});
