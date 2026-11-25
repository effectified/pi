import {
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
	SubmissionSettled as PiSubmissionSettled,
	type SettledSubmissionRecord,
	type SubmissionNotify,
} from "@earendil-works/pi-durable";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Conversation, Entry, Extension, Harness, Registry, Signal, Task, Tool } from "../src/index.ts";
import { answer, held, TestHarness, toolCall } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT } from "./scripted.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const KEY = "relay";

/**
 * A task that asks a conversation of its own and holds no process until that conversation answered: it creates the
 * conversation, submits the question with `notify`, sleeps on the settlement, and completes with what was delivered.
 */
const Relay = Task.make({
	name: "test.relay",
	version: 1,
	input: Schema.Struct({ question: Schema.String }),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("create") }),
		Schema.Struct({ phase: Schema.Literal("ask"), child: Conversation.Id }),
		Schema.Struct({ phase: Schema.Literal("answered"), child: Conversation.Id }),
	]),
	result: Schema.Struct({ status: Schema.String, answer: Schema.optionalKey(Entry.Id) }),
	initial: () => ({ phase: "create" as const }),
	phases: {
		create: (_task, api) =>
			api.commit((tx) =>
				Effect.map(tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }), (child) =>
					Task.next({ phase: "ask" as const, child: child.id }),
				),
			),
		ask: (task, api) =>
			Effect.gen(function* () {
				const child = Option.getOrThrow(yield* api.conversation(task.state.child));
				// The request id makes a phase that runs again find the submission it already made.
				yield* child.submit({
					type: "input",
					content: task.input.question,
					requestId: KEY,
					notify: { taskId: api.taskId, key: KEY },
				});
				return Task.sleep({
					state: { phase: "answered" as const, child: task.state.child },
					signals: [Signal.SubmissionSettled.key(KEY)],
				});
			}),
		answered: (_task, api) =>
			Effect.map(api.readSignal(Signal.SubmissionSettled, KEY), (state) => {
				const settled = Option.getOrThrow(state);
				if (settled.kind === "expired") return Task.fail({ message: "expired" });
				const { status, answer } = settled.value;
				return Task.complete({ status, ...(answer === undefined ? {} : { answer }) });
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

type RelayState =
	| { phase: "create" }
	| { phase: "ask"; child: ConversationId }
	| { phase: "answered"; child: ConversationId };

/** The same task in plain Pi Durable. */
const PiRelay = defineTask<{ question: string }, RelayState, { status: string; answer?: EntryId }>({
	name: "test.relay",
	version: 1,
	initial: () => ({ phase: "create" }),
	phases: {
		create: (_task, runtime, context) =>
			runtime.commit(async (tx) => {
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
				return { status: "running", checkpoint: { phase: "ask", child: child.id } };
			}, context),
		ask: async (task, runtime, context) => {
			const { child } = task.state.checkpoint;
			const handle = await runtime.conversation(child, context);
			await handle?.submit(
				{
					type: "input",
					content: task.input.question,
					requestId: KEY,
					notify: { taskId: runtime.taskId, key: KEY },
				},
				context,
			);
			await runtime.commit(
				() => ({
					status: "sleeping",
					signals: [PiSubmissionSettled.key(KEY)],
					checkpoint: { phase: "answered", child },
				}),
				context,
			);
		},
		answered: async (_task, runtime, context) => {
			const state = await runtime.readSignal(PiSubmissionSettled, KEY, context);
			if (state?.kind !== "value") throw new Error("no settlement");
			const { status, answer } = state.value;
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: { status, ...(answer === undefined ? {} : { answer }) } },
				}),
				context,
			);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

describe("SubmissionSettled", () => {
	it("is Pi's built-in signal, with Pi's record as its value and Pi's token underneath", async () => {
		const token = await Effect.runPromise(Signal.SubmissionSettled.token);
		const value: Equal<(typeof Signal.SubmissionSettled.schema)["Type"], SettledSubmissionRecord> = true;
		const notify: Equal<Conversation.PromptOptions["notify"], SubmissionNotify | undefined> = true;
		expect(token).toBe(PiSubmissionSettled);
		expect([Signal.SubmissionSettled.name, Signal.SubmissionSettled.version]).toEqual(["pi.submission-settled", 1]);
		expect(await Effect.runPromise(Signal.toPiKey(Signal.SubmissionSettled.key("a")))).toEqual(
			PiSubmissionSettled.key("a"),
		);
		expect([value, notify]).toEqual([true, true]);
	});

	it("wakes a task that sleeps on the settlement of a submission it made in another conversation", async () => {
		const response = held(answer("Forty-two."));
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Relay, { question: "Six times seven?" }, { ownership: { kind: "conversation" } }),
				);
				yield* response.requested;
				// Parked: the task holds no invocation while the other conversation works.
				const parked = (yield* Harness.inspect).tasks.find((task) => task.record.id === id)?.state.kind;
				const early = yield* Harness.signalState(id, Signal.SubmissionSettled, KEY);
				yield* response.release;
				const settled = yield* Harness.waitForTaskOf(Relay, id);
				const owned = yield* Stream.runCollect(Harness.scanConversations({ ownerTaskId: id }));
				return { parked, early: Option.isNone(early), outcome: settled.state.outcome, owned, root: root.id, id };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Relay] })],
						responses: [response.response],
					}),
				),
			),
		);
		expect(seen.parked).toBe("sleeping");
		expect(seen.early).toBe(true);
		expect(seen.outcome).toMatchObject({ status: "completed", result: { status: "done" } });
		expect(seen.owned).toMatchObject([{ owner: { conversationId: seen.root, taskId: seen.id } }]);
	});

	it("leaves the records plain Pi leaves for the same task", async () => {
		const both = await runBoth({
			responses: () => [answer("Forty-two.")],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tasks: [Relay] })]),
				pi: [defineExtension({ name: "app", tasks: [PiRelay] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* root.commit((tx) =>
					tx.createTask(Relay, { question: "Six times seven?" }, { ownership: { kind: "conversation" } }),
				);
				return (yield* Harness.waitForTaskOf(Relay, id)).state.outcome;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const id = await root.commit(
					(tx) =>
						tx.createTask(PiRelay, { question: "Six times seven?" }, { ownership: { kind: "conversation" } }),
					context,
				);
				return (await harness.waitForTask(id, context)).state.outcome;
			},
		});
		expect(both.effect.result).toMatchObject({ status: "completed", result: { status: "done" } });
		expect(both.effect.records.submissions).toMatchObject([{ status: "done", notify: { key: KEY }, requestId: KEY }]);
		expect(both.effect).toEqual(both.pi);
	});

	it("wakes a tool call that parked on the settlement, which then reads the record", async () => {
		const Delegate = Tool.make("delegate", {
			description: "Asks a conversation of its own and waits for it without holding a process.",
			parameters: Schema.Struct({ question: Schema.String }),
			success: Schema.String,
			handler: ({ question }, api) =>
				Effect.gen(function* () {
					const settled = yield* api.readSignal(Signal.SubmissionSettled, api.callId);
					if (Option.isSome(settled)) {
						return settled.value.kind === "value" ? `Settled ${settled.value.value.status}.` : "Expired.";
					}
					const child = yield* api.commit((tx) =>
						Effect.gen(function* () {
							const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
							if (existing !== undefined) return existing.id;
							const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
							yield* tx.configure(created.id, { tools: { remove: ["delegate"] } });
							return created.id;
						}),
					);
					const handle = Option.getOrThrow(yield* api.conversation(child));
					yield* handle.submit({
						type: "input",
						content: question,
						requestId: api.callId,
						notify: { taskId: api.taskId, key: api.callId },
					});
					return Tool.sleep({ signals: [Signal.SubmissionSettled.key(api.callId)] });
				}),
		});
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Delegate it.");
				yield* root.waitForIdle;
				const context = yield* root.context();
				return context.messages.flatMap((message) =>
					message.role === "toolResult"
						? message.content.map((part) => (part.type === "text" ? part.text : ""))
						: [],
				);
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Delegate] })],
						responses: [
							toolCall("delegate", { question: "Six times seven?" }, { id: "call-1" }),
							answer("Forty-two."),
							answer("It is forty-two."),
						],
					}),
				),
			),
		);
		expect(results).toEqual(["Settled done."]);
	});

	it("passes a value delivered by hand to Pi, which refuses another shape as invalid", async () => {
		const response = held(answer("Forty-two."));
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Relay, { question: "Six times seven?" }, { ownership: { kind: "conversation" } }),
				);
				yield* response.requested;
				// Not a settled record: the cast stands for a host that sends what it should not.
				const delivered = yield* Harness.signal(id, Signal.SubmissionSettled, "other", {
					status: "done",
				} as SettledSubmissionRecord);
				yield* response.release;
				yield* Harness.waitForTask(id);
				return delivered;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Relay] })],
						responses: [response.response],
					}),
				),
			),
		);
		expect(result).toBe("invalid");
	});
});
