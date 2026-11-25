// Test helper: the suites that need a real SQLite `SqlClient`, registered once per driver by a platform test file:
// a conversation's grant, and the records of its refusals, across a close and a reopen of a SQLite file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Extension, Harness, Storage } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import { Conversations, Policy, Rule } from "../src/index.ts";
import {
	BLOCKED,
	brief,
	guardedHarness,
	offering,
	recorded,
	toolResults,
	tools,
	UNAVAILABLE,
	watching,
} from "./guarded.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

const policy: Policy.Policy = {
	...Policy.empty,
	classifications: ["public", "internal"],
	toolCeilings: { search: "public" },
};

/** Registers the suite for one driver. `describe` skips it on the other runtime. */
export function registerSqliteSuites(
	describe: (name: string, body: () => void) => void,
	driver: string,
	client: ClientLayer,
): void {
	describe(`a grant on a SQLite file (${driver})`, () => {
		it("survives a close and a reopen: the same tools are offered, and the same calls refused", () =>
			withDatabaseFile(async (filename) => {
				const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
				const { ran, Search, Read, Write } = tools();
				const offered: string[][] = [];
				// Every build is a fresh process's worth: a new registry, a new guard, a new harness on the same file.
				const harness = (responses: ReadonlyArray<FauxResponseStep>) =>
					guardedHarness({
						policy,
						extensions: [Extension.make({ name: "app", tools: [Search, Read, Write] })],
						responses,
						storage,
					});

				const id = await Effect.runPromise(
					Effect.gen(function* () {
						const { model } = yield* TestHarness.agent;
						const conversation = yield* Conversations.create({
							ownership: { kind: "ownerless" },
							grant: { tools: ["read", "search"], classification: "internal" },
						});
						yield* conversation.configure({ model });
						yield* conversation.prompt("Hello.");
						yield* conversation.waitForIdle;
						return conversation.id;
					}).pipe(Effect.provide(harness([offering(offered, "Hello.")]))),
				);

				const reopened = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const refused = yield* watching;
							const conversation = Option.getOrThrow(yield* Harness.conversation(id));
							const granted = yield* Conversations.granted(id);
							const enabled = (yield* conversation.agent).tools.map((tool) => tool.name);
							yield* conversation.prompt("Write a, read b.");
							yield* conversation.waitForIdle;
							// Pi's choices changed behind the guard's back, on the reopened storage.
							yield* conversation.configure({ tools: null });
							yield* conversation.prompt("Write c, search d.");
							yield* conversation.waitForIdle;
							return {
								granted,
								enabled,
								results: (yield* toolResults(conversation)).map((result) => [result.tool, result.text]),
								refusals: (yield* refused).map(brief),
							};
						}),
					).pipe(
						Effect.provide(
							harness([
								toolCall("write", { text: "a" }, { id: "call-1" }),
								toolCall("read", { text: "b" }, { id: "call-2" }),
								offering(offered, "Read."),
								toolCall("write", { text: "c" }, { id: "call-3" }),
								toolCall("search", { text: "d" }, { id: "call-4" }),
								answer("Nothing more."),
							]),
						),
					),
				);

				expect(reopened.granted).toEqual({ tools: ["read", "search"], classification: "internal" });
				expect(reopened.enabled).toEqual(["read", "search"]);
				expect(offered).toEqual([
					["read", "search"],
					["read", "search"],
				]);
				expect(ran).toEqual(["read:b"]);
				expect(reopened.results).toEqual([
					["write", UNAVAILABLE("write")],
					["read", "read did b"],
					["write", BLOCKED("write")],
					["search", BLOCKED("search")],
				]);
				expect(reopened.refusals).toEqual([
					{ callId: "call-1", tool: "write", rule: "unavailable" },
					{ callId: "call-3", tool: "write", rule: "allow-list" },
					{ callId: "call-4", tool: "search", rule: "ceiling" },
				]);
			}));
	});

	describe(`the records of refusals on a SQLite file (${driver})`, () => {
		it("survive a close and a reopen: a new process counts and attributes them from the entries", () =>
			withDatabaseFile(async (filename) => {
				const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
				const { ran, Search, Read, Write } = tools();
				const NoSecrets = Rule.make("no-secrets", Read, ({ text }) =>
					Effect.succeed(text.includes("launch-codes") ? Rule.block("names the launch-codes") : Rule.allow),
				);
				const harness = (responses: ReadonlyArray<FauxResponseStep>) =>
					guardedHarness({
						policy,
						rules: [NoSecrets],
						extensions: [Extension.make({ name: "app", tools: [Search, Read, Write] })],
						responses,
						storage,
					});

				const first = await Effect.runPromise(
					Effect.gen(function* () {
						const conversation = yield* Conversations.create({
							ownership: { kind: "ownerless" },
							grant: { tools: ["read", "search"], classification: "internal" },
						});
						// Every tool is offered behind the guard's back, so each call reaches the guard's hook.
						yield* conversation.configure({ ...(yield* TestHarness.agent), tools: null });
						yield* conversation.prompt("Go.");
						yield* conversation.waitForIdle;
						return { id: conversation.id, records: yield* recorded(conversation) };
					}).pipe(
						Effect.provide(
							harness([
								toolCall("write", { text: "a" }, { id: "call-1" }),
								toolCall("search", { text: "b" }, { id: "call-2" }),
								toolCall("read", { text: "the launch-codes" }, { id: "call-3" }),
								toolCall("missing", { text: "d" }, { id: "call-4" }),
								toolCall("read", { text: "e" }, { id: "call-5" }),
								answer("Done."),
							]),
						),
					),
				);

				// A new process: nothing of the first one's memory is left, and nothing is asked again.
				const reopened = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const refused = yield* watching;
							const conversation = Option.getOrThrow(yield* Harness.conversation(first.id));
							const records = yield* recorded(conversation);
							const counts: Record<string, number> = {};
							for (const [, record] of records) {
								if (record !== undefined) counts[record.rule] = (counts[record.rule] ?? 0) + 1;
							}
							return { records, counts, published: yield* refused };
						}),
					).pipe(Effect.provide(harness([]))),
				);

				const expected = [
					["write", { rule: "allow-list" }],
					["search", { rule: "ceiling" }],
					["read", { rule: "argument", name: "no-secrets" }],
					["missing", { rule: "unavailable" }],
					["read", undefined],
				];
				expect(ran).toEqual(["read:e"]);
				expect(first.records).toEqual(expected);
				expect(reopened.records).toEqual(expected);
				expect(reopened.counts).toEqual({ "allow-list": 1, ceiling: 1, argument: 1, unavailable: 1 });
				expect(reopened.published).toEqual([]);
			}));
	});
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-guard-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
