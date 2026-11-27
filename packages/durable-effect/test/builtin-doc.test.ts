import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type AgentState,
	type ConversationId,
	type EntryId,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
	NestedCallDoc,
	type NestedCallState,
	ProviderDoc,
	type ProviderState,
	type TaskId,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { BuiltinDoc, type Doc, Extension, Gate, Harness, Hook, Tool, ToolName } from "../src/index.ts";
import { answer, type FauxResponseStep, held, TestHarness, toolCall } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT } from "./scripted.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const run = <A, E>(
	effect: Effect.Effect<A, E, TestHarness.Provided>,
	responses: ReadonlyArray<FauxResponseStep> = [answer("Done.")],
) => Effect.runPromise(Effect.provide(effect, TestHarness.layer({ responses })));

describe("the built-in documents", () => {
	it("are Pi's five, by kind and version, with who writes each", () => {
		const described = [BuiltinDoc.live, BuiltinDoc.provider, BuiltinDoc.usage, BuiltinDoc.inbox, BuiltinDoc.agent];
		expect(described.map((doc) => [doc.kind, doc.version, doc.scope, doc.history, doc.family, doc.writer])).toEqual([
			["pi.live", LiveDoc.definition.version, "conversation", "latest", false, "pi"],
			["pi.provider", ProviderDoc.definition.version, "conversation", "latest", false, "pi"],
			["pi.usage", UsageDoc.definition.version, "conversation", "latest", false, "pi"],
			["pi.inbox", InboxDoc.definition.version, "conversation", "latest", false, "pi"],
			["pi.agent", AgentDoc.definition.version, "conversation", "rewindable", false, "product"],
		]);
		expect(described.map((doc) => doc.token)).toEqual([LiveDoc, ProviderDoc, UsageDoc, InboxDoc, AgentDoc]);
	});

	it("are typed with Pi's own state types, addressed by a conversation, and only the agent can be rewound", () => {
		const values: [
			Equal<Doc.Value<typeof BuiltinDoc.live>, Readonly<LiveState>>,
			Equal<Doc.Value<typeof BuiltinDoc.provider>, Readonly<ProviderState>>,
			Equal<Doc.Value<typeof BuiltinDoc.usage>, Readonly<UsageState>>,
			Equal<Doc.Value<typeof BuiltinDoc.inbox>, Readonly<InboxState>>,
			Equal<Doc.Value<typeof BuiltinDoc.agent>, Readonly<AgentState>>,
		] = [true, true, true, true, true];
		const address: Equal<Doc.Address<typeof BuiltinDoc.live>, [conversationId: ConversationId]> = true;
		const rewindable: Equal<typeof BuiltinDoc.agent extends Doc.Rewindable ? true : false, true> = true;
		const latest: Equal<typeof BuiltinDoc.live extends Doc.Rewindable ? true : false, false> = true;
		const asOf = (id: ConversationId, at: EntryId) => [
			Harness.snapshotAsOf(BuiltinDoc.agent, id, at),
			// @ts-expect-error `pi.live` keeps no history: only a rewindable document is read as of an entry.
			Harness.snapshotAsOf(BuiltinDoc.live, id, at),
		];
		expect([...values, address, rewindable, latest, typeof asOf]).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			"function",
		]);
	});

	it("pass a stored state through, whatever it holds: no schema of this package can reject what Pi wrote", async () => {
		const stored = { run: { taskId: 7, inputs: [], turns: 0 }, added: "by a later Pi" };
		const decoded = await Effect.runPromise(BuiltinDoc.live.decode(stored));
		expect(decoded).toBe(stored);
	});
});

