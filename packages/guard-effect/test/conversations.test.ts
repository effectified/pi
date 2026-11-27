import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { fromPiModelRef } from "@effectified/pi-ai";
import { type Conversation, Extension, Harness, Registry, Storage, Tool, ToolName } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Exit, Layer, Option, PubSub, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	Conversations,
	type Grant,
	Guard,
	ModelNotCleared,
	Policy,
	type Refusal,
	Unguarded,
	UnknownClassification,
} from "../src/index.ts";
import {
	BLOCKED,
	brief,
	guardedHarness,
	harnessOn,
	names,
	offering,
	recorded,
	toolResults,
	tools,
	UNAVAILABLE,
	watching,
} from "./guarded.ts";

const ownerless = { kind: "ownerless" } as const;

const labelled: Policy.Encoded = {
	...Policy.empty,
	classifications: ["public", "internal", "confidential"],
	// The scripted provider's model, cleared up to `internal`.
	modelCeilings: [{ provider: "faux", modelId: "faux-1", ceiling: "internal" }],
};

/** A harness with the three recording tools under `policy`. */
function scene(options: Partial<Parameters<typeof guardedHarness>[0]> = {}) {
	const { ran, Search, Read, Write } = tools();
	const layer = guardedHarness({
		policy: options.policy ?? Policy.empty,
		extensions: [Extension.make({ name: "app", tools: [Search, Read, Write] })],
		responses: options.responses,
		created: options.created,
	});
	return { ran, layer };
}

/** How many conversations the harness stores. */
const conversations = Effect.map(
	Harness.commit((tx) => tx.scanConversations({}, 100)),
	(page) => page.items.length,
);

/** The names of the tools Pi offers the model in a conversation. */
const offeredTo = (conversation: Conversation.Conversation) =>
	Effect.map(conversation.agent, (agent) => agent.tools.map((tool) => tool.name));

describe("create", () => {
	it("stores the grant, enables exactly its tools and sets the model in the creating commit", async () => {
		const { layer } = scene({ policy: labelled });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const before = yield* conversations;
				const conversation = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: names("read", "search", "read"), classification: "internal" },
					model,
				});
				const agent = yield* conversation.agent;
				return {
					model,
					made: (yield* conversations) - before,
					granted: yield* Conversations.granted(conversation.id),
					offered: agent.tools.map((tool) => tool.name),
					runs: agent.model,
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.model).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(seen.made).toBe(1);
		expect(seen.granted).toEqual({ tools: names("read", "search"), classification: "internal" });
		expect(seen.offered).toEqual(["read", "search"]);
		expect(seen.runs).toEqual(seen.model);
	});

	it("fails with the exact error, and creates nothing, for a model the classification is above or a label unknown", async () => {
		const { layer } = scene({ policy: labelled });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const before = yield* conversations;
				const above = yield* Effect.flip(
					Conversations.create({
						ownership: ownerless,
						grant: { tools: [], classification: "confidential" },
						model,
					}),
				);
				const unlisted = yield* Effect.flip(
					Conversations.create({
						ownership: ownerless,
						grant: { tools: [], classification: "public" },
						model: fromPiModelRef({ provider: "other", modelId: "large" }),
					}),
				);
				const unclassified = yield* Effect.flip(
					Conversations.create({ ownership: ownerless, grant: { tools: [] }, model }),
				);
				const unknown = yield* Effect.flip(
					Conversations.create({ ownership: ownerless, grant: { tools: [], classification: "secret" }, model }),
				);
				return { above, unlisted, unclassified, unknown, made: (yield* conversations) - before };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.above).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "faux", modelId: "faux-1" }),
				classification: "confidential",
				ceiling: "internal",
			}),
		);
		expect(seen.unlisted).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "other", modelId: "large" }),
				classification: "public",
				ceiling: undefined,
			}),
		);
		expect(seen.unclassified).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "faux", modelId: "faux-1" }),
				classification: undefined,
				ceiling: "internal",
			}),
		);
		expect(seen.unknown).toEqual(UnknownClassification.make({ classification: "secret" }));
		expect(seen.unknown.message).toBe("The policy has no classification secret");
		expect(seen.made).toBe(0);
	});

	it("fails with Unguarded when the harness runs on a registry the guard did not build", async () => {
		const { Search } = tools();
		// The guard's Layer is there, but the harness was given an ordinary registry.
		const guard = Guard.layer({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search] })],
		});
		const unguarded = Harness.layer().pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					ScriptedModels.layer({ api: "scripted" }),
					// An extension under the guard's name is not the guard's: the object is compared, never the name.
					Registry.layer([Extension.make({ name: "guard" }), Extension.make({ name: "app", tools: [Search] })]),
					Storage.memory,
				),
			),
		);
		const error = await Effect.runPromise(
			Effect.flip(Conversations.create({ ownership: ownerless, grant: { tools: names("search") } })).pipe(
				Effect.provide(unguarded),
				Effect.provide(guard),
			),
		);
		expect(error).toBeInstanceOf(Unguarded);
		expect(error).toMatchObject({ _tag: "Unguarded", reason: { _tag: "NotSelected" } });
		expect(error.message).toMatch(/^Conversation \d+ does not select the guard's extension$/);
	});
});

