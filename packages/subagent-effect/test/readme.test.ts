// The examples of README.md, run as they stand on the scripted model.

import type { ConversationId } from "@earendil-works/pi-durable";
import {
	Doc,
	type DurableError,
	Extension,
	Harness,
	type SchemaDecodeError,
	Tool,
	type Tx,
} from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Child, ChildSetup, ChildSetupFailed, Subagent, Subagents } from "../src/index.ts";
import { children, entriesOf, offering, said, toolResults } from "./scene.ts";

// README: Quick start.
const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.String,
	handler: ({ query }) => Effect.succeed(`Results for ${query}: the tower opened on 31 March 1889.`),
});
const Write = Tool.make("write", {
	description: "Write a note.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(`Wrote: ${text}`),
});
const App = Extension.make({ name: "app", tools: [Search, Write] });

const model = { provider: "faux", modelId: "faux-1" };

// A subagent is the whole agent of its child, as data.
const Researcher = Subagent.make("researcher", {
	description: "Finds facts on the web and reports them with their sources.",
	agent: { model, tools: [Search], instructions: "Answer with the facts and their sources.", maxTurns: 8 },
});

const subagents = Subagents.extension({ subagents: [Researcher], maxDepth: 1, maxLive: 4 });

describe("README: Quick start", () => {
	it("delegates to a declared subagent and gets its answer as the tool result", async () => {
		const program = Effect.gen(function* () {
			// The parent has `write` and the foreground tool. The researcher will have `search`, and nothing else.
			const root = yield* Harness.rootWith({ agent: { model, tools: [Write, Subagents.TOOLS.foreground] } });
			return yield* root.prompt("Find out when the Eiffel Tower opened.");
		});

		const offered: string[][] = [];
		const live = TestHarness.layer({
			extensions: [App, subagents],
			responses: [
				toolCall("subagent", { subagent: "researcher", task: "When did the Eiffel Tower open?" }), // the parent
				toolCall("search", { query: "Eiffel Tower opening" }), // the child
				offering(offered, "It opened on 31 March 1889."), // the child: the result of the parent's call
				answer("The Eiffel Tower opened on 31 March 1889."), // the parent
			],
			// No guard and no budget here. The registry does not build until a setup is named: see "The setup port".
		}).pipe(Layer.provide(ChildSetup.none));

		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const settled = yield* program;
				const root = yield* Harness.root;
				return { settled: settled.status, results: toolResults(yield* entriesOf(root)) };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.settled).toBe("done");
		expect(seen.results.map((result) => [result.tool, result.text])).toEqual([
			["subagent", "It opened on 31 March 1889."],
		]);
		expect(offered).toEqual([["search"]]);
	});
});

// README: Typed results.
const Fact = Schema.Struct({ claim: Schema.String, source: Schema.String });

const FactFinder = Subagent.make("fact-finder", {
	description: "Finds one fact and its source.",
	agent: { model, tools: [Search] },
	result: Fact,
	corrections: 1,
});

// The host reads the value in the stored tool result's details, and decodes it with the declaration:
const factOf = (details: { readonly result: unknown }) => Subagent.result(FactFinder, details.result);

describe("README: Typed results", () => {
	it("gives the model JSON text and the host a value, after one correction", async () => {
		const live = TestHarness.layer({
			extensions: [App, Subagents.extension({ subagents: [FactFinder], maxDepth: 1, maxLive: 1 })],
			responses: [
				toolCall("subagent", { subagent: "fact-finder", task: "When did the Eiffel Tower open?" }),
				answer("It opened in 1889, says the tower's own site."),
				answer('```json\n{"claim":"The Eiffel Tower opened on 31 March 1889.","source":"toureiffel.paris"}\n```'),
				answer("Noted."),
			],
		}).pipe(Layer.provide(ChildSetup.none));
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: { model, tools: [Subagents.TOOLS.foreground] } });
				yield* root.prompt("Find the fact.");
				const [result] = toolResults(yield* entriesOf(root));
				return { text: result?.text, fact: yield* factOf(result?.details as { readonly result: unknown }) };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.text).toBe('{"claim":"The Eiffel Tower opened on 31 March 1889.","source":"toureiffel.paris"}');
		expect(seen.fact).toEqual({ claim: "The Eiffel Tower opened on 31 March 1889.", source: "toureiffel.paris" });
	});
});

