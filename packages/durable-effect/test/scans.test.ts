import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId, ConversationRecord, Cursor, Page, TaskRecord } from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { type DurableError, Extension, Harness, type Scans, Storage, Task } from "../src/index.ts";
import { answer, TestHarness } from "../src/testing/index.ts";
import { KeptStorage } from "./scripted.ts";
import { untilTask } from "./until-task.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A task that sleeps until it is aborted: live work to scan for. */
const Waiting = Task.make({
	name: "test.waiting",
	version: 1,
	input: Schema.Struct({}),
	state: Schema.Struct({ phase: Schema.Literal("wait") }),
	result: Schema.Null,
	initial: () => ({ phase: "wait" as const }),
	phases: { wait: (task, api) => Effect.map(api.now, (now) => Task.sleepUntil(now + 3_600_000, task.state)) },
	abort: () => Effect.succeed(Task.aborted()),
});

const harness = (storage?: KeptStorage) =>
	TestHarness.layer({
		extensions: [Extension.make({ name: "app", tasks: [Waiting] })],
		responses: [answer("Done.")],
		...(storage === undefined ? {} : { storage: Storage.custom(storage) }),
	});

/** Every page of one of Pi's scans, read as plain Pi reads them. */
async function all<A>(scan: (cursor: Cursor | undefined) => Promise<Page<A, Cursor>>): Promise<A[]> {
	const items: A[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

describe("Harness.scanConversations", () => {
	it("streams every conversation in id order, page by page, as Pi's scan in a commit gives them", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				yield* Effect.forEach([1, 2, 3], () => root.fork({ at: head, ownership: { kind: "ownerless" } }));
				yield* Harness.createConversation({ ownership: { kind: "ownerless" } });
				const pi = yield* Harness.Harness;
				return {
					paged: yield* Stream.runCollect(Harness.scanConversations({ pageSize: 2 })),
					whole: yield* Stream.runCollect(Harness.scanConversations()),
					descending: yield* Stream.runCollect(Harness.scanConversations({ order: "descending", pageSize: 2 })),
					pi: yield* Effect.promise(() =>
						pi.commit((tx) => all((cursor) => tx.scanConversations({}, 100, cursor)), BACKGROUND_CONTEXT),
					),
					root: root.id,
					head,
				};
			}).pipe(Effect.provide(harness())),
		);
		expect(seen.paged).toEqual(seen.pi);
		expect(seen.whole).toEqual(seen.pi);
		expect(seen.descending).toEqual([...seen.pi].reverse());
		expect(seen.paged).toHaveLength(5);
		expect(seen.paged[1]).toEqual({ id: seen.paged[1]?.id, parent: { conversationId: seen.root, at: seen.head } });
	});

	it("selects by owner with Pi's filters, and reads a page only when it is pulled", async () => {
		const storage = new CountingStorage();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const task = yield* root.commit((tx) =>
					Effect.gen(function* () {
						const id = yield* tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } });
						return id;
					}),
				);
				const owned = yield* Harness.commit((tx) =>
					Effect.forEach([1, 2, 3], () => tx.createConversation({ ownership: { kind: "task", taskId: task } })),
				);
				const before = storage.conversationScans;
				const first = yield* Stream.runCollect(
					Harness.scanConversations({ ownerTaskId: task, pageSize: 1 }).pipe(Stream.take(1)),
				);
				const scansForOne = storage.conversationScans - before;
				const byTask = yield* Stream.runCollect(Harness.scanConversations({ ownerTaskId: task }));
				const byConversation = yield* Stream.runCollect(
					Harness.scanConversations({ ownerConversationId: root.id }),
				);
				yield* Harness.abortTask(task);
				return { owned, first, scansForOne, byTask, byConversation };
			}).pipe(Effect.provide(harness(storage))),
		);
		expect(seen.byTask).toEqual(seen.owned);
		expect(seen.byConversation).toEqual(seen.owned);
		expect(seen.first).toEqual(seen.owned.slice(0, 1));
		// Three pages of one would be three scans: one element pulled at most the page after it.
		expect(seen.scansForOne).toBeLessThan(3);
	});
});