describe("a guard that built no registry", () => {
	/** A harness on an ordinary registry, beside the guard of a policy: `Guard.registry` was never used. */
	const unchecked = () => {
		const { Search } = tools();
		const ordinary = Registry.layer([
			Extension.make({ name: "guard" }),
			Extension.make({ name: "app", tools: [Search] }),
		]);
		return harnessOn(Layer.merge(Guard.fromPolicy(Policy.empty), ordinary));
	};

	it("grants nothing: create, grant and grantIn fail with Unguarded, and nothing is stored", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				const before = yield* conversations;
				const created = yield* Effect.flip(
					Conversations.create({ ownership: ownerless, grant: { tools: names("search") } }),
				);
				const inCommit = yield* Effect.flip(
					Harness.commit((tx) => Conversations.grantIn(tx, root.id, { tools: names("search") })),
				);
				const existing = yield* Effect.flip(Conversations.grant(root, { tools: names("search") }));
				return {
					id: root.id,
					created,
					inCommit,
					existing,
					made: (yield* conversations) - before,
					// A read needs no registry: it says what would hold.
					granted: yield* Conversations.granted(root.id),
					offered: yield* offeredTo(root),
				};
			}).pipe(Effect.provide(unchecked())),
		);
		expect(seen.created).toMatchObject({ _tag: "Unguarded", reason: { _tag: "NoRegistry" } });
		expect(seen.inCommit).toEqual(Unguarded.make({ conversationId: seen.id, reason: { _tag: "NoRegistry" } }));
		expect(seen.inCommit.message).toBe(
			`This guard built no registry: nothing would enforce a grant of conversation ${seen.id}`,
		);
		expect(seen.existing).toEqual(Unguarded.make({ conversationId: seen.id, reason: { _tag: "NotSelected" } }));
		expect(seen.made).toBe(0);
		expect(seen.granted).toEqual({ tools: [] });
		expect(seen.offered).toEqual([]);
	});

	it("is what a service made by hand is, also beside a registry another guard built", async () => {
		const { layer } = scene();
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				const refusals = yield* PubSub.unbounded<Refusal.Refusal>();
				return yield* Effect.flip(
					Harness.commit((tx) => Conversations.grantIn(tx, root.id, { tools: names("search") })).pipe(
						Effect.provideService(Guard.Guard, { policy: Policy.empty, refusals }),
					),
				);
			}).pipe(Effect.provide(layer)),
		);
		expect(error).toMatchObject({ _tag: "Unguarded", reason: { _tag: "NoRegistry" } });
	});
});