describe("README: Background children", () => {
	it("returns a handle at once, and the result arrives later as an input that starts a turn", async () => {
		const program = Effect.gen(function* () {
			const root = yield* Harness.rootWith({
				agent: { model, tools: [Subagents.TOOLS.background, Subagents.TOOLS.status] },
			});
			// The model calls `subagent_start`, reads the handle, and answers while the child still works.
			yield* root.prompt("Start the research in the background, and tell me that you did.");
			// Later the result arrives by itself, as an input to the parent, and starts a turn.
			yield* Harness.waitForIdle;
		});

		// One scripted model serves the parent and the child, which ask at the same time: each request is answered by
		// what it ends with.
		const turn: FauxResponseStep = (context) => {
			const last = context.messages.findLast((message) => message.role !== "system");
			const text = JSON.stringify(last?.content);
			if (last?.role === "toolResult") return answer("I started the researcher.");
			if (text.includes("Start the research")) {
				return toolCall("subagent_start", { subagent: "researcher", task: "When did the Eiffel Tower open?" });
			}
			if (text.includes("[subagent researcher")) return answer("The researcher says: 31 March 1889.");
			return answer("It opened on 31 March 1889.");
		};
		const live = TestHarness.layer({ extensions: [App, subagents], responses: [turn, turn, turn, turn] }).pipe(
			Layer.provide(ChildSetup.none),
		);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* program;
				const [child] = yield* children;
				const root = yield* Harness.root;
				// The background run is no work of the parent's, so wait for it by its task.
				const record = Option.getOrThrow(yield* linkOf(child?.id as ConversationId));
				yield* Harness.waitForTask(record.task);
				yield* root.waitForIdle;
				return { id: child?.id, said: said(yield* entriesOf(root)) };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.said).toEqual([
			"user: Start the research in the background, and tell me that you did.",
			"assistant: I started the researcher.",
			`user: [subagent researcher, handle ${seen.id}, finished]\nIt opened on 31 March 1889.`,
			"assistant: The researcher says: 31 March 1889.",
		]);
	});
});

// README: The setup port. Stand-ins with the signatures of `@gunta/pi-guard-effect` (`Guard.Guard`,
// `Conversations.grantIn`) and `@gunta/pi-budget-effect` (`Shares`, `setCap`), which this package may not import.
const GrantDocument = Doc.make({
	kind: "test.grant",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ tools: Schema.Array(Schema.String) }),
	initial: () => ({ tools: [] as ReadonlyArray<string> }),
	checkpointWhen: () => false,
});
class GuardService extends Context.Service<GuardService, { readonly granted: ConversationId[] }>()("test/Guard") {}
const Guard = { Guard: GuardService };
const Conversations = {
	/** As the guard's: the grant's document and Pi's offer, written in the caller's commit. */
	grantIn: (
		tx: Tx.Tx,
		conversationId: ConversationId,
		grant: { readonly tools: ReadonlyArray<string> },
	): Effect.Effect<void, DurableError | SchemaDecodeError, GuardService> =>
		Effect.gen(function* () {
			(yield* GuardService).granted.push(conversationId);
			yield* (yield* tx.doc(GrantDocument, conversationId)).set({ tools: grant.tools });
			yield* tx.configure(conversationId, { tools: grant.tools });
		}),
};
interface Share {
	readonly conversation: ConversationId;
	readonly cap: bigint;
	readonly settled: bigint;
}
class Shares extends Context.Service<
	Shares,
	{ readonly setCap: (conversation: ConversationId, cap: bigint) => Effect.Effect<Share, DurableError> }
>()("test/Shares") {}

// The product's own table: what each declared subagent may call, and spend.
const allowances: Record<string, { readonly tools: ReadonlyArray<string>; readonly cap: bigint }> = {
	researcher: { tools: ["search"], cap: 50_000n },
};

const refused = (child: ChildSetup.Child) => (cause: unknown) =>
	new ChildSetupFailed({ reason: `The subagent ${child.subagent} has no allowance.`, cause });

const Setup = Layer.effect(
	ChildSetup.ChildSetup,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		const shares = yield* Shares;
		const allowanceOf = (child: ChildSetup.Child) =>
			Effect.mapError(Effect.fromNullishOr(allowances[child.subagent]), refused(child));
		return {
			// Stored with the child or not at all: no child ever exists without its grant.
			created: (tx, child) =>
				Effect.flatMap(allowanceOf(child), ({ tools }) =>
					Conversations.grantIn(tx, child.conversationId, { tools }).pipe(
						Effect.provideService(Guard.Guard, guard),
						Effect.mapError(refused(child)),
					),
				),
			// The cap is in place before the child's first provider request. Setting it again is harmless.
			beforeStart: (child) =>
				Effect.flatMap(allowanceOf(child), ({ cap }) =>
					shares.setCap(child.conversationId, cap).pipe(Effect.asVoid, Effect.mapError(refused(child))),
				),
		};
	}),
);

