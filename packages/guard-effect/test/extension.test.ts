import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Extension, Gate, Harness, Hook, Registry, Tool } from "@effectified/pi-durable";
import { answer, type FauxResponseStep, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Conversations, Grant, Guard, Matcher, Policy, Refused, Rule } from "../src/index.ts";
import {
	BLOCKED,
	brief,
	guardedHarness,
	offering,
	recorded,
	recording,
	toolResults,
	tools,
	UNAVAILABLE,
	watching,
} from "./guarded.ts";

const ownerless = { kind: "ownerless" } as const;

/** A harness with the three recording tools under `policy`, and what they ran. */
function scene(
	responses: ReadonlyArray<FauxResponseStep>,
	options: { readonly policy?: Policy.Policy; readonly created?: boolean } = {},
) {
	const { ran, Search, Read, Write } = tools();
	const layer = guardedHarness({
		policy: options.policy ?? Policy.empty,
		extensions: [Extension.make({ name: "app", tools: [Search, Read, Write] })],
		responses,
		created: options.created,
	});
	return { ran, layer };
}

describe("the allow-list", () => {
	it("offers the model exactly the granted tools", async () => {
		const offered: string[][] = [];
		const { layer } = scene([offering(offered, "Nothing to do.")]);
		const agent = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const conversation = yield* Conversations.create({
					ownership: ownerless,
					grant: { tools: ["read", "search"] },
					model,
				});
				yield* conversation.prompt("Go.");
				return yield* conversation.agent;
			}).pipe(Effect.provide(layer)),
		);
		expect(offered).toEqual([["read", "search"]]);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read", "search"]);
		expect(agent.callable.map((tool) => tool.name)).toEqual(["read", "search"]);
	});

	it("answers a call to a tool outside the list with an error result, and never runs its handler", async () => {
		const { ran, layer } = scene([toolCall("write", { text: "a" }, { id: "call-1" }), answer("I cannot write.")]);
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["read", "search"] },
						model,
					});
					const settled = yield* conversation.prompt("Write a.");
					yield* conversation.waitForIdle;
					return {
						id: conversation.id,
						settled: settled.status,
						results: yield* toolResults(conversation),
						refusals: yield* refused,
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(seen.settled).toBe("done");
		expect(seen.results).toEqual([
			{ tool: "write", isError: true, text: UNAVAILABLE("write"), codes: ["tool_unavailable"] },
		]);
		expect(ran).toEqual([]);
		expect(seen.refusals.map(brief)).toEqual([{ callId: "call-1", tool: "write", rule: "unavailable" }]);
		expect(seen.refusals[0]?.conversationId).toBe(seen.id);
	});

	it("blocks the call when configure offered the tool behind the guard's back, and still runs a granted one", async () => {
		const offered: string[][] = [];
		const { ran, layer } = scene([
			toolCall("write", { text: "a" }, { id: "call-1" }),
			toolCall("search", { text: "b" }, { id: "call-2" }),
			offering(offered, "Done."),
		]);
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["read", "search"] },
						model,
					});
					// Pi's own choices, changed without the guard: every tool of the registry is offered again.
					yield* conversation.configure({ tools: null, modelTools: null });
					yield* conversation.prompt("Write a, then search b.");
					yield* conversation.waitForIdle;
					return { results: yield* toolResults(conversation), refusals: yield* refused };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(offered).toEqual([["search", "read", "write"]]);
		expect(seen.results).toEqual([
			{ tool: "write", isError: true, text: BLOCKED("write"), codes: ["blocked"] },
			{ tool: "search", isError: false, text: "search did b", codes: [] },
		]);
		expect(ran).toEqual(["search:b"]);
		expect(seen.refusals.map(brief)).toEqual([{ callId: "call-1", tool: "write", rule: "allow-list" }]);
	});

	it("blocks a nested call to a tool outside the list, with Pi's choices as the guard set them and behind its back", async () => {
		const { ran, Search, Write } = tools();
		const nested: unknown[] = [];
		const Outer = Tool.make("outer", {
			description: "Calls write as a nested call.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }, api) =>
				Effect.gen(function* () {
					const result = yield* api.executeTool("write", { text });
					nested.push({
						isError: result.isError,
						codes: (result.diagnostics ?? []).map((diagnostic) => diagnostic.code),
						// A nested call has no entry: its record is in the details its caller gets.
						refused: Option.getOrUndefined(yield* Refused.fromDetails(result.details)),
					});
					return "outer ran";
				}),
		});
		const layer = guardedHarness({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search, Write, Outer] })],
			responses: [
				toolCall("outer", { text: "a" }, { id: "call-1" }),
				answer("First."),
				toolCall("outer", { text: "b" }, { id: "call-2" }),
				answer("Second."),
			],
		});
		const refusals = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["outer"] },
						model,
					});
					yield* conversation.prompt("Go.");
					yield* conversation.waitForIdle;
					yield* conversation.configure({ tools: null });
					yield* conversation.prompt("Again.");
					yield* conversation.waitForIdle;
					return yield* refused;
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(nested).toEqual([
			{ isError: true, codes: ["tool_unavailable"], refused: { rule: "unavailable" } },
			{ isError: true, codes: ["blocked"], refused: { rule: "allow-list" } },
		]);
		expect(ran).toEqual([]);
		expect(refusals.map(brief)).toEqual([
			{ callId: "call-1/1", tool: "write", rule: "unavailable" },
			{ callId: "call-2/1", tool: "write", rule: "allow-list" },
		]);
	});

	it("lets a conversation without a list call nothing, whether Pi offers it tools or not", async () => {
		const run = (created: boolean) => {
			const offered: string[][] = [];
			const { ran, layer } = scene(
				[toolCall("search", { text: "a" }, { id: "call-1" }), offering(offered, "Nothing worked.")],
				{ created },
			);
			return Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refused = yield* watching;
						// Created the ordinary way, without a grant.
						const conversation = yield* Harness.createConversation({
							ownership: ownerless,
							agent: yield* TestHarness.agent,
						});
						yield* conversation.prompt("Search a.");
						yield* conversation.waitForIdle;
						return {
							ran,
							offered,
							granted: yield* Conversations.granted(conversation.id),
							results: yield* toolResults(conversation),
							refusals: (yield* refused).map(brief),
						};
					}),
				).pipe(Effect.provide(layer)),
			);
		};
		// With `Conversations.created`, Pi offers it nothing and refuses the call itself.
		expect(await run(true)).toEqual({
			ran: [],
			offered: [[]],
			granted: { tools: [] },
			results: [{ tool: "search", isError: true, text: UNAVAILABLE("search"), codes: ["tool_unavailable"] }],
			refusals: [{ callId: "call-1", tool: "search", rule: "unavailable" }],
		});
		// Without it, Pi offers every tool, and the guard blocks the call.
		expect(await run(false)).toEqual({
			ran: [],
			offered: [["search", "read", "write"]],
			granted: { tools: [] },
			results: [{ tool: "search", isError: true, text: BLOCKED("search"), codes: ["blocked"] }],
			refusals: [{ callId: "call-1", tool: "search", rule: "allow-list" }],
		});
	});

	it("gives a conversation without a list what the policy says for that case", async () => {
		const offered: string[][] = [];
		const { ran, layer } = scene(
			[
				toolCall("read", { text: "a" }, { id: "call-1" }),
				toolCall("search", { text: "b" }, { id: "call-2" }),
				offering(offered, "Read only."),
			],
			{ policy: { ...Policy.empty, ungranted: { tools: ["read"] } } },
		);
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
				yield* root.prompt("Read a, search b.");
				yield* root.waitForIdle;
				return yield* toolResults(root);
			}).pipe(Effect.provide(layer)),
		);
		expect(offered).toEqual([["read"]]);
		expect(ran).toEqual(["read:a"]);
		expect(results.map((result) => [result.tool, result.codes])).toEqual([
			["read", []],
			["search", ["tool_unavailable"]],
		]);
	});

	it("never runs a tool under a denied name, also one installed later in Pi's registry and granted", async () => {
		let ran = 0;
		const late = defineExtension({
			name: "late",
			tools: [
				defineTool({
					name: "delete_all",
					description: "Installed behind the guard.",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					execute: async () => {
						ran += 1;
						return { output: [{ type: "text", text: "deleted" }] };
					},
				}),
			],
		});
		const { layer } = scene([toolCall("delete_all", {}, { id: "call-1" }), answer("Refused.")], {
			policy: { ...Policy.empty, denied: [Matcher.firstWord(["delete"])] },
		});
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					yield* Registry.Registry.use((registry) => Effect.sync(() => registry.install(late)));
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["delete_all"] },
						model,
					});
					yield* conversation.prompt("Delete everything.");
					yield* conversation.waitForIdle;
					return {
						results: yield* toolResults(conversation),
						refusals: (yield* refused).map(brief),
						records: yield* recorded(conversation),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(ran).toBe(0);
		expect(seen.results).toEqual([
			{ tool: "delete_all", isError: true, text: BLOCKED("delete_all"), codes: ["blocked"] },
		]);
		expect(seen.refusals).toEqual([{ callId: "call-1", tool: "delete_all", rule: "denied" }]);
		expect(seen.records).toEqual([["delete_all", { rule: "denied" }]]);
	});

	it("blocks every call of a conversation whose grant it cannot read", async () => {
		const { ran, layer } = scene([toolCall("search", { text: "a" }, { id: "call-1" }), answer("Refused.")]);
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["search"] },
						model,
					});
					// A value the schema rejects, written past it through Pi's draft.
					yield* conversation.commit((tx) =>
						Effect.map(tx.doc(Grant.Document, conversation.id), (document) => {
							document.draft.grant = { tools: "everything" };
						}),
					);
					yield* conversation.prompt("Search a.");
					yield* conversation.waitForIdle;
					return {
						results: yield* toolResults(conversation),
						refusals: (yield* refused).map(brief),
						records: yield* recorded(conversation),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(ran).toEqual([]);
		expect(seen.results).toEqual([{ tool: "search", isError: true, text: BLOCKED("search"), codes: ["blocked"] }]);
		expect(seen.refusals).toEqual([{ callId: "call-1", tool: "search", rule: "guard-failed" }]);
		expect(seen.records).toEqual([["search", { rule: "guard-failed" }]]);
	});
});