describe("grant", () => {
	it("replaces the grant of an existing conversation and what Pi offers it, in one commit", async () => {
		const offered: string[][] = [];
		const { ran, layer } = scene({
			responses: [toolCall("write", { text: "a" }, { id: "call-1" }), offering(offered, "Written.")],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
				const before = yield* Conversations.granted(root.id);
				yield* Conversations.grant(root, { tools: names("search") });
				yield* Conversations.grant(root, { tools: names("write") });
				yield* root.prompt("Write a.");
				yield* root.waitForIdle;
				return { before, after: yield* Conversations.granted(root.id) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({ before: { tools: [] }, after: { tools: names("write") } });
		expect(offered).toEqual([["write"]]);
		expect(ran).toEqual(["write:a"]);
	});

	it("checks the classification and the model before it writes anything", async () => {
		const { layer } = scene({ policy: labelled });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const root = yield* Harness.root;
				yield* Conversations.grant(root, { tools: names("read"), classification: "public" });
				const unknown = yield* Effect.flip(
					Conversations.grant(root, { tools: names("write"), classification: "secret" }),
				);
				const above = yield* Effect.flip(
					Conversations.grant(root, { tools: names("write"), classification: "confidential" }, { model }),
				);
				yield* Conversations.grant(root, { tools: names("search"), classification: "internal" }, { model });
				const agent = yield* root.agent;
				return { unknown, above, granted: yield* Conversations.granted(root.id), runs: agent.model, model };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.unknown).toEqual(UnknownClassification.make({ classification: "secret" }));
		expect(seen.above).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "faux", modelId: "faux-1" }),
				classification: "confidential",
				ceiling: "internal",
			}),
		);
		expect(seen.granted).toEqual({ tools: names("search"), classification: "internal" });
		expect(seen.runs).toEqual(seen.model);
	});

	it("fails with Unguarded, and writes nothing, when the conversation does not ask the guard first", async () => {
		const { layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* Conversations.guarded(root);
				yield* root.configure({ extensions: ["app"] });
				const dropped = yield* Effect.flip(Conversations.grant(root, { tools: names("search") }));
				yield* root.configure({ extensions: ["app", "guard"] });
				const late = yield* Effect.flip(Conversations.grant(root, { tools: names("search") }));
				return { id: root.id, dropped, late, granted: yield* Conversations.granted(root.id) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.dropped).toEqual(Unguarded.make({ conversationId: seen.id, reason: { _tag: "NotSelected" } }));
		expect(seen.late).toEqual(Unguarded.make({ conversationId: seen.id, reason: { _tag: "NotFirst" } }));
		expect(seen.late.message).toBe(`Conversation ${seen.id} asks another extension before the guard's`);
		expect(seen.granted).toEqual({ tools: [] });
	});
});

describe("granted", () => {
	it("is the policy's grant for a conversation that has none, and for one that does not exist", async () => {
		const { layer } = scene({ policy: { ...Policy.empty, ungranted: { tools: names("read") } } });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				return [yield* Conversations.granted(root.id), yield* Conversations.granted(999 as ConversationId)];
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual([{ tools: names("read") }, { tools: names("read") }]);
	});
});