describe("README: The setup port", () => {
	/** The root delegates to `subagent` under the product's `Setup`, on the stand-ins. */
	const delegate = (subagent: string) => {
		const order: string[] = [];
		const granted: ConversationId[] = [];
		const offered: string[][] = [];
		// Declared with two tools; the product's allowance grants `researcher` one of them, and `writer` none.
		const declared = (name: string) =>
			Subagent.make(name, { description: `Does ${name} work.`, agent: { model, tools: [Search, Write] } });
		const live = TestHarness.layer({
			extensions: [
				App,
				Subagents.extension({ subagents: [declared("researcher"), declared("writer")], maxDepth: 1, maxLive: 1 }),
			],
			responses: [
				toolCall("subagent", { subagent, task: "Work." }),
				(context, options, state, current) => {
					order.push("request");
					const turn = offering(offered, "Worked.");
					return typeof turn === "function" ? turn(context, options, state, current) : turn;
				},
				answer("Done."),
			],
		}).pipe(
			Layer.provide(Setup),
			Layer.provide(Layer.succeed(Guard.Guard, { granted })),
			Layer.provide(
				Layer.succeed(Shares, {
					setCap: (conversation, cap) =>
						Effect.sync(() => {
							order.push(`cap ${cap}`);
							return { conversation, cap, settled: 0n };
						}),
				}),
			),
		);
		return Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: { model, tools: [Subagents.TOOLS.foreground] } });
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				const made = (yield* children).map((record) => record.id);
				const grants = yield* Effect.forEach(made, (id) => Harness.snapshot(GrantDocument, id));
				return { made, granted, grants, offered, order, results: toolResults(yield* entriesOf(root)) };
			}).pipe(Effect.provide(live)),
		);
	};

	it("grants the child its tools in the creating commit and caps it before its first request", async () => {
		const seen = await delegate("researcher");
		expect(seen.granted).toEqual(seen.made);
		expect(seen.grants).toEqual([Option.some({ tools: ["search"] })]);
		// Declared with `search` and `write`, granted `search`: the grant, written after the declaration, holds.
		expect(seen.offered[0]).toEqual(["search"]);
		expect(seen.order).toEqual(["cap 50000", "request"]);
		expect(seen.results.map((result) => [result.isError, result.text])).toEqual([[false, "Worked."]]);
	});

	it("refuses a subagent the product gave no allowance, and no child exists", async () => {
		const seen = await delegate("writer");
		expect(seen.made).toEqual([]);
		expect(seen.granted).toEqual([]);
		expect(seen.results).toEqual([
			{
				tool: "subagent",
				isError: true,
				text: "The subagent could not be set up: The subagent writer has no allowance.",
				details: { status: "refused", reason: "ChildSetupFailed" },
			},
		]);
	});
});

// README: Records.
// From a child to its parent, its declaration and how it ended: one committed read.
const linkOf = (child: ConversationId) => Harness.snapshot(Child.Document, Child.key(child));
// From a parent to its children: Pi's owner index.
const childrenOf = (parent: ConversationId) =>
	Harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent }, 100));

describe("README: Records", () => {
	it("links a child to its parent both ways", async () => {
		const live = TestHarness.layer({
			extensions: [App, subagents],
			responses: [
				toolCall("subagent", { subagent: "researcher", task: "When did the Eiffel Tower open?" }),
				answer("It opened on 31 March 1889."),
				answer("Done."),
			],
		}).pipe(Layer.provide(ChildSetup.none));
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: { model, tools: [Subagents.TOOLS.foreground] } });
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				const owned = (yield* childrenOf(root.id)).items;
				const link = Option.getOrThrow(yield* linkOf(owned[0]?.id as ConversationId));
				return { root: root.id, owned, link };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.owned).toHaveLength(1);
		expect(seen.owned[0]?.owner).toEqual({ conversationId: seen.root, taskId: seen.link.task });
		expect(seen.link).toMatchObject({
			conversation: seen.owned[0]?.id,
			subagent: "researcher",
			parent: seen.root,
			depth: 1,
			mode: "foreground",
			state: { _tag: "Answered" },
		});
	});
});
