// The examples of README.md, run as they stand on the scripted model.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Extension, Harness, Storage, Tool, type Tx } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	Classification,
	Conversations,
	DeniedTool,
	Guard,
	Matcher,
	ModelNotCleared,
	Policy,
	Refused,
	Rule,
} from "../src/index.ts";
import { toolResults } from "./guarded.ts";

// README: Quick start.
const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.String,
	handler: ({ query }) => Effect.succeed(`Results for ${query}`),
});
const Read = Tool.make("read", {
	description: "Read a record.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: ({ id }) => Effect.succeed(`Record ${id}`),
});
const App = Extension.make({ name: "app", tools: [Search, Read] });

const policy: Policy.Policy = {
	...Policy.empty,
	// No tool may be registered under these verbs, in snake or camel case.
	denied: [Matcher.firstWord(["approve", "sign", "export", "send", "delete"])],
	classifications: ["public", "internal", "confidential"],
	// A search sends text out: only public conversations may call it.
	toolCeilings: { search: "public" },
	modelCeilings: [{ provider: "faux", modelId: "faux-1", ceiling: "internal" }],
};

// Your own rule over the decoded arguments of `search`.
const TidyQueries = Rule.make("tidy-queries", Search, ({ query }) =>
	Effect.succeed(query.length > 200 ? Rule.block("query too long") : Rule.rewrite({ query: query.trim() })),
);

const live = Harness.layer({ conversationCreated: Conversations.created }).pipe(
	// The guard's extension first, then yours: other plugins' extensions go into the same list.
	Layer.provideMerge(Guard.layer({ policy, rules: [TidyQueries], extensions: [App] })),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
);

// README: The guard in two parts.
// A port of your own that a tool needs, and that needs the guard.
class Children extends Context.Service<
	Children,
	{ readonly created: (tx: Tx.Tx, child: ConversationId) => Effect.Effect<void, Conversations.GrantError> }
>()("app/Children") {}

const ChildrenLive = Layer.effect(
	Children,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		return {
			// In the child's creating commit: at most these tools, and never more than the child was set to.
			created: (tx, child) =>
				Conversations.grantIn(tx, child, { tools: ["read", "search"] }, { mode: "narrow" }).pipe(
					Effect.provideService(Guard.Guard, guard),
				),
		};
	}),
);

// What the README describes in words: a tool that requires `Children`, and calls `created` in the commit that
// creates the child, after it set the child's agent to what it may have at most.
const delegated: ConversationId[] = [];
const Delegate = Tool.make("delegate", {
	description: "Hands a task to a child conversation.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			const children = yield* Children;
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const made = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					yield* tx.configure(made.id, { tools: ["read"] });
					yield* children.created(tx, made.id);
					return made.id;
				}),
			);
			delegated.push(child);
			const handle = Option.getOrThrow(yield* api.conversation(child));
			const submission = yield* handle.submit({ type: "input", content: task, requestId: "delegated" });
			return (yield* submission.wait).status;
		}),
});
const Delegating = Extension.make({ name: "delegating", tools: [Delegate] });

const guard = Guard.fromPolicy(policy);
const registry = Guard.registry({ rules: [TidyQueries], extensions: [App, Delegating] }).pipe(
	Layer.provide(ChildrenLive),
	// One Layer value is one guard: the port's is the one the registry was checked by.
	Layer.provideMerge(guard),
);
const composed = Harness.layer({ conversationCreated: Conversations.created }).pipe(
	Layer.provideMerge(registry),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
);

describe("the guard in two parts of the README", () => {
	it("grants a child through a port that holds the guard, never more than the child was set to", async () => {
		const scripted = ScriptedModels.use((models) =>
			models.setResponses([
				toolCall("delegate", { task: "Read record 42." }),
				toolCall("read", { id: "42" }),
				toolCall("search", { query: "record 42" }),
				answer("It says Record 42."),
				answer("The child read it."),
			]),
		);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* scripted;
				const { model } = yield* TestHarness.agent;
				const parent = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: ["delegate"], classification: "public" },
					model,
				});
				yield* parent.prompt("Have record 42 read.");
				yield* parent.waitForIdle;
				const child = Option.getOrThrow(yield* Harness.conversation(delegated[0] as ConversationId));
				return {
					granted: yield* Conversations.granted(child.id),
					offered: (yield* child.agent).tools.map((tool) => tool.name),
					results: (yield* toolResults(child)).map((result) => [result.tool, result.text]),
				};
			}).pipe(Effect.provide(composed)),
		);
		// The grant names `search` too; the child was set to `read`, so that is all it gets.
		expect(seen.granted).toEqual({ tools: ["read"] });
		expect(seen.offered).toEqual(["read"]);
		expect(seen.results).toEqual([
			["read", "Record 42"],
			["search", "<harness>\n[error] Tool search is not available\n</harness>"],
		]);
	});
});