describe("a fork", () => {
	/** A parent granted search and read, an entry, the parent narrowed to read, then a fork at that entry. */
	const forked = (created: boolean) => {
		const offered: string[][] = [];
		const { ran, layer } = scene({
			created,
			responses: [
				answer("First."),
				toolCall("search", { text: "a" }, { id: "call-1" }),
				toolCall("read", { text: "b" }, { id: "call-2" }),
				offering(offered, "Done."),
			],
		});
		return Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const parent = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: names("search", "read") },
						model,
					});
					yield* parent.prompt("Hello.");
					yield* parent.waitForIdle;
					const at = Option.getOrThrow(yield* parent.head);
					yield* Conversations.grant(parent, { tools: names("read") });
					const fork = yield* parent.fork({ at, ownership: ownerless });
					const inherited = yield* Conversations.granted(fork.id);
					// The fork's grant is its own from here on.
					yield* Conversations.grant(parent, { tools: [] });
					yield* fork.prompt("Search a, read b.");
					yield* fork.waitForIdle;
					return {
						ran,
						offered,
						inherited,
						kept: yield* Conversations.granted(fork.id),
						results: (yield* toolResults(fork)).map((result) => [result.tool, result.text]),
						refusals: (yield* refused).map(brief),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
	};

	it("starts with the grant its parent has when it is committed, whatever entry it forks at", async () => {
		expect(await forked(true)).toEqual({
			ran: ["read:b"],
			offered: [["read"]],
			inherited: { tools: names("read") },
			kept: { tools: names("read") },
			results: [
				["search", UNAVAILABLE("search")],
				["read", "read did b"],
			],
			refusals: [{ callId: "call-1", tool: "search", rule: "unavailable" }],
		});
	});

	it("is offered what its parent was offered at that entry without `created`, and still calls only its grant", async () => {
		expect(await forked(false)).toEqual({
			ran: ["read:b"],
			offered: [["search", "read"]],
			inherited: { tools: names("read") },
			kept: { tools: names("read") },
			results: [
				["search", BLOCKED("search")],
				["read", "read did b"],
			],
			refusals: [{ callId: "call-1", tool: "search", rule: "allow-list" }],
		});
	});

	it("can be narrowed in the commit that creates it", async () => {
		const { layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const parent = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: names("search", "read") },
				});
				const note = yield* parent.commit((tx) => tx.appendEntry(parent.id, { kind: "app.note" }));
				const id = yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const fork = yield* tx.forkConversation(parent.id, note.id, { ownership: ownerless });
						yield* Conversations.grantIn(tx, fork.id, { tools: names("read") });
						return fork.id;
					}),
				);
				const fork = Option.getOrThrow(yield* Harness.conversation(id));
				return {
					granted: yield* Conversations.granted(id),
					offered: (yield* fork.agent).tools.map((tool) => tool.name),
					parent: yield* Conversations.granted(parent.id),
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			granted: { tools: names("read") },
			offered: ["read"],
			parent: { tools: names("search", "read") },
		});
	});
});

describe("a fork a task owns", () => {
	it("inherits its parent's grant with the classification raised to its owner's", async () => {
		const policy: Policy.Encoded = { ...Policy.empty, classifications: ["public", "internal"] };
		const { Search } = tools();
		const forks: ConversationId[] = [];
		// What the tool forks: a conversation labelled `public`, at its newest entry.
		const source: { id?: ConversationId; at?: EntryId } = {};
		const Fork = Tool.make("fork", {
			description: "Forks another conversation, owned by this call.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: (_params, api) =>
				Effect.gen(function* () {
					const { id, at } = source;
					if (id === undefined || at === undefined) return "nothing to fork";
					const fork = yield* api.commit((tx) =>
						tx.forkConversation(id, at, { ownership: { kind: "task", taskId: api.taskId } }),
					);
					forks.push(fork.id);
					return "forked";
				}),
		});
		const layer = guardedHarness({
			policy,
			extensions: [Extension.make({ name: "app", tools: [Search, Fork] })],
			responses: [toolCall("fork", {}, { id: "call-1" }), answer("Forked.")],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const open = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: names("search"), classification: "public" },
				});
				source.id = open.id;
				source.at = (yield* open.commit((tx) => tx.appendEntry(open.id, { kind: "app.note" }))).id;
				const owner = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: names("fork"), classification: "internal" },
				});
				yield* owner.configure(yield* TestHarness.agent);
				yield* owner.prompt("Fork it.");
				yield* owner.waitForIdle;
				return {
					fork: yield* Conversations.granted(forks[0] as ConversationId),
					source: yield* Conversations.granted(open.id),
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.fork).toEqual({ tools: names("search"), classification: "internal" });
		expect(seen.source).toEqual({ tools: names("search"), classification: "public" });
	});
});

