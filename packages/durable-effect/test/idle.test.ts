import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type DurableError, Extension, Harness, Idle, Task } from "../src/index.ts";
import { answer, type FauxResponseStep, held, TestHarness } from "../src/testing/index.ts";

/** A task that sleeps until it is aborted: live work that holds no process. */
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

const run = <A, E>(
	effect: Effect.Effect<A, E, TestHarness.Provided>,
	responses: ReadonlyArray<FauxResponseStep> = [answer("Done.")],
) =>
	Effect.runPromise(
		Effect.provide(
			effect,
			TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Waiting] })], responses }),
		),
	);

/** Whether Pi's own wait for idle succeeds at once: what the non-waiting read must agree with. */
const succeedsAtOnce = (wait: Effect.Effect<void, DurableError, Harness.Harness>) =>
	Effect.map(Effect.timeoutOption(wait, "40 millis"), Option.isSome);

/** The answer of the read and of Pi's wait, for the harness and for each conversation, in the order given. */
const both = (conversations: ReadonlyArray<ConversationId>) =>
	Effect.gen(function* () {
		const handles = yield* Effect.forEach(conversations, (id) =>
			Effect.map(Harness.conversation(id), Option.getOrThrow),
		);
		return {
			read: [yield* Harness.isIdle, ...(yield* Effect.forEach(conversations, Harness.isConversationIdle))],
			pi: [
				yield* succeedsAtOnce(Harness.waitForIdle),
				...(yield* Effect.forEach(handles, (handle) => succeedsAtOnce(handle.waitForIdle))),
			],
		};
	});

describe("Harness.isIdle and Harness.isConversationIdle", () => {
	it("answer at once what waitForIdle waits for: busy while a run is going on, idle before and after", async () => {
		const response = held(answer("Late."));
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const other = yield* Harness.createConversation({ ownership: { kind: "ownerless" } });
				const before = yield* both([root.id, other.id]);
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* response.requested;
				const during = yield* both([root.id, other.id]);
				yield* response.release;
				yield* submission.wait;
				yield* Harness.waitForIdle;
				return { before, during, after: yield* both([root.id, other.id]) };
			}),
			[response.response],
		);
		expect(seen.before.read).toEqual([true, true, true]);
		expect(seen.during.read).toEqual([false, false, true]);
		expect(seen.after.read).toEqual([true, true, true]);
		expect([seen.before.read, seen.during.read, seen.after.read]).toEqual([
			seen.before.pi,
			seen.during.pi,
			seen.after.pi,
		]);
	});

	it("follow Pi's scopes: a background task and what is below it count only for the conversation they are in", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const other = yield* Harness.createConversation({ ownership: { kind: "ownerless" } });
				// A background task with a child task, a conversation it owns, and a task in that conversation.
				const background = yield* root.commit((tx) =>
					tx.createTask(Waiting, {}, { ownership: { kind: "conversation" }, background: true }),
				);
				const below = yield* owning(background);
				const quiet = yield* both([root.id, below, other.id]);
				// The same under a task that is not in the background.
				const ordinary = yield* root.commit((tx) =>
					tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } }),
				);
				const owned = yield* owning(ordinary);
				const busy = yield* both([root.id, below, owned, other.id]);
				return { quiet, busy };
			}),
		);
		// The harness and the root are idle; the conversation the background task owns holds a task of its own.
		expect(seen.quiet.read).toEqual([true, true, false, true]);
		expect(seen.quiet.read).toEqual(seen.quiet.pi);
		expect(seen.busy.read).toEqual([false, false, false, false, true]);
		expect(seen.busy.read).toEqual(seen.busy.pi);
	});

	it("are idle for a harness without a live task, also for a conversation that does not exist", async () => {
		const idle = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				// Pi brands ids in the type system only.
				return [
					yield* Harness.isIdle,
					yield* Harness.isConversationIdle(root.id),
					yield* Harness.isConversationIdle(999 as ConversationId),
				];
			}),
		);
		expect(idle).toEqual([true, true, true]);
	});
});

describe("Idle.quiet", () => {
	it("counts a task whose chain of owners cannot be read, as Pi does, and none below a background owner", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const owner = yield* root.commit((tx) =>
					tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } }),
				);
				yield* root.commit((tx) => tx.createTask(Waiting, {}, { ownership: { kind: "task", taskId: owner } }));
				const records = (yield* Harness.inspect).tasks.map((task) => task.record);
				const child = records.filter((record) => record.owner === owner);
				const parent = records.filter((record) => record.id === owner);
				const scope: Idle.Scope = { kind: "conversation", conversationId: root.id };
				const nothing = { task: () => Effect.succeedNone, conversation: () => Effect.succeedNone };
				return {
					unread: yield* Idle.quiet(child, scope, nothing),
					background: yield* Idle.quiet(child, scope, {
						...nothing,
						task: () => Effect.succeedSome({ ...parent[0], background: true } as (typeof records)[number]),
					}),
					inCommit: yield* Harness.commit((tx) => Idle.quiet(records, scope, tx)),
					elsewhere: yield* Harness.commit((tx) =>
						// Pi brands ids in the type system only.
						Idle.quiet(records, { kind: "conversation", conversationId: 999 as ConversationId }, tx),
					),
				};
			}),
		);
		expect(seen).toEqual({ unread: false, background: true, inCommit: false, elsewhere: true });
	});
});

/** Under the task `owner`: a child task, a conversation it owns, and a task in that conversation, whose id it gives. */
function owning(owner: TaskId) {
	return Harness.commit((tx) =>
		Effect.gen(function* () {
			const conversation = yield* tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			yield* tx.createTask(Waiting, {}, { ownership: { kind: "task", taskId: owner } });
			yield* tx.createTask(Waiting, {}, { ownership: { kind: "conversation" }, conversationId: conversation.id });
			return conversation.id;
		}),
	);
}
