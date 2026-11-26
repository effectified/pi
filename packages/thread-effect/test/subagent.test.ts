// A subagent in the composition: offered exactly its declared tools, granted through the guard and capped on the
// budget's share in the commit that creates it, recorded under its own conversation, and paid from the same lease.

import { fauxProvider } from "@earendil-works/pi-ai";
import { Models } from "@effectified/pi-ai";
import { Shares } from "@effectified/pi-budget";
import { Extension, Harness, Storage, Tool } from "@effectified/pi-durable";
import { answer, toolCall } from "@effectified/pi-durable/testing";
import { Conversations, Guard, Policy } from "@effectified/pi-guard";
import * as Review from "@effectified/pi-review";
import { ChildSetup, ChildSetupFailed, Subagent, Subagents } from "@effectified/pi-subagent";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Threads } from "../src/index.ts";
import {
	committed,
	type Options,
	type Outside,
	outside,
	type Providers,
	providers,
	RESEARCHER_CAP,
	reservations,
	run,
	SUBAGENT,
	shape,
	work,
} from "./world.ts";

/** A thread that delegates to the researcher, and what the storage says of the parent and the child afterwards. */
const play = (state: Outside, labs: Providers, options?: Options) =>
	run(
		state,
		labs,
		Effect.gen(function* () {
			const threads = yield* Threads.Threads;
			const outcome = yield* threads.work(work("t1", "Ask the researcher what record 42 is called.", [SUBAGENT]));
			const parent = yield* threads.conversation("t1");
			const owned = yield* Harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent.id }, 10));
			const child = Option.getOrThrow(
				yield* Harness.conversation(Option.getOrThrow(Option.fromNullishOr(owned.items[0])).id),
			);
			const agentOf = (agent: Effect.Success<typeof child.agent>) => ({
				tools: agent.tools.map((tool) => tool.name),
				extensions: agent.extensions.map((extension) => extension.name),
				instructions: agent.instructions,
			});
			return {
				outcome,
				parent: { id: parent.id, agent: agentOf(yield* parent.agent) },
				children: owned.items.length,
				child: {
					id: child.id,
					agent: agentOf(yield* child.agent),
					grant: yield* Conversations.granted(child.id),
					share: Option.getOrThrow(yield* Shares.use((shares) => shares.get(child.id))),
				},
			};
		}),
		options,
	);