describe("the nested-call documents", () => {
	it("are Pi's task-scoped family, written by Pi alone and addressed by the calling task and the call's key", () => {
		const doc = BuiltinDoc.nestedCall;
		expect([doc.kind, doc.version, doc.scope, doc.history, doc.family, doc.writer, doc.token]).toEqual([
			"pi.tool.nested-call",
			NestedCallDoc.definition.version,
			"task",
			undefined,
			true,
			"pi",
			NestedCallDoc,
		]);
		const value: Equal<Doc.Value<typeof doc>, Readonly<NestedCallState>> = true;
		const address: Equal<Doc.Address<typeof doc>, [taskId: TaskId, key: string]> = true;
		expect([value, address]).toEqual([true, true]);
	});

	it("hold a nested call's task and result, which the calling tool reads", async () => {
		const Double = Tool.make("double", {
			description: "Double it.",
			parameters: Schema.Struct({ n: Schema.Number }),
			success: Schema.Number,
			callers: ["tools"],
			handler: ({ n }) => Effect.succeed(n * 2),
		});
		const read: Array<Option.Option<Readonly<NestedCallState>>> = [];
		const Caller = Tool.make("caller", {
			description: "Call double.",
			parameters: Schema.Struct({}),
			success: Schema.Null,
			handler: (_params, api) =>
				Effect.gen(function* () {
					yield* api.executeTool(ToolName.make("double"), { n: 2 }, { key: "twice" });
					read.push(yield* api.snapshot(BuiltinDoc.nestedCall, api.taskId, "twice"));
					return null;
				}),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Go.");
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Double, Caller] })],
						responses: [toolCall("caller", {}), answer("Done.")],
					}),
				),
			),
		);
		expect(read).toEqual([
			Option.some({
				kind: "nested",
				taskId: expect.any(Number),
				result: expect.objectContaining({ isError: false }),
			}),
		]);
	});
});

describe("reading a built-in document", () => {
	it("gives through Harness.snapshot what Pi's own snapshot gives, for each of the five", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.configure({ instructions: "Be brief." });
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const pi = yield* Harness.Harness;
				const own = <A>(read: () => Promise<A | undefined>) => Effect.promise(read);
				return {
					facade: {
						live: Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.live, root.id)),
						provider: Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.provider, root.id)),
						usage: Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.usage, root.id)),
						inbox: Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.inbox, root.id)),
						agent: Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.agent, root.id)),
					},
					pi: {
						live: yield* own(() => pi.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT)),
						provider: yield* own(() => pi.snapshot(ProviderDoc, root.id, BACKGROUND_CONTEXT)),
						usage: yield* own(() => pi.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT)),
						inbox: yield* own(() => pi.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)),
						agent: yield* own(() => pi.snapshot(AgentDoc, root.id, BACKGROUND_CONTEXT)),
					},
				};
			}),
		);
		expect(seen.facade).toEqual(seen.pi);
		expect(seen.facade.agent).toMatchObject({ instructions: "Be brief.", model: AGENT.model });
		expect(Object.keys(seen.facade.usage?.models ?? {})).toEqual(["faux/faux-1"]);
		expect(seen.facade.inbox).toEqual({ items: [] });
		expect(typeof seen.facade.provider?.sessionId).toBe("string");
		// Idle: no run, and no failure of the run that answered.
		expect(seen.facade.live).toEqual({});
	});

	it("gives none for a conversation that does not exist, as every snapshot", async () => {
		// Pi brands ids in the type system only.
		const absent = await run(Harness.snapshot(BuiltinDoc.live, 999 as ConversationId));
		expect(Option.isNone(absent)).toBe(true);
	});

	it("reads from a tool's api and a hook's api: the run and the tool slot while the call runs", async () => {
		const seen: { hook: Array<Readonly<AgentState> | undefined>; tool: Array<Readonly<LiveState> | undefined> } = {
			hook: [],
			tool: [],
		};
		const Peek = Tool.make("peek", {
			description: "Reads the live document.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: (_params, api) =>
				Effect.map(api.snapshot(BuiltinDoc.live, api.conversationId), (live) => {
					seen.tool.push(Option.getOrUndefined(live));
					return "peeked";
				}),
		});
		const Watching = Hook.beforeTool((_call, api) =>
			Effect.map(api.snapshot(BuiltinDoc.agent, api.conversationId), (agent) => {
				seen.hook.push(Option.getOrUndefined(agent));
				return Gate.allow;
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Peek.");
				yield* root.waitForIdle;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Peek], hooks: [Watching] })],
						responses: [toolCall("peek", {}, { id: "call-1" }), answer("Peeked.")],
					}),
				),
			),
		);
		expect(seen.hook).toEqual([{ model: AGENT.model }]);
		expect(seen.tool).toHaveLength(1);
		// The round that called the tool is counted when its tools run.
		expect(seen.tool[0]?.run).toMatchObject({ turns: 1 });
		expect(seen.tool[0]?.tools?.map((slot) => [slot.callId, slot.name])).toEqual([["call-1", "peek"]]);
	});

	it("opens in a commit for reading: the value the commit holds", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const inCommit = yield* root.commit((tx) =>
					Effect.gen(function* () {
						const usage = yield* (yield* tx.doc(BuiltinDoc.usage, root.id)).get;
						const live = yield* (yield* tx.doc(BuiltinDoc.live, root.id)).get;
						return { usage, live };
					}),
				);
				return { inCommit, usage: Option.getOrThrow(yield* Harness.snapshot(BuiltinDoc.usage, root.id)) };
			}),
		);
		expect(seen.inCommit.usage).toEqual(seen.usage);
		expect(seen.inCommit.live).toEqual({});
	});

	it("streams through watchDoc: the usage ledger now, then after each response", async () => {
		const totals = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				// The first element is the ledger at attachment: the response's change comes after it.
				const attached = yield* Latch.make();
				const watching = yield* Effect.forkChild(
					Harness.watchDoc(BuiltinDoc.usage, root.id).pipe(
						Stream.tap(() => attached.open),
						Stream.map((change) => Object.keys(change.value.models).length),
						Stream.changes,
						Stream.take(2),
						Stream.runCollect,
					),
				);
				yield* attached.await;
				yield* root.prompt("Hi.");
				return yield* Fiber.join(watching);
			}).pipe(Effect.provide(TestHarness.layer({ responses: [answer("Done.")] }))),
		);
		expect(totals).toEqual([0, 1]);
	});

	it("reads the agent as of an entry: what a fork there would run with", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.configure({ instructions: "First." });
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				yield* root.configure({ instructions: "Second." });
				return {
					atHead: Option.getOrThrow(yield* Harness.snapshotAsOf(BuiltinDoc.agent, root.id, head)).instructions,
					now: Option.getOrThrow(yield* Harness.snapshot(BuiltinDoc.agent, root.id)).instructions,
				};
			}),
		);
		expect(seen).toEqual({ atHead: "First.", now: "Second." });
	});
});