describe("the quick start of the README", () => {
	it("offers and runs the granted tool, with the rule's rewrite, and publishes the refusal of the other", async () => {
		const program = Effect.gen(function* () {
			const refused: Array<string> = [];
			yield* Effect.forkScoped(
				Stream.runForEach(Guard.refusals, (refusal) =>
					Effect.sync(() => refused.push(`${refusal.tool}: ${refusal.rule}`)),
				),
			);
			yield* Effect.yieldNow;
			const { model } = yield* TestHarness.agent;
			// Exactly these tools, this classification and this model, stored in the creating commit.
			const conversation = yield* Conversations.create({
				ownership: { kind: "ownerless" },
				grant: { tools: ["search"], classification: "public" },
				model,
			});
			yield* conversation.prompt("Find record 42 and read it.");
			yield* conversation.waitForIdle;
			// README: guarantee 5. In any process, also after a restart: which calls the guard refused, and by which rule.
			const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
			const recorded = yield* Effect.forEach(entries, Refused.of);
			// Option.some({ rule: "unavailable" }) for the entry of the `read` the model tried, none for every other entry
			return { refused, recorded, results: yield* toolResults(conversation) }; // ["read: unavailable"] when the model tried `read`
		});
		const scripted = ScriptedModels.use((models) =>
			models.setResponses([
				toolCall("search", { query: "  record 42 " }),
				toolCall("read", { id: "42" }),
				answer("I found it, and may not read it."),
			]),
		);
		const seen = await Effect.runPromise(Effect.scoped(Effect.andThen(scripted, program)).pipe(Effect.provide(live)));
		expect(seen.refused).toEqual(["read: unavailable"]);
		expect(seen.recorded.filter(Option.isSome)).toEqual([Option.some({ rule: "unavailable" })]);
		expect(seen.recorded.length > 1).toBe(true);
		expect(seen.results.map((result) => [result.tool, result.isError, result.text])).toEqual([
			["search", false, "Results for record 42"],
			["read", true, "<harness>\n[error] Tool read is not available\n</harness>"],
		]);
	});
});

describe("the guarantees of the README", () => {
	it("1: a tool under a denied verb fails the registry", async () => {
		const Sign = Tool.make("signDocument", {
			description: "Sign a document.",
			parameters: Schema.Struct({ id: Schema.String }),
			success: Schema.String,
			handler: () => Effect.succeed("signed"),
		});
		const refusedRegistry = Guard.layer({ policy, extensions: [Extension.make({ name: "office", tools: [Sign] })] });
		// Building it fails: DeniedTool { tool: "signDocument", extension: "office", rule: the firstWord matcher }
		const error = await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(refusedRegistry))));
		expect(error).toEqual(
			new DeniedTool({
				tool: "signDocument",
				extension: "office",
				rule: Matcher.firstWord(["approve", "sign", "export", "send", "delete"]),
			}),
		);
	});

	it("2: a grant is changed in one commit, or inside a commit that forks", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const conversation = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: ["search"], classification: "public" },
				});
				const at = (yield* conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "app.note" }))).id;
				// Change the grant of an existing conversation, in one commit.
				yield* Conversations.grant(conversation, { tools: ["search", "read"], classification: "public" });
				// Or inside a commit of your own, for example the one that forks.
				const forkId = yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const fork = yield* tx.forkConversation(conversation.id, at, { ownership: { kind: "ownerless" } });
						yield* Conversations.grantIn(tx, fork.id, { tools: ["read"], classification: "public" });
						return fork.id;
					}),
				);
				const now = yield* Conversations.granted(conversation.id); // the grant that holds
				// Take tools away and never add one: `write` is not in the grant the conversation has, so it is left out.
				yield* Conversations.grant(
					conversation,
					{ tools: ["read", "write"], classification: "public" },
					{ mode: "narrow" },
				);
				const narrowed = yield* Conversations.granted(conversation.id); // { tools: ["read"], classification: "public" }
				const fork = Option.getOrThrow(yield* Harness.conversation(forkId));
				return {
					now,
					narrowed,
					fork: yield* Conversations.granted(forkId),
					offered: (yield* fork.agent).tools.map((tool) => tool.name),
				};
			}).pipe(Effect.provide(live)),
		);
		expect(seen).toEqual({
			now: { tools: ["search", "read"], classification: "public" },
			narrowed: { tools: ["read"], classification: "public" },
			fork: { tools: ["read"], classification: "public" },
			offered: ["read"],
		});
	});

	it("4: the model check fails with ModelNotCleared", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				// Fails with ModelNotCleared { provider: "faux", modelId: "faux-1", classification: "confidential", ceiling: "internal" }
				Classification.checkModel(policy, { provider: "faux", modelId: "faux-1" }, "confidential"),
			),
		);
		expect(error).toEqual(
			new ModelNotCleared({
				provider: "faux",
				modelId: "faux-1",
				classification: "confidential",
				ceiling: "internal",
			}),
		);
	});

	it("4: another part of a product reads what a conversation holds, with the guard of the policy alone", async () => {
		// What a router filters its routes by, for one conversation.
		const constraintsOf = (conversationId: ConversationId) =>
			Effect.map(Conversations.granted(conversationId), (grant) => ({ classification: grant.classification }));
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const conversation = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: ["search"], classification: "public" },
				});
				const ungranted = yield* Harness.createConversation({ ownership: { kind: "ownerless" } });
				// The read needs the `Harness` and the `Guard` only: here a guard that built no registry.
				return yield* Effect.all([constraintsOf(conversation.id), constraintsOf(ungranted.id)]).pipe(
					Effect.provide(Guard.fromPolicy(policy)),
				);
			}).pipe(Effect.provide(live)),
		);
		// No classification is above every ceiling: a product answers it with its highest label, or refuses.
		expect(seen).toEqual([{ classification: "public" }, { classification: undefined }]);
	});

	it("6: the guard's extension has the name a selection lists first", () => {
		expect(Guard.EXTENSION).toBe("guard");
	});
});