describe("argument rules", () => {
	it("allow, rewrite and block a call, and a failing rule blocks", async () => {
		const { ran, Search, Read } = tools();
		const Trimmed = Rule.make("trimmed", Search, ({ text }) =>
			Effect.succeed(text === text.trim() ? Rule.allow : Rule.rewrite({ text: text.trim() })),
		);
		const NoSecrets = Rule.make("no-secrets", Search, ({ text }) =>
			Effect.succeed(text.includes("launch-codes") ? Rule.block("names a secret") : Rule.allow),
		);
		const Broken = Rule.make("broken", Read, () => Effect.fail(new Error("the lookup is down")));
		const layer = guardedHarness({
			policy: Policy.empty,
			rules: [Trimmed, NoSecrets, Broken],
			extensions: [Extension.make({ name: "app", tools: [Search, Read] })],
			responses: [
				toolCall("search", { text: "plain" }, { id: "call-1" }),
				toolCall("search", { text: "  padded " }, { id: "call-2" }),
				toolCall("search", { text: " the launch-codes " }, { id: "call-3" }),
				toolCall("read", { text: "anything" }, { id: "call-4" }),
				answer("Done."),
			],
		});
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["search", "read"] },
						model,
					});
					yield* conversation.prompt("Go.");
					yield* conversation.waitForIdle;
					return { results: yield* toolResults(conversation), refusals: yield* refused };
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(ran).toEqual(["search:plain", "search:padded"]);
		expect(seen.results).toEqual([
			{ tool: "search", isError: false, text: "search did plain", codes: [] },
			{ tool: "search", isError: false, text: "search did padded", codes: [] },
			{ tool: "search", isError: true, text: BLOCKED("search"), codes: ["blocked"] },
			{ tool: "read", isError: true, text: BLOCKED("read"), codes: ["blocked"] },
		]);
		expect(seen.refusals.map(brief)).toEqual([
			{ callId: "call-3", tool: "search", rule: "argument", name: "no-secrets", reason: "names a secret" },
			{ callId: "call-4", tool: "read", rule: "argument-failed", name: "broken" },
		]);
		// Neither the arguments nor the failure's text is published, and the model is not told the rule.
		expect(JSON.stringify(seen.refusals)).not.toMatch(/launch-codes|lookup is down/);
		expect(JSON.stringify(seen.results)).not.toMatch(/names a secret|no-secrets|lookup is down/);
	});
});