describe("a subagent of a thread", () => {
	it("runs with exactly its declared tools, under its own grant and cap, and its spend is the thread's", async () => {
		const state = outside();
		const labs = providers({
			author: [
				toolCall(SUBAGENT, { subagent: "researcher", task: "What is record 42 called?" }, { id: "call-1" }),
				toolCall("lookup", { id: "42" }, { id: "call-2" }),
				answer("Record 42 is titled Answer."),
				answer("The researcher says: Answer."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const { outcome, parent, children, child } = await play(state, labs);
		expect(children).toBe(1);
		// The child is offered its declaration's one tool: none of its parent's, the subagent tool included.
		expect(parent.agent.tools).toEqual([SUBAGENT]);
		expect(child.agent.tools).toEqual(["lookup"]);
		expect(child.agent.instructions).toBe("Report what the record says.");
		// It asks the guard first, as every conversation does, and is left out of the review.
		expect(child.agent.extensions[0]).toBe("guard");
		expect(parent.agent.extensions).toContain(Review.NAME);
		expect(child.agent.extensions).toEqual(parent.agent.extensions.filter((name) => name !== Review.NAME));
		// Granted through the guard, in the commit that created it, with its parent's classification.
		expect(child.grant).toEqual({ tools: ["lookup"], classification: "internal" });
		expect(state.ran).toEqual({ lookup: 1 });
		// Its records are in the sink under its own conversation.
		expect(
			committed(state)
				.filter((record) => record.conversation === child.id)
				.map(shape),
		).toEqual([
			{ _tag: "Message", role: "user", entryKind: "pi.user", text: "What is record 42 called?" },
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "toolUse", error: null },
			{ _tag: "ToolCallRequested", name: "lookup", callId: "call-2", arguments: { id: "42" } },
			{
				_tag: "ToolCallResult",
				name: "lookup",
				callId: "call-2",
				isError: false,
				codes: [],
				text: "Record 42 is titled Answer.",
			},
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
			{ _tag: "Message", role: "assistant", entryKind: "pi.assistant", text: "Record 42 is titled Answer." },
		]);
		expect(
			committed(state)
				.filter((record) => record.conversation === parent.id && record._tag === "ToolCallResult")
				.map(shape),
		).toEqual([
			{
				_tag: "ToolCallResult",
				name: SUBAGENT,
				callId: "call-1",
				isError: false,
				codes: [],
				text: "Record 42 is titled Answer.",
			},
		]);
		// One lease: the child's two requests are reserved on it between the parent's, each settled once.
		const reserved = reservations(state);
		expect(
			reserved.map(({ request, settlements }) => [request.model, request.conversation, settlements.length]),
		).toEqual([
			["author", parent.id, 1],
			["author", child.id, 1],
			["author", child.id, 1],
			["author", parent.id, 1],
			["reviewer", parent.id, 1],
		]);
		// Only the thread's answer is reviewed: the reviewer was asked once.
		expect(labs.reviewer.state.callCount).toBe(1);
		const spentBy = (conversation: number) =>
			reserved
				.filter(({ request }) => request.conversation === conversation)
				.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(child.share).toEqual({ conversation: child.id, cap: RESEARCHER_CAP, settled: spentBy(child.id) });
		expect(outcome).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: spentBy(parent.id) + spentBy(child.id) },
		});
	});

	it("stops at its cap while the thread goes on: the parent reads why and answers", async () => {
		const state = outside();
		const labs = providers({
			author: [
				toolCall(SUBAGENT, { subagent: "researcher", task: "What is record 42 called?" }, { id: "call-1" }),
				toolCall("lookup", { id: "42" }, { id: "call-2" }),
				answer("The researcher ran out of budget."),
			],
			reviewer: [answer('{"findings":[]}')],
		});
		const { outcome, parent, child } = await play(state, labs, { researcherCap: 1n });
		// The check is against settled amounts: the request that crosses the cap is served, the next one is refused.
		const reserved = reservations(state);
		expect(reserved.map(({ request }) => [request.model, request.conversation])).toEqual([
			["author", parent.id],
			["author", child.id],
			["author", parent.id],
			["reviewer", parent.id],
		]);
		const first = reserved[1]?.settlements[0]?.cost ?? 0n;
		expect(child.share).toEqual({ conversation: child.id, cap: 1n, settled: first });
		expect(first > 1n).toBe(true);
		const [failed] = committed(state).filter(
			(record) => record.conversation === child.id && record._tag === "ModelCall" && record.stopReason === "error",
		);
		expect(failed).toMatchObject({ provider: "router", model: "author" });
		const [result] = committed(state).filter(
			(record) => record.conversation === parent.id && record._tag === "ToolCallResult",
		);
		expect(result).toMatchObject({
			name: SUBAGENT,
			isError: true,
			text: expect.stringContaining("the conversation has used up its share"),
			details: { status: "failed", reason: "model_error", subagent: "researcher" },
		});
		expect(labs.author.state.callCount).toBe(3);
		// The lease is not fenced: the thread answers, and what the child settled is the thread's.
		const spent = reserved.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(outcome).toMatchObject({ _tag: "Reviewed", counts: { turns: 2, toolCalls: 1, settledMicros: spent } });
	});

	it("never offers a child more than its declaration, whatever its setup grants, on a guard built in two parts", async () => {
		// The pieces alone, with a setup that takes the guard from its context and grants one tool more than the
		// subagent declares, narrowed.
		const tool = (name: string) =>
			Tool.make(name, {
				description: `The tool ${name}.`,
				parameters: Schema.Struct({}),
				success: Schema.String,
				handler: () => Effect.succeed(name),
			});
		const model = { provider: "faux", modelId: "faux-1" };
		const Narrow = Subagent.make("narrow", { description: "Reads.", agent: { model, tools: ["read"] } });
		const faux = fauxProvider({ api: "scripted" });
		faux.setResponses([
			toolCall(SUBAGENT, { subagent: "narrow", task: "Read it." }),
			answer("Read."),
			answer("The child read it."),
		]);
		const setup = Layer.effect(
			ChildSetup.ChildSetup,
			Effect.gen(function* () {
				const guard = yield* Guard.Guard;
				return {
					created: (tx, child) =>
						Conversations.grantIn(
							tx,
							child.conversationId,
							{ tools: ["read", "write"] },
							{ mode: "narrow" },
						).pipe(
							Effect.provideService(Guard.Guard, guard),
							Effect.mapError((cause) => new ChildSetupFailed({ reason: "No grant.", cause })),
						),
					beforeStart: () => Effect.void,
				};
			}),
		);
		// `Guard.fromPolicy` gives the guard without a registry, so the setup the registry's tools need can hold it:
		// no cycle, and one guard for both.
		const registry = Guard.registry({
			extensions: [
				Extension.make({ name: "app", tools: [tool("read"), tool("write")] }),
				Subagents.extension({ subagents: [Narrow], maxDepth: 1, maxLive: 1 }),
			],
		}).pipe(Layer.provide(setup), Layer.provideMerge(Guard.fromPolicy(Policy.empty)));
		const live = Harness.layer({ conversationCreated: Conversations.created }).pipe(
			Layer.provideMerge(registry),
			Layer.provide(Storage.memory),
			Layer.provide(Models.layer([faux.provider])),
		);
		const child = await Effect.runPromise(
			Effect.gen(function* () {
				const parent = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: [SUBAGENT] },
					model,
				});
				yield* parent.prompt("Delegate.");
				const owned = yield* Harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent.id }, 10));
				const found = Option.getOrThrow(
					yield* Harness.conversation(Option.getOrThrow(Option.fromNullishOr(owned.items[0])).id),
				);
				return {
					offered: (yield* found.agent).tools.map((each) => each.name),
					granted: yield* Conversations.granted(found.id),
				};
			}).pipe(Effect.provide(live), Effect.orDie),
		);
		// A narrowed grant only takes away: the child keeps its declaration's one tool, and the stored grant agrees.
		expect(child).toEqual({ offered: ["read"], granted: { tools: ["read"] } });
	});
});