describe("writing a built-in document", () => {
	it("refuses set and update of the four Pi writes, and stores nothing of that commit", async () => {
		const response = held(answer("Late."));
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* response.requested;
				const before = yield* Harness.snapshot(BuiltinDoc.live, root.id);
				const refused = yield* Effect.forEach(
					[
						root.commit((tx) => Effect.flatMap(tx.doc(BuiltinDoc.live, root.id), (doc) => doc.set({}))),
						root.commit((tx) =>
							Effect.flatMap(tx.doc(BuiltinDoc.provider, root.id), (doc) => doc.set({ sessionId: "mine" })),
						),
						root.commit((tx) =>
							Effect.flatMap(tx.doc(BuiltinDoc.usage, root.id), (doc) => doc.update((usage) => usage)),
						),
						root.commit((tx) =>
							Effect.flatMap(tx.doc(BuiltinDoc.inbox, root.id), (doc) => doc.set({ items: [] })),
						),
					],
					(commit) => Effect.exit(commit),
				);
				const after = yield* Harness.snapshot(BuiltinDoc.live, root.id);
				yield* response.release;
				return {
					refused,
					unchanged: Option.getOrThrow(before) === Option.getOrThrow(after),
					settled: yield* submission.wait,
				};
			}),
			[response.response],
		);
		expect(seen.refused.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : "stored"))).toEqual([
			expect.stringContaining("Document pi.live is written by Pi alone"),
			expect.stringContaining("Document pi.provider is written by Pi alone"),
			expect.stringContaining("Document pi.usage is written by Pi alone"),
			expect.stringContaining("Document pi.inbox is written by Pi alone"),
		]);
		expect(seen.unchanged).toBe(true);
		// The run the commits met went on and answered.
		expect(seen.settled.status).toBe("done");
	});

	it("writes the agent as Pi's configure does: the same stored records", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.commit((tx) =>
					Effect.flatMap(tx.doc(BuiltinDoc.agent, root.id), (agent) =>
						agent.update((stored) => ({ ...stored, instructions: "Be brief.", maxTurns: 3 })),
					),
				);
				return Option.getOrUndefined(yield* Harness.snapshot(BuiltinDoc.agent, root.id));
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await root.configure({ instructions: "Be brief.", maxTurns: 3 }, context);
				return harness.snapshot(AgentDoc, root.id, context);
			},
		});
		expect(both.effect.result).toEqual({ model: AGENT.model, instructions: "Be brief.", maxTurns: 3 });
		expect(both.effect).toEqual(both.pi);
	});
});