describe("the classification ceiling of a tool", () => {
	const policy: Policy.Policy = {
		...Policy.empty,
		classifications: ["public", "internal", "confidential"],
		toolCeilings: { search: "public" },
	};

	it("blocks a tool whose ceiling is below the conversation's classification, and no other", async () => {
		const run = (classification: string) => {
			const { ran, layer } = scene(
				[
					toolCall("search", { text: "a" }, { id: "call-1" }),
					toolCall("read", { text: "b" }, { id: "call-2" }),
					answer("Done."),
				],
				{ policy },
			);
			return Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refused = yield* watching;
						const conversation = yield* Conversations.create({
							ownership: ownerless,
							grant: { tools: ["search", "read"], classification },
						});
						yield* conversation.configure(yield* TestHarness.agent);
						yield* conversation.prompt("Search a, read b.");
						yield* conversation.waitForIdle;
						return { ran, refusals: (yield* refused).map(brief) };
					}),
				).pipe(Effect.provide(layer)),
			);
		};
		expect(await run("public")).toEqual({ ran: ["search:a", "read:b"], refusals: [] });
		expect(await run("confidential")).toEqual({
			ran: ["read:b"],
			refusals: [{ callId: "call-1", tool: "search", rule: "ceiling" }],
		});
	});
});

describe("refusals", () => {
	it("are published once per decision, to every subscriber, and as a Stream", async () => {
		const { layer } = scene([
			toolCall("write", { text: "a" }, { id: "call-1" }),
			toolCall("write", { text: "b" }, { id: "call-2" }),
			toolCall("search", { text: "c" }, { id: "call-3" }),
			answer("Done."),
		]);
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const first = yield* watching;
					const second = yield* watching;
					// Started at once, the Stream has subscribed when the fork returns.
					const stream = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Guard.refusals, 2)), {
						startImmediately: true,
					});
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["search"] },
						model,
					});
					yield* conversation.configure({ tools: null });
					yield* conversation.prompt("Go.");
					yield* conversation.waitForIdle;
					return { first: yield* first, second: yield* second, stream: yield* Fiber.join(stream) };
				}),
			).pipe(Effect.provide(layer)),
		);
		const expected = [
			{ callId: "call-1", tool: "write", rule: "allow-list" },
			{ callId: "call-2", tool: "write", rule: "allow-list" },
		];
		expect(seen.first.map(brief)).toEqual(expected);
		expect(seen.second).toEqual(seen.first);
		expect(seen.stream).toEqual(seen.first);
	});
});

