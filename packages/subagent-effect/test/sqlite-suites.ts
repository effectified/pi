// Test helper: the suites that close a harness in the middle of a child's work and reopen it on the same SQLite file,
// and those that open a copy of that file as a host opens a copied storage, registered once per driver by a platform
// test file.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness, Storage } from "@effectified/pi-durable";
import { answer, type FauxResponseStep, held, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import { ChildSetup, onStorageFork, Subagents } from "../src/index.ts";
import {
	childOf,
	children,
	conversation,
	entriesOf,
	harness,
	parent,
	routed,
	said,
	toolResults,
	worker,
} from "./scene.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

const { foreground, background } = Subagents.TOOLS;

/** What the document of a child says whose run was copied with its storage. */
const COPIED = {
	_tag: "Failed",
	reason: "copied",
	message:
		"The subagent did not go on in this copy of its storage: its work stayed where it was copied from. Start it again if you still need it.",
	answer: null,
};

/** Registers the suites for one driver. `describe` skips them on the other runtime. */
export function registerSqliteSuites(
	describe: (name: string, body: () => void) => void,
	driver: string,
	client: ClientLayer,
): void {
	/**
	 * Two processes on one file, one after the other. Every build of the Layer is a fresh process's worth: a new
	 * registry, new scripted models and a new harness on the same data. `asked` gets the model of every request.
	 */
	const processes = (
		filename: string,
		config: Subagents.Config,
		asked: string[],
		options: { readonly resume?: boolean; readonly setup?: Layer.Layer<ChildSetup.ChildSetup> } = {},
	) => {
		const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
		return (queues: {
			readonly parent?: ReadonlyArray<FauxResponseStep>;
			readonly child?: ReadonlyArray<FauxResponseStep>;
		}) => harness({ config, storage, responses: routed(queues, asked), ...options }).layer;
	};

	describe(`a foreground child across a restart (${driver})`, () => {
		it("is created once, and the parent's call completes with its answer after the reopen", () =>
			withDatabaseFile(async (filename) => {
				const asked: string[] = [];
				const config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 };
				const process = processes(filename, config, asked);
				const input = { type: "input", content: "Ask the researcher.", requestId: "run" } as const;
				// The first process stops while the child is in the middle of its model request.
				const cut = held(answer("Never given."));
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* root.submit(input);
						yield* cut.requested;
						const [child] = yield* children;
						const id = child?.id as ConversationId;
						return { id, record: yield* childOf(id), children: (yield* children).length };
					}).pipe(
						Effect.provide(
							process({
								parent: [toolCall(foreground, { subagent: "researcher", task: "What is six times seven?" })],
								child: [cut.response],
							}),
						),
					),
				);
				expect(before.children).toBe(1);
				expect(before.record.state).toEqual({ _tag: "Running" });
				expect(asked).toEqual(["parent", "child"]);

				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						// The same request id finds the submission the first process admitted.
						const settled = yield* (yield* root.submit(input)).wait;
						yield* Harness.waitForIdle;
						const ofRoot = yield* entriesOf(root);
						return {
							settled: settled.status,
							children: (yield* children).map((record) => record.id),
							record: yield* childOf(before.id),
							kinds: ofRoot.map((entry) => entry.kind),
							results: toolResults(ofRoot),
							child: said(yield* entriesOf(yield* conversation(before.id))),
						};
					}).pipe(
						Effect.provide(process({ parent: [answer("It is forty-two.")], child: [answer("Forty-two.")] })),
					),
				);
				expect(after.settled).toBe("done");
				// One child, the one the first process made: neither the call nor its run started a second.
				expect(after.children).toEqual([before.id]);
				expect(after.record).toMatchObject({ task: before.record.task, state: { _tag: "Answered" } });
				expect(after.kinds).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"]);
				expect(after.results).toEqual([
					{
						tool: "subagent",
						isError: false,
						text: "Forty-two.",
						details: {
							conversationId: before.id,
							handle: String(before.id),
							subagent: "researcher",
							mode: "foreground",
							status: "answered",
						},
					},
				]);
				// The child got its task once; the request the close stopped was sent again.
				expect(after.child).toEqual(["user: What is six times seven?", "assistant: Forty-two."]);
				// The parent's model is asked twice in all: for the call before the restart, for its answer after it.
				expect(asked).toEqual(["parent", "child", "child", "parent"]);
			}));
	});

	describe(`a background child across a restart (${driver})`, () => {
		it("is created once, and its result reaches the parent once after the reopen", () =>
			withDatabaseFile(async (filename) => {
				const asked: string[] = [];
				const config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 };
				const process = processes(filename, config, asked);
				const cut = held(answer("Never given."));
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						// The parent's own run ends while the child is still in its model request.
						const settled = yield* root.prompt("Find the capital, in the background.");
						yield* root.waitForIdle;
						yield* cut.requested;
						const [child] = yield* children;
						const id = child?.id as ConversationId;
						return { settled: settled.status, id, record: yield* childOf(id) };
					}).pipe(
						Effect.provide(
							process({
								parent: [
									toolCall(background, { subagent: "researcher", task: "Name the capital of France." }),
									answer("I asked the researcher."),
								],
								child: [cut.response],
							}),
						),
					),
				);
				expect(before.settled).toBe("done");
				expect(before.record.state).toEqual({ _tag: "Running" });
				expect(asked.toSorted()).toEqual(["child", "parent", "parent"]);

				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						// Nothing is submitted: the reopened harness continues the child, and the result starts a turn.
						yield* Harness.waitForTask(before.record.task);
						yield* root.waitForIdle;
						const ofRoot = yield* entriesOf(root);
						return {
							children: (yield* children).map((record) => record.id),
							record: yield* childOf(before.id),
							reports: ofRoot.filter((entry) => entry.kind === "subagent.report").length,
							said: said(ofRoot),
							child: said(yield* entriesOf(yield* conversation(before.id))),
						};
					}).pipe(
						Effect.provide(process({ parent: [answer("The capital is Paris.")], child: [answer("Paris.")] })),
					),
				);
				expect(after.children).toEqual([before.id]);
				expect(after.record).toMatchObject({ task: before.record.task, state: { _tag: "Answered" } });
				expect(after.reports).toBe(1);
				expect(after.said).toEqual([
					"user: Find the capital, in the background.",
					"assistant: I asked the researcher.",
					`user: [subagent researcher, handle ${before.id}, finished]\nParis.`,
					"assistant: The capital is Paris.",
				]);
				expect(after.child).toEqual(["user: Name the capital of France.", "assistant: Paris."]);
				// The parent's model is asked three times in all: twice in its own run, once for the result.
				expect(asked.slice(3)).toEqual(["child", "parent"]);
				expect(asked.filter((model) => model === "parent")).toHaveLength(3);
			}));
	});

	describe(`the limit on live children across a restart (${driver})`, () => {
		it("still counts a child that was started before the restart", () =>
			withDatabaseFile(async (filename) => {
				const asked: string[] = [];
				const config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 };
				const process = processes(filename, config, asked);
				const start = (task: string) => toolCall(background, { subagent: "researcher", task });
				const cut = held(answer("Never given."));
				await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* root.prompt("Start one.");
						yield* root.waitForIdle;
						yield* cut.requested;
					}).pipe(Effect.provide(process({ parent: [start("One."), answer("Started.")], child: [cut.response] }))),
				);

				const working = held(answer("One."));
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* working.requested;
						yield* root.prompt("Start another.");
						yield* root.waitForIdle;
						const results = toolResults(yield* entriesOf(root)).slice(1);
						yield* working.release;
						yield* Harness.waitForIdle;
						return { results, children: (yield* children).length };
					}).pipe(
						Effect.provide(
							process({
								parent: [start("Two."), answer("It was refused."), answer("Noted.")],
								child: [working.response],
							}),
						),
					),
				);
				expect(after.results).toEqual([
					{
						tool: "subagent_start",
						isError: true,
						text: "This agent already has as many subagents at work as it may have (1): wait for one to finish",
						details: { status: "refused", reason: "TooManyChildren" },
					},
				]);
				expect(after.children).toBe(1);
			}));
	});

	describe(`a copied storage (${driver})`, () => {
		const config = { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 };
		const start = toolCall(background, { subagent: "researcher", task: "Name the capital of France." });
		/** The run task of the child `id`, as it ended. */
		const runOf = (task: Parameters<typeof Harness.waitForTask>[0]) =>
			Effect.map(Harness.waitForTask(task), (settled) => settled.state.outcome);
		/** What the parent's conversation holds of its subagents: the reports it was sent, and what was said in it. */
		const parentSaw = Effect.gen(function* () {
			const ofRoot = yield* entriesOf(yield* parent);
			return { reports: ofRoot.filter((entry) => entry.kind === "subagent.report").length, said: said(ofRoot) };
		});

		it("ends a background run it inherited in the middle of its child's request: no request, no report, and the original finishes", () =>
			withDatabaseFile(async (filename) => {
				const copy = `${filename}.copy`;
				const asked: string[] = [];
				const cut = held(answer("Never given."));
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* root.prompt("Find the capital, in the background.");
						yield* root.waitForIdle;
						yield* cut.requested;
						const [child] = yield* children;
						const id = child?.id as ConversationId;
						// What a storage fork copies: the whole storage, with the live run and its child's open request.
						copyDatabaseFile(filename, copy);
						return { id, record: yield* childOf(id) };
					}).pipe(
						Effect.provide(
							processes(
								filename,
								config,
								asked,
							)({ parent: [start, answer("I asked the researcher.")], child: [cut.response] }),
						),
					),
				);
				expect(before.record.state).toEqual({ _tag: "Running" });

				const inCopy: string[] = [];
				const copied = await Effect.runPromise(
					Effect.gen(function* () {
						yield* onStorageFork;
						// A host that was cut off in the middle runs every step again.
						yield* onStorageFork;
						yield* Harness.resume;
						const run = yield* runOf(before.record.task);
						yield* Harness.waitForIdle;
						const inherited = {
							run,
							asked: [...inCopy],
							record: yield* childOf(before.id),
							parent: yield* parentSaw,
							child: said(yield* entriesOf(yield* conversation(before.id))),
						};
						// A subagent started on the copy is the copy's own: it works, and its result arrives.
						const root = yield* parent;
						yield* root.prompt("Ask again.");
						const own = (yield* children).find((record) => record.id !== before.id)?.id as ConversationId;
						yield* Harness.waitForTask((yield* childOf(own)).task);
						yield* root.waitForIdle;
						return { inherited, own: yield* childOf(own), parent: yield* parentSaw };
					}).pipe(
						Effect.provide(
							processes(copy, config, inCopy, { resume: false })({
								parent: [start, answer("I asked again."), answer("The copy says Lyon.")],
								child: [answer("Lyon.")],
							}),
						),
					),
				);
				expect(copied.inherited.run).toEqual({ status: "aborted", reason: "copied" });
				// Neither the run nor its child's request, which the copy held in flight, reached a provider.
				expect(copied.inherited.asked).toEqual([]);
				expect(copied.inherited.record).toMatchObject({ task: before.record.task, state: COPIED });
				expect(copied.inherited.parent).toEqual({
					reports: 0,
					said: ["user: Find the capital, in the background.", "assistant: I asked the researcher."],
				});
				expect(copied.inherited.child).toEqual(["user: Name the capital of France."]);
				expect(copied.own.state).toMatchObject({ _tag: "Answered" });
				expect(copied.parent.reports).toBe(1);
				expect(copied.parent.said.at(-1)).toBe("assistant: The copy says Lyon.");

				// The storage it was copied from goes on: the request the close stopped is sent again and answered.
				const original = await Effect.runPromise(
					Effect.gen(function* () {
						yield* Harness.waitForTask(before.record.task);
						yield* (yield* parent).waitForIdle;
						return { record: yield* childOf(before.id), parent: yield* parentSaw };
					}).pipe(
						Effect.provide(
							processes(
								filename,
								config,
								asked,
							)({ parent: [answer("The capital is Paris.")], child: [answer("Paris.")] }),
						),
					),
				);
				expect(original.record).toMatchObject({ task: before.record.task, state: { _tag: "Answered" } });
				expect(original.parent).toEqual({
					reports: 1,
					said: [
						"user: Find the capital, in the background.",
						"assistant: I asked the researcher.",
						`user: [subagent researcher, handle ${before.id}, finished]\nParis.`,
						"assistant: The capital is Paris.",
					],
				});
			}));

		it("ends a background run it inherited before its child got its task: the setup port is not asked again", () =>
			withDatabaseFile(async (filename) => {
				const copy = `${filename}.copy`;
				const asked: string[] = [];
				// The window a host leaves open: the run is live and its child has no submission yet.
				const reached = Promise.withResolvers<void>();
				const holding = Layer.succeed(ChildSetup.ChildSetup, {
					created: () => Effect.void,
					beforeStart: () =>
						Effect.suspend(() => {
							reached.resolve();
							return Effect.never;
						}),
				});
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* root.prompt("Find the capital, in the background.");
						yield* root.waitForIdle;
						yield* Effect.promise(() => reached.promise);
						const [child] = yield* children;
						const id = child?.id as ConversationId;
						// Nothing in the storage is in flight but the background run: what a Rivet actor is forked with.
						const entries = yield* entriesOf(yield* conversation(id));
						copyDatabaseFile(filename, copy);
						return { id, record: yield* childOf(id), entries: entries.length };
					}).pipe(
						Effect.provide(
							processes(filename, config, asked, { setup: holding })({
								parent: [start, answer("I asked the researcher.")],
							}),
						),
					),
				);
				expect(before.entries).toBe(0);

				const inCopy: string[] = [];
				let setups = 0;
				const counting = Layer.succeed(ChildSetup.ChildSetup, {
					created: () => Effect.void,
					beforeStart: () =>
						Effect.sync(() => {
							setups += 1;
						}),
				});
				const copied = await Effect.runPromise(
					Effect.gen(function* () {
						yield* onStorageFork;
						yield* Harness.resume;
						const run = yield* runOf(before.record.task);
						yield* Harness.waitForIdle;
						return {
							run,
							record: yield* childOf(before.id),
							parent: yield* parentSaw,
							entries: (yield* entriesOf(yield* conversation(before.id))).length,
						};
					}).pipe(Effect.provide(processes(copy, config, inCopy, { resume: false, setup: counting })({}))),
				);
				expect(copied.run).toEqual({ status: "aborted", reason: "copied" });
				expect([inCopy, setups, copied.entries]).toEqual([[], 0, 0]);
				expect(copied.record.state).toEqual(COPIED);
				expect(copied.parent.reports).toBe(0);

				// In the storage it was copied from the run starts its phase again, and the child works.
				const original = await Effect.runPromise(
					Effect.gen(function* () {
						yield* Harness.waitForTask(before.record.task);
						yield* (yield* parent).waitForIdle;
						return { record: yield* childOf(before.id), parent: yield* parentSaw };
					}).pipe(
						Effect.provide(
							processes(
								filename,
								config,
								asked,
							)({ parent: [answer("The capital is Paris.")], child: [answer("Paris.")] }),
						),
					),
				);
				expect(original.record.state).toMatchObject({ _tag: "Answered" });
				expect(original.parent.reports).toBe(1);
			}));

		it("ends a foreground run it inherited the same way: the waiting call gets an error result that says so", () =>
			withDatabaseFile(async (filename) => {
				const copy = `${filename}.copy`;
				const cut = held(answer("Never given."));
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* parent;
						yield* root.submit({ type: "input", content: "Ask the researcher.", requestId: "run" });
						yield* cut.requested;
						const [child] = yield* children;
						copyDatabaseFile(filename, copy);
						return { id: child?.id as ConversationId };
					}).pipe(
						Effect.provide(
							processes(
								filename,
								config,
								[],
							)({
								parent: [toolCall(foreground, { subagent: "researcher", task: "What is six times seven?" })],
								child: [cut.response],
							}),
						),
					),
				);

				// A host that refuses to copy work in flight never makes this copy: the parent's own run is in it.
				const inCopy: string[] = [];
				const copied = await Effect.runPromise(
					Effect.gen(function* () {
						yield* onStorageFork;
						const root = yield* parent;
						const input = { type: "input", content: "Ask the researcher.", requestId: "run" } as const;
						const settled = yield* (yield* root.submit(input)).wait;
						yield* Harness.waitForIdle;
						return {
							settled: settled.status,
							record: yield* childOf(before.id),
							results: toolResults(yield* entriesOf(root)),
						};
					}).pipe(
						Effect.provide(
							processes(copy, config, inCopy, { resume: false })({ parent: [answer("It did not answer.")] }),
						),
					),
				);
				expect(copied.settled).toBe("done");
				expect(copied.record.state).toEqual(COPIED);
				// The child's request was not sent again; the parent's model read why its call failed.
				expect(inCopy).toEqual(["parent"]);
				expect(copied.results).toEqual([
					{
						tool: "subagent",
						isError: true,
						text: COPIED.message,
						details: {
							conversationId: before.id,
							handle: String(before.id),
							subagent: "researcher",
							mode: "foreground",
							status: "failed",
							reason: "copied",
						},
					},
				]);
			}));
	});
}

/** Copies a database file as it is on disk now, with its write-ahead log: what a storage fork copies. */
function copyDatabaseFile(from: string, to: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
	}
}

/** Runs `use` with the path of a database file that is removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