describe("a task-owned child conversation", () => {
	/** A parent granted spawn and search whose `spawn` tool creates a child and has it call search. */
	const spawned = (options: { readonly created: boolean; readonly grant?: ReadonlyArray<ToolName> }) => {
		const { ran, Search } = tools();
		const offered: string[][] = [];
		const children: ConversationId[] = [];
		const Spawn = Tool.make("spawn", {
			description: "Delegates a task to a child conversation.",
			parameters: Schema.Struct({ task: Schema.String }),
			success: Schema.String,
			handler: ({ task }, api) =>
				Effect.gen(function* () {
					const child = yield* api.commit((tx) =>
						Effect.gen(function* () {
							const made = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
							if (options.grant !== undefined)
								yield* Conversations.grantIn(tx, made.id, { tools: options.grant });
							return made.id;
						}),
					);
					children.push(child);
					const handle = Option.getOrThrow(yield* api.conversation(child));
					const submission = yield* handle.submit({ type: "input", content: task, requestId: "spawned" });
					return (yield* submission.wait).status;
				}),
		});
		const layer = guardedHarness({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search, Spawn] })],
			created: options.created,
			responses: [
				toolCall("spawn", { task: "Search c." }, { id: "call-1" }),
				toolCall("search", { text: "c" }, { id: "call-2" }),
				offering(offered, "The child is done."),
				answer("The parent is done."),
			],
		});
		return Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const parent = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: names("spawn", "search") },
						model,
					});
					yield* parent.prompt("Delegate.");
					yield* parent.waitForIdle;
					const child = Option.getOrThrow(yield* Harness.conversation(children[0] as ConversationId));
					return {
						ran,
						offered,
						granted: yield* Conversations.granted(child.id),
						results: (yield* toolResults(child)).map((result) => [result.tool, result.text]),
						refusals: (yield* refused).map(brief),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
	};

	it("gets no grant: it is offered nothing with `created`, and can call nothing", async () => {
		expect(await spawned({ created: true })).toEqual({
			ran: [],
			offered: [[]],
			granted: { tools: [] },
			results: [["search", UNAVAILABLE("search")]],
			refusals: [{ callId: "call-2", tool: "search", rule: "unavailable" }],
		});
	});

	it("is offered its owner's tools by Pi's copy without `created`, and still can call nothing", async () => {
		expect(await spawned({ created: false })).toEqual({
			ran: [],
			offered: [["spawn", "search"]],
			granted: { tools: [] },
			results: [["search", BLOCKED("search")]],
			refusals: [{ callId: "call-2", tool: "search", rule: "allow-list" }],
		});
	});

	it("gets exactly the grant its creator gives it in the creating commit", async () => {
		expect(await spawned({ created: true, grant: names("search") })).toEqual({
			ran: ["search:c"],
			offered: [["search"]],
			granted: { tools: names("search") },
			results: [["search", "search did c"]],
			refusals: [],
		});
	});
});

describe("a grant that only narrows", () => {
	it("never adds a tool to a conversation that has a grant, whatever Pi's stored agent enables", async () => {
		const { layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const conversation = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: names("search", "read") },
				});
				yield* Conversations.grant(conversation, { tools: names("read", "write") }, { mode: "narrow" });
				const first = [yield* Conversations.granted(conversation.id), yield* offeredTo(conversation)];
				// Pi's choices widened behind the guard's back: the grant the conversation has still bounds the next one.
				yield* conversation.configure({ tools: null });
				yield* Conversations.grant(conversation, { tools: names("search", "read", "write") }, { mode: "narrow" });
				const second = [yield* Conversations.granted(conversation.id), yield* offeredTo(conversation)];
				// The default replaces, as before.
				yield* Conversations.grant(conversation, { tools: names("search", "write") });
				return { first, second, replaced: yield* offeredTo(conversation) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.first).toEqual([{ tools: names("read") }, ["read"]]);
		expect(seen.second).toEqual([{ tools: names("read") }, ["read"]]);
		expect(seen.replaced).toEqual(["search", "write"]);
	});

	it("keeps what Pi's stored agent enables: a list, every tool, or every tool but those removed", async () => {
		// Without `created`, a new conversation has no grant and Pi's stored agent is as the test sets it.
		const { layer } = scene({ created: false });
		const narrowedFrom = (tools: Parameters<Conversation.Conversation["configure"]>[0]["tools"]) =>
			Effect.gen(function* () {
				const conversation = yield* Harness.createConversation({ ownership: ownerless, agent: { tools } });
				yield* Conversations.grant(conversation, { tools: names("write", "search") }, { mode: "narrow" });
				return [(yield* Conversations.granted(conversation.id)).tools, yield* offeredTo(conversation)];
			});
		const seen = await Effect.runPromise(
			Effect.all([
				narrowedFrom([ToolName.make("search"), ToolName.make("read")]),
				narrowedFrom(null),
				narrowedFrom({ remove: [ToolName.make("write")] }),
			]).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual([
			[["search"], ["search"]],
			[
				["write", "search"],
				// Pi offers enabled tools in the order the grant lists them.
				["write", "search"],
			],
			[["search"], ["search"]],
		]);
	});
});