describe("the record of a refusal", () => {
	const policy: Policy.Policy = {
		...Policy.empty,
		classifications: ["public", "internal"],
		toolCeilings: { search: "public" },
	};

	it("is written into the result's details for every rule, without the arguments, and the model reads none of it", async () => {
		const { ran, Search, Read, Write } = tools();
		const Extra = recording("extra", ran);
		const NoSecrets = Rule.make("no-secrets", Read, ({ text }) =>
			Effect.succeed(text.includes("launch-codes") ? Rule.block("names the launch-codes") : Rule.allow),
		);
		const Broken = Rule.make("broken", Write, () => Effect.fail(new Error("the lookup is down")));
		// What the model is sent as the result of each call: the text of its tool result messages.
		const read: string[] = [];
		const layer = guardedHarness({
			policy,
			rules: [NoSecrets, Broken],
			extensions: [Extension.make({ name: "app", tools: [Search, Read, Write, Extra] })],
			responses: [
				toolCall("search", { text: "a" }, { id: "call-1" }),
				toolCall("read", { text: "the launch-codes" }, { id: "call-2" }),
				toolCall("write", { text: "c" }, { id: "call-3" }),
				toolCall("extra", { text: "d" }, { id: "call-4" }),
				toolCall("missing", { text: "e" }, { id: "call-5" }),
				toolCall("read", { text: "plain" }, { id: "call-6" }),
				(context) => {
					for (const message of context.messages) {
						if (message.role === "toolResult") read.push(JSON.stringify(message.content));
					}
					return answer("Done.");
				},
			],
		});
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["search", "read", "write"], classification: "internal" },
					});
					// Every tool is offered behind the guard's back, so each call reaches the guard's hook.
					yield* conversation.configure({ ...(yield* TestHarness.agent), tools: null });
					yield* conversation.prompt("Go.");
					yield* conversation.waitForIdle;
					return {
						results: yield* toolResults(conversation),
						records: yield* recorded(conversation),
						refusals: (yield* refused).map(brief),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(ran).toEqual(["read:plain"]);
		expect(seen.records).toEqual([
			["search", { rule: "ceiling" }],
			["read", { rule: "argument", name: "no-secrets" }],
			["write", { rule: "argument-failed", name: "broken" }],
			["extra", { rule: "allow-list" }],
			["missing", { rule: "unavailable" }],
			["read", undefined],
		]);
		// The stream says the same, with the rule's own reason, which the record leaves out.
		expect(seen.refusals).toEqual([
			{ callId: "call-1", tool: "search", rule: "ceiling" },
			{ callId: "call-2", tool: "read", rule: "argument", name: "no-secrets", reason: "names the launch-codes" },
			{ callId: "call-3", tool: "write", rule: "argument-failed", name: "broken" },
			{ callId: "call-4", tool: "extra", rule: "allow-list" },
			{ callId: "call-5", tool: "missing", rule: "unavailable" },
		]);
		// One sentence per refusal, whatever the rule: neither the rule, its name nor its reason reaches the model.
		const sentence = (text: string) => JSON.stringify([{ type: "text", text }]);
		expect(read).toEqual([
			sentence(BLOCKED("search")),
			sentence(BLOCKED("read")),
			sentence(BLOCKED("write")),
			sentence(BLOCKED("extra")),
			sentence(UNAVAILABLE("missing")),
			sentence("read did plain"),
		]);
		expect(JSON.stringify(seen.records)).not.toMatch(/launch-codes|lookup is down/);
	});

	it("is not written for a call another extension blocked, also one that uses the guard's own sentence", async () => {
		const { ran, Search, Read } = tools();
		const Other = Extension.make({
			name: "other",
			hooks: [
				Hook.beforeTool((call) =>
					Effect.succeed(call.name === "read" ? Gate.block("Tool read is not available") : Gate.allow),
				),
			],
		});
		const layer = guardedHarness({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search, Read] }), Other],
			responses: [
				toolCall("read", { text: "a" }, { id: "call-1" }),
				toolCall("search", { text: "b" }, { id: "call-2" }),
				answer("Done."),
			],
		});
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refused = yield* watching;
					const { model } = yield* TestHarness.agent;
					const conversation = yield* Conversations.create({
						ownership: ownerless,
						grant: { tools: ["search", "read"] },
						model,
					});
					yield* conversation.prompt("Go.");
					yield* conversation.waitForIdle;
					return {
						results: yield* toolResults(conversation),
						records: yield* recorded(conversation),
						refusals: yield* refused,
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(ran).toEqual(["search:b"]);
		// The same result as a block of the guard, and no record: the guard decided nothing about it.
		expect(seen.results[0]).toEqual({ tool: "read", isError: true, text: BLOCKED("read"), codes: ["blocked"] });
		expect(seen.records).toEqual([
			["read", undefined],
			["search", undefined],
		]);
		expect(seen.refusals).toEqual([]);
	});

	it("is in the details a later extension's `afterTool` hook reads", async () => {
		const { Search } = tools();
		const Audit = Extension.make({
			name: "audit",
			hooks: [
				Hook.afterTool((_call, result) =>
					Effect.map(Refused.fromDetails(result.details), (refused) =>
						Option.some({ ...result, details: { audit: true, guard: Option.getOrNull(refused) } }),
					),
				),
			],
		});
		const layer = guardedHarness({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search] }), Audit],
			responses: [toolCall("write", { text: "a" }, { id: "call-1" }), answer("Done.")],
		});
		const details = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const conversation = yield* Conversations.create({ ownership: ownerless, grant: { tools: [] }, model });
				yield* conversation.prompt("Go.");
				yield* conversation.waitForIdle;
				const [entry] = (yield* Stream.runCollect(conversation.entries({ order: "ascending" }))).filter(
					(each) => each.model?.[0]?.role === "toolResult",
				);
				const message = entry?.model?.[0];
				return message?.role === "toolResult" ? message.details : undefined;
			}).pipe(Effect.provide(layer)),
		);
		expect(details).toEqual({ audit: true, guard: { rule: "unavailable" } });
	});
});