describe("Harness.scanTasks", () => {
	it("streams the stored tasks Pi's filters select, ended ones included, as Pi's scan in a commit gives them", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const waiting = yield* root.commit((tx) =>
					Effect.forEach([1, 2, 3], () => tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } })),
				);
				// Each sleeps for an hour, which the test clock never reaches.
				yield* Effect.forEach(waiting, (id) => untilTask("sleeping", id));
				const pi = yield* Harness.Harness;
				const own = (query: Scans.TasksQuery) =>
					Effect.promise(() =>
						pi.commit((tx) => all((cursor) => tx.scanTasks(query, 100, cursor)), BACKGROUND_CONTEXT),
					);
				const result = {
					waiting,
					all: [yield* Stream.runCollect(Harness.scanTasks({ pageSize: 2 })), yield* own({})],
					sleeping: [
						yield* Stream.runCollect(Harness.scanTasks({ status: "sleeping" })),
						yield* own({ status: "sleeping" }),
					],
					kind: [
						yield* Stream.runCollect(
							Harness.scanTasks({ kind: "test.waiting", order: "descending", pageSize: 1 }),
						),
						yield* own({ kind: "test.waiting", order: "descending" }),
					],
					ended: yield* Stream.runCollect(Harness.scanTasks({ status: "terminal", conversationId: root.id })),
				};
				yield* Effect.forEach(waiting, (id) => Harness.abortTask(id));
				return result;
			}).pipe(Effect.provide(harness())),
		);
		expect(seen.all[0]).toEqual(seen.all[1]);
		expect(seen.sleeping[0]).toEqual(seen.sleeping[1]);
		expect(seen.kind[0]).toEqual(seen.kind[1]);
		expect(seen.sleeping[0]?.map((task) => task.id)).toEqual(seen.waiting);
		expect(seen.kind[0]?.map((task) => task.id)).toEqual([...seen.waiting].reverse());
		// The run that answered: its generation ended, and a scan still finds it.
		expect(seen.ended.map((task) => [task.kind, task.state.status])).toEqual([["pi.generation", "terminal"]]);
	});
});

describe("Harness.conversationRecord", () => {
	it("gives a conversation's stored record: its parent for a fork, its owner for a task's, none for an unknown id", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				const fork = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
				const task = yield* root.commit((tx) =>
					tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } }),
				);
				const owned = yield* Harness.commit((tx) =>
					tx.createConversation({ ownership: { kind: "task", taskId: task } }),
				);
				const records = {
					root: yield* Harness.conversationRecord(root.id),
					fork: yield* Harness.conversationRecord(fork.id),
					owned: yield* Harness.conversationRecord(owned.id),
					// Pi brands ids in the type system only.
					unknown: yield* Harness.conversationRecord(999 as ConversationId),
				};
				yield* Harness.abortTask(task);
				return { records, root: root.id, fork: fork.id, owned, head, task };
			}).pipe(Effect.provide(harness())),
		);
		expect(Option.getOrThrow(seen.records.root)).toEqual({ id: seen.root });
		expect(Option.getOrThrow(seen.records.fork)).toEqual({
			id: seen.fork,
			parent: { conversationId: seen.root, at: seen.head },
		});
		expect(Option.getOrThrow(seen.records.owned)).toEqual(seen.owned);
		expect(seen.owned.owner).toEqual({ conversationId: seen.root, taskId: seen.task });
		expect(Option.isNone(seen.records.unknown)).toBe(true);
	});
});

describe("the scans", () => {
	it("write nothing, so a read-only harness scans too", async () => {
		const storage = new KeptStorage();
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
			}).pipe(Effect.provide(harness(storage))),
		);
		const viewed = await Effect.runPromise(
			Effect.gen(function* () {
				return {
					conversations: (yield* Stream.runCollect(Harness.scanConversations())).length,
					tasks: (yield* Stream.runCollect(Harness.scanTasks())).map((task) => task.kind),
					root: Option.isSome(yield* Harness.conversationRecord(1 as ConversationId)),
				};
			}).pipe(Effect.provide(TestHarness.layer({ storage: Storage.custom(storage), harness: { readOnly: true } }))),
		);
		expect(viewed).toEqual({ conversations: 1, tasks: ["pi.generation"], root: true });
	});

	it("are typed as streams of Pi's records that need only the harness", () => {
		const conversations: Equal<
			ReturnType<typeof Harness.scanConversations>,
			Stream.Stream<ConversationRecord, DurableError, Harness.Harness>
		> = true;
		const tasks: Equal<
			ReturnType<typeof Harness.scanTasks>,
			Stream.Stream<TaskRecord<JsonValue, JsonValue, JsonValue>, DurableError, Harness.Harness>
		> = true;
		expect([conversations, tasks]).toEqual([true, true]);
	});
});

/** A storage that counts the conversation scans Pi asks it for. */
class CountingStorage extends KeptStorage {
	conversationScans = 0;

	override scanConversations(
		...args: Parameters<KeptStorage["scanConversations"]>
	): ReturnType<KeptStorage["scanConversations"]> {
		this.conversationScans += 1;
		return super.scanConversations(...args);
	}
}
