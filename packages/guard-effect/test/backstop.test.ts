import { defineExtension } from "@earendil-works/pi-durable";
import { Extension, Harness, Registry } from "@gunta/pi-durable-effect";
import { answer, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Conversations, Guard, Policy } from "../src/index.ts";
import { BLOCKED, brief, guardedHarness, recorded, toolResults, tools, watching } from "./guarded.ts";

/** One call of the granted tool `search` in a conversation that selects `extensions`. */
function searched(extensions: ReadonlyArray<string> | null) {
	const { ran, Search } = tools();
	const layer = guardedHarness({
		policy: Policy.empty,
		extensions: [Extension.make({ name: "approvals" }), Extension.make({ name: "app", tools: [Search] })],
		responses: [toolCall("search", { text: "a" }, { id: "call-1" }), answer("Done.")],
	});
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const refused = yield* watching;
				const { model } = yield* TestHarness.agent;
				const conversation = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: ["search"] },
					model,
				});
				// Pi's own choice of extensions, changed without the guard.
				yield* conversation.configure({ extensions });
				yield* conversation.prompt("Search a.");
				yield* conversation.waitForIdle;
				const refusals = yield* refused;
				return {
					ran,
					results: yield* toolResults(conversation),
					records: yield* recorded(conversation),
					refusals: refusals.map(brief),
					about: refusals.map((refusal) => refusal.conversationId === conversation.id),
				};
			}),
		).pipe(Effect.provide(layer)),
	);
}

describe("backstopped", () => {
	it("runs a tool in a conversation that asks the guard's extension first", async () => {
		const expected = {
			ran: ["search:a"],
			results: [{ tool: "search", isError: false, text: "search did a", codes: [] }],
			records: [["search", undefined]],
			refusals: [],
			about: [],
		};
		expect(await searched(null)).toEqual(expected);
		expect(await searched(["guard", "app"])).toEqual(expected);
	});

	it("refuses to run a tool in a conversation whose selection leaves the guard's extension out", async () => {
		expect(await searched(["app"])).toEqual({
			ran: [],
			results: [{ tool: "search", isError: true, text: BLOCKED("search"), codes: ["blocked"] }],
			// Written by the tool itself: where the guard's extension is not selected, its hooks are not asked.
			records: [["search", { rule: "guard-not-first" }]],
			refusals: [{ callId: "call-1", tool: "search", rule: "guard-not-first" }],
			about: [true],
		});
	});

	it("refuses to run a tool in a conversation that asks another extension before the guard's", async () => {
		expect(await searched(["approvals", "guard", "app"])).toEqual({
			ran: [],
			results: [{ tool: "search", isError: true, text: BLOCKED("search"), codes: ["blocked"] }],
			// Written by the tool itself: where the guard's extension is not selected, its hooks are not asked.
			records: [["search", { rule: "guard-not-first" }]],
			refusals: [{ callId: "call-1", tool: "search", rule: "guard-not-first" }],
			about: [true],
		});
	});

	it("refuses to run a tool once another extension was installed under the guard's name", async () => {
		const { ran, Search } = tools();
		const layer = guardedHarness({
			policy: Policy.empty,
			extensions: [Extension.make({ name: "app", tools: [Search] })],
			responses: [toolCall("search", { text: "a" }, { id: "call-1" }), answer("Done.")],
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { model } = yield* TestHarness.agent;
				const conversation = yield* Conversations.create({
					ownership: { kind: "ownerless" },
					grant: { tools: ["search"] },
					model,
				});
				// Pi replaces an installed extension of the same name in place: the guard's hooks are gone.
				yield* Registry.Registry.use((registry) =>
					Effect.sync(() => registry.install(defineExtension({ name: Guard.EXTENSION }))),
				);
				const unguarded = yield* Effect.flip(Conversations.guarded(conversation));
				yield* conversation.prompt("Search a.");
				yield* conversation.waitForIdle;
				return { unguarded, records: yield* recorded(conversation) };
			}).pipe(Effect.provide(layer)),
		);
		expect(ran).toEqual([]);
		expect(seen.unguarded).toMatchObject({ _tag: "Unguarded", reason: "not-selected" });
		expect(seen.records).toEqual([["search", { rule: "guard-not-first" }]]);
	});

	it("leaves a tool's registration as it was otherwise", async () => {
		const { Search } = tools();
		const names = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: { tools: ["search"] } });
				const [search] = (yield* root.agent).tools;
				return { name: search?.name, description: search?.description, parameters: search?.parameters };
			}).pipe(
				Effect.provide(
					guardedHarness({ policy: Policy.empty, extensions: [Extension.make({ name: "app", tools: [Search] })] }),
				),
			),
		);
		expect(names).toEqual({
			name: "search",
			description: "The search tool.",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
		});
	});
});