describe("a child set to its declaration, then granted", () => {
	const withCeilings: Policy.Encoded = {
		...Policy.empty,
		classifications: ["public", "internal"],
		toolCeilings: { search: "public" },
		modelCeilings: [
			{ provider: "faux", modelId: "faux-1", ceiling: "internal" },
			{ provider: "other", modelId: "small", ceiling: "public" },
		],
	};

	/**
	 * A parent whose `spawn` tool creates a child as a subagent's start does: the conversation, then its agent set to
	 * exactly `declared`, then the product's grant, in one commit. The child is asked to search and to write.
	 */
	const delegated = (options: {
		readonly policy?: Policy.Encoded;
		readonly created?: boolean;
		readonly parent?: Grant.Grant;
		readonly declared: ReadonlyArray<string>;
		readonly grant: Grant.Grant;
		readonly with?: Conversations.Options;
	}) => {
		const { ran, Search, Write } = tools();
		const offered: string[][] = [];
		const children: ConversationId[] = [];
		const failures: unknown[] = [];
		const Spawn = Tool.make("spawn", {
			description: "Delegates a task to a child conversation.",
			parameters: Schema.Struct({ task: Schema.String }),
			success: Schema.String,
			handler: ({ task }, api) =>
				Effect.gen(function* () {
					const made = yield* Effect.exit(
						api.commit((tx) =>
							Effect.gen(function* () {
								const child = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
								yield* tx.configure(child.id, { tools: options.declared.map((name) => ToolName.make(name)) });
								yield* Conversations.grantIn(tx, child.id, options.grant, options.with);
								return child.id;
							}),
						),
					);
					if (Exit.isFailure(made)) {
						failures.push(Option.getOrUndefined(Exit.findErrorOption(made)));
						return "refused";
					}
					children.push(made.value);
					const handle = Option.getOrThrow(yield* api.conversation(made.value));
					const submission = yield* handle.submit({ type: "input", content: task, requestId: "spawned" });
					return (yield* submission.wait).status;
				}),
		});
		const layer = guardedHarness({
			policy: options.policy ?? Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search, Write, Spawn] })],
			created: options.created,
			responses: [
				toolCall("spawn", { task: "Search c, write d." }, { id: "call-1" }),
				toolCall("search", { text: "c" }, { id: "call-2" }),
				toolCall("write", { text: "d" }, { id: "call-3" }),
				offering(offered, "The child is done."),
				answer("The parent is done."),
			],
		});
		return Effect.runPromise(
			Effect.gen(function* () {
				const parent = yield* Conversations.create({
					ownership: ownerless,
					grant: options.parent ?? { tools: names("spawn") },
				});
				// The model is Pi's own choice here, so a parent without a classification can run too.
				yield* parent.configure(yield* TestHarness.agent);
				yield* parent.prompt("Delegate.");
				yield* parent.waitForIdle;
				const [id] = children;
				if (id === undefined) return { ran, failures };
				const child = Option.getOrThrow(yield* Harness.conversation(id));
				return {
					ran,
					offered,
					granted: yield* Conversations.granted(id),
					enabled: yield* offeredTo(child),
					records: yield* recorded(child),
				};
			}).pipe(Effect.provide(layer)),
		);
	};

	it("is offered more than its declaration by a wider grant that replaces, the default", async () => {
		expect(await delegated({ declared: ["search"], grant: { tools: names("search", "write") } })).toEqual({
			ran: ["search:c", "write:d"],
			offered: [["search", "write"]],
			granted: { tools: names("search", "write") },
			enabled: ["search", "write"],
			records: [
				["search", undefined],
				["write", undefined],
			],
		});
	});

	it("is offered the intersection by a grant that narrows, and its stored grant is that intersection", async () => {
		const narrow = { mode: "narrow" } as const;
		expect(
			await delegated({ declared: ["search"], grant: { tools: names("search", "write") }, with: narrow }),
		).toEqual({
			ran: ["search:c"],
			offered: [["search"]],
			granted: { tools: names("search") },
			enabled: ["search"],
			records: [
				["search", undefined],
				["write", { rule: "unavailable" }],
			],
		});
		// A grant narrower than the declaration takes tools away, as it always did.
		expect(
			await delegated({ declared: ["search", "write"], grant: { tools: names("write") }, with: narrow }),
		).toEqual({
			ran: ["write:d"],
			offered: [["write"]],
			granted: { tools: names("write") },
			enabled: ["write"],
			records: [
				["search", { rule: "unavailable" }],
				["write", undefined],
			],
		});
	});

	it("is never labelled below its owner: the owner's classification bounds its tools and its model", async () => {
		const parent = { tools: names("spawn"), classification: "internal" };
		// Labelled `public`, the child could search, which the policy keeps from its `internal` owner.
		const lower = { tools: names("search", "write"), classification: "public" };
		expect(await delegated({ policy: withCeilings, parent, declared: ["search", "write"], grant: lower })).toEqual({
			ran: ["write:d"],
			offered: [["search", "write"]],
			granted: { tools: names("search", "write"), classification: "internal" },
			enabled: ["search", "write"],
			records: [
				["search", { rule: "ceiling" }],
				["write", undefined],
			],
		});
		// A model cleared for the label the grant names, and not for the owner's, is refused: no child exists.
		const small = fromPiModelRef({ provider: "other", modelId: "small" });
		const refused = await delegated({
			policy: withCeilings,
			parent,
			declared: ["search"],
			grant: lower,
			with: { model: small },
		});
		expect(refused).toEqual({
			ran: [],
			failures: [ModelNotCleared.make({ ...small, classification: "internal", ceiling: "public" })],
		});
	});

	it("keeps a label at or above its owner's, and is unlabelled under an unlabelled owner", async () => {
		const run = (parent: Grant.Grant, grant: Grant.Grant) =>
			delegated({ policy: withCeilings, parent, declared: ["write"], grant }).then((seen) => seen.granted);
		const spawn = names("spawn");
		expect(
			await run({ tools: spawn, classification: "public" }, { tools: names("write"), classification: "internal" }),
		).toEqual({ tools: names("write"), classification: "internal" });
		expect(await run({ tools: spawn, classification: "internal" }, { tools: names("write") })).toEqual({
			tools: names("write"),
		});
		// An owner without a classification is above every label, so its child is too.
		expect(await run({ tools: spawn }, { tools: names("write"), classification: "public" })).toEqual({
			tools: names("write"),
		});
	});

	it("is not bounded without `created`, which is what records its owner", async () => {
		const seen = await delegated({
			policy: withCeilings,
			created: false,
			parent: { tools: names("spawn"), classification: "internal" },
			declared: ["search"],
			grant: { tools: names("search"), classification: "public" },
		});
		expect(seen.granted).toEqual({ tools: names("search"), classification: "public" });
		expect(seen.ran).toEqual(["search:c"]);
	});
});

describe("created", () => {
	it("makes Pi offer a new conversation what the policy gives one without a grant", async () => {
		const run = (created: boolean) => {
			const { layer } = scene({ created, policy: { ...Policy.empty, ungranted: { tools: names("read") } } });
			return Effect.runPromise(
				Effect.gen(function* () {
					const root = yield* Harness.root;
					const other = yield* Harness.createConversation({ ownership: ownerless });
					return [yield* offeredTo(root), yield* offeredTo(other)];
				}).pipe(Effect.provide(layer)),
			);
		};
		expect(await run(true)).toEqual([["read"], ["read"]]);
		expect(await run(false)).toEqual([
			["search", "read", "write"],
			["search", "read", "write"],
		]);
	});
});
