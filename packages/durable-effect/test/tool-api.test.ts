import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { type SchemaConversionError, toJsonSchema } from "@effectified/pi-schema";
import { Effect, Fiber, Latch, type Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Doc, Extension, Harness, Registry, Signal, Task, Tool, ToolName } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer } from "./scripted.ts";
import { untilTask } from "./until-task.ts";

/** A model turn that calls `name` with `args`. */
function toolCall(name: string, args: Record<string, string>, id = "call-1") {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

/** The text of an answer entry. */
function answerText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The tool results of the root conversation, as the model and a host read them. */
const results = Effect.gen(function* () {
	const root = yield* Harness.root;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult"
			? [{ text: message.content, isError: message.isError, details: message.details as unknown }]
			: [];
	});
});

/** A registry with one extension, `app`, of `tools`. */
function app<const Tools extends ReadonlyArray<Tool.Any>>(tools: Tools) {
	return Registry.layer([Extension.make({ name: "app", tools })]);
}

/** Runs one prompt on the root conversation of a harness on `registry`, and gives its tool results. */
function prompt(registry: Layer.Layer<Registry.Registry, SchemaConversionError>, responses: FauxResponseStep[]) {
	return Effect.gen(function* () {
		const root = yield* Harness.rootWith({ agent: AGENT });
		const settled = yield* root.prompt("Go.");
		yield* root.waitForIdle;
		return { settled: settled.status, results: yield* results };
	}).pipe(Effect.provide(harnessLayer({ responses, registry })));
}

const SubagentParameters = Schema.Struct({ task: Schema.String });

describe("a subagent tool (Pi's example 21)", () => {
	const Subagent = Tool.make("subagent", {
		description: "Delegate a self-contained task to a subagent and get its answer back.",
		parameters: SubagentParameters,
		success: Schema.String,
		replay: "safe",
		handler: ({ task }, api) =>
			Effect.gen(function* () {
				const child = yield* api.commit((tx) =>
					Effect.gen(function* () {
						// The ownership index remembers the child, so a rerun reuses it.
						const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						yield* tx.configure(created.id, { extensions: { remove: ["subagent"] } });
						return created.id;
					}),
				);
				yield* api.details({ conversationId: child });
				const handle = Option.getOrThrow(yield* api.conversation(child));
				const submission = yield* handle.submit({
					type: "input",
					content: task,
					requestId: `subagent:${api.taskId}`,
				});
				const settled = yield* submission.wait;
				if (settled.answer === undefined) return Tool.error(`The subagent did not answer: ${settled.reason}`);
				const answered = yield* api.commit((tx) => tx.entry(settled.answer));
				return answerText(Option.getOrUndefined(answered));
			}),
	});

	const PiSubagent = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description: "Delegate a self-contained task to a subagent and get its answer back.",
				parameters: toJsonSchema(SubagentParameters) as object,
				replay: "safe",
				execute: async (args, api, context) => {
					const { task } = args as { readonly task: string };
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { extensions: { remove: [{ name: "subagent" }] } });
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.answer === undefined)
						return { isError: true, output: [{ type: "text", text: "unanswered" }] };
					const answered = await api.commit((tx) => tx.entry(settled.answer), context);
					return { output: [{ type: "text", text: answerText(answered) }] };
				},
			}),
		],
	});

	it("creates a task-owned child in its commit, submits to it and returns its answer, as plain Pi's tool does", async () => {
		const both = await runBoth({
			responses: () => [
				toolCall("subagent", { task: "What is six times seven?" }),
				answer("Forty-two."),
				answer("The subagent says forty-two."),
			],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "subagent", tools: [Subagent] })]),
				pi: [PiSubagent],
			},
			effect: Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Ask a subagent.")),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return (await root.submit({ type: "input", content: "Ask a subagent." }, context)).wait(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { conversations, entries } = both.effect.records;
		expect(conversations).toHaveLength(2);
		const child = conversations[1] as { readonly id: ConversationId; readonly owner: unknown };
		expect(child.owner).toMatchObject({ conversationId: 1 });
		const ofChild = entries.filter((entry) => entry.conversationId === child.id).map((entry) => entry.kind);
		expect(ofChild).toEqual(["pi.user", "pi.assistant"]);
		const result = entries.find((entry) => entry.kind === "pi.tool-result") as unknown as EntryRecord;
		expect(result.model?.[0]).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "Forty-two." }],
			details: { conversationId: child.id },
		});
	});
});

describe("what a call may use", () => {
	it("gives its ids, the clock, the agent, memos and committed documents, and nothing of a park on a fresh call", async () => {
		const Notes = Doc.make({
			kind: "app.notes",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			schema: Schema.Struct({ lines: Schema.Array(Schema.String) }),
			initial: () => ({ lines: [] }),
			checkpointWhen: () => false,
		});
		const seen: Record<string, unknown> = {};
		const Inspect = Tool.make("inspect", {
			description: "Look around.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: (_params, api) =>
				Effect.gen(function* () {
					yield* api.commit((tx) =>
						Effect.flatMap(tx.doc(Notes, api.conversationId), (notes) => notes.set({ lines: ["from the tool"] })),
					);
					yield* api.diagnostic({ severity: "info", message: "looked around", code: "inspected" });
					Object.assign(seen, {
						callId: api.callId,
						conversationId: api.conversationId,
						taskKind: Option.getOrThrow(yield* api.commit((tx) => tx.task(api.taskId))).kind,
						wake: Option.isNone(api.wake),
						checkpoint: Option.isNone(api.checkpoint),
						now: typeof (yield* api.now),
						tools: (yield* api.agent).tools.map((tool) => tool.name),
						first: yield* api.memo("inspect.key", "k-1"),
						second: yield* api.memo("inspect.key", "k-2"),
						notes: Option.getOrThrow(yield* api.snapshot(Notes, api.conversationId)),
						pi: api.pi.callId,
					});
					return "done";
				}),
		});
		const outcome = await Effect.runPromise(prompt(app([Inspect]), [toolCall("inspect", {}), answer("Done.")]));
		expect(outcome.settled).toBe("done");
		expect(seen).toEqual({
			callId: "call-1",
			conversationId: 1,
			taskKind: "pi.tool",
			wake: true,
			checkpoint: true,
			now: "number",
			tools: ["inspect"],
			first: "k-1",
			second: "k-1",
			notes: { lines: ["from the tool"] },
			pi: "call-1",
		});
		expect(outcome.results[0]?.text).toEqual([
			{ type: "text", text: "done" },
			{ type: "text", text: "<harness>\n[info] looked around\n</harness>" },
		]);
	});

	it("runs a nested call and gets its result, and starts one without waiting", async () => {
		const Double = Tool.make("double", {
			description: "Double a number.",
			parameters: Schema.Struct({ n: Schema.Number }),
			success: Schema.Struct({ doubled: Schema.Number }),
			structured: true,
			callers: ["tools"],
			handler: ({ n }) => Effect.succeed({ doubled: n * 2 }),
		});
		const seen: unknown[] = [];
		const Twice = Tool.make("twice", {
			description: "Double twice.",
			parameters: Schema.Struct({}),
			success: Schema.Number,
			handler: (_params, api) =>
				Effect.gen(function* () {
					const first = yield* api.executeTool(ToolName.make("double"), { n: 2 }, { progress: false });
					const started = yield* api.startTool(ToolName.make("double"), { n: 10 }, { key: "ten" });
					const second = yield* started.result;
					const invalid = yield* api.executeTool(ToolName.make("double"), { n: "two" });
					seen.push(
						first.structuredOutput,
						second.structuredOutput,
						second.taskId === started.taskId,
						invalid.isError,
					);
					return 24;
				}),
		});
		const outcome = await Effect.runPromise(prompt(app([Double, Twice]), [toolCall("twice", {}), answer("24.")]));
		expect(seen).toEqual([{ doubled: 4 }, { doubled: 20 }, true, true]);
		expect(outcome.results).toEqual([{ text: [{ type: "text", text: "24" }], isError: false, details: undefined }]);
	});
});

describe("a call that parks", () => {
	const Approval = Signal.make("tool-api.approval", 1, Schema.Struct({ allow: Schema.Boolean }));

	it("sleeps on a signal, holds no handler meanwhile, and runs again with the wake and its checkpoint", async () => {
		const runs: unknown[] = [];
		const parked = Promise.withResolvers<TaskId>();
		const Ask = Tool.make("ask", {
			description: "Ask a person.",
			parameters: Schema.Struct({ question: Schema.String }),
			success: Schema.String,
			handler: ({ question }, api) =>
				Effect.gen(function* () {
					const state = yield* api.readSignal(Approval, "answer");
					runs.push({ wake: Option.getOrUndefined(api.wake), checkpoint: Option.getOrUndefined(api.checkpoint) });
					if (Option.isNone(state)) {
						parked.resolve(api.taskId);
						return Tool.sleep({ signals: [Approval.key("answer")], checkpoint: { asked: question } });
					}
					return state.value.kind === "value" && state.value.value.allow ? "allowed" : Tool.error("refused");
				}),
		});
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "May I?" });
				const taskId = yield* Effect.promise(() => parked.promise);
				yield* untilTask("sleeping", taskId);
				const sleeping = (yield* Harness.inspect).tasks.find((task) => task.record.id === taskId)?.state.kind;
				const delivered = yield* Harness.signal(taskId, Approval, "answer", { allow: true });
				const settled = yield* submission.wait;
				return { sleeping, delivered, settled: settled.status, results: yield* results };
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("ask", { question: "Deploy?" }), answer("Deployed.")],
						registry: app([Ask]),
					}),
				),
			),
		);
		expect(outcome.sleeping).toBe("sleeping");
		expect(outcome.delivered).toBe("delivered");
		expect(outcome.settled).toBe("done");
		expect(runs).toEqual([
			{ wake: undefined, checkpoint: undefined },
			{
				wake: { reason: "signal", signal: "tool-api.approval", key: "answer" },
				checkpoint: { asked: "Deploy?" },
			},
		]);
		expect(outcome.results).toEqual([
			{ text: [{ type: "text", text: "allowed" }], isError: false, details: undefined },
		]);
	});

	it("waits for a nested call it started, and reads its result once woken", async () => {
		// The nested call ends only once the call that started it waits for it.
		const release = Latch.makeUnsafe();
		const Slow = Tool.make("slow", {
			description: "Takes a moment.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			callers: ["tools"],
			handler: () => Effect.as(release.await, "slow result"),
		});
		const wakes: unknown[] = [];
		const waiting = Promise.withResolvers<TaskId>();
		const Both = Tool.make("both", {
			description: "Start a slow call and wait for it.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			replay: "safe",
			handler: (_params, api) =>
				Effect.gen(function* () {
					const started = yield* api.startTool(ToolName.make("slow"), {}, { key: "slow" });
					waiting.resolve(api.taskId);
					wakes.push(Option.getOrUndefined(api.wake)?.reason);
					if (Option.isNone(api.wake)) return Tool.wait({ on: [started.taskId], policy: "allSettled" });
					return String((yield* started.result).structuredOutput);
				}),
		});
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const prompting = yield* Effect.forkChild(root.prompt("Go."));
				yield* untilTask("waiting", yield* Effect.promise(() => waiting.promise));
				yield* release.open;
				yield* Fiber.join(prompting);
				yield* root.waitForIdle;
				return { results: yield* results };
			}).pipe(
				Effect.provide(
					harnessLayer({ responses: [toolCall("both", {}), answer("Done.")], registry: app([Slow, Both]) }),
				),
			),
		);
		expect(wakes).toEqual([undefined, "tasks"]);
		expect(outcome.results).toEqual([
			{ text: [{ type: "text", text: "slow result" }], isError: false, details: undefined },
		]);
	});

	it("runs `cancel` with the park's checkpoint when the call is aborted while parked", async () => {
		const cancelled: unknown[] = [];
		const parked = Promise.withResolvers<void>();
		const Build = Tool.make("build", {
			description: "Start a build and wait for it.",
			parameters: Schema.Struct({ ref: Schema.String }),
			success: Schema.String,
			handler: (_params, api) =>
				Effect.sync(() => {
					parked.resolve();
					return Tool.sleep({ signals: [Approval.key("built")], checkpoint: { buildId: `b-${api.callId}` } });
				}),
			cancel: ({ ref }, api) =>
				Effect.sync(() => {
					cancelled.push({
						ref,
						checkpoint: Option.getOrUndefined(api.checkpoint),
						wake: Option.isNone(api.wake),
					});
				}),
		});
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.submit({ type: "input", content: "Build main." });
				yield* Effect.promise(() => parked.promise);
				yield* untilTask("sleeping");
				yield* root.abort();
				return yield* results;
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("build", { ref: "main" })],
						registry: app([Build]),
					}),
				),
			),
		);
		expect(cancelled).toEqual([{ ref: "main", checkpoint: { buildId: "b-call-1" }, wake: true }]);
		expect(outcome).toMatchObject([{ isError: true }]);
	});
});

describe("a call that creates a task", () => {
	const AT = new Date("2026-11-25T00:00:00.000Z");
	const CountParameters = Schema.Struct({ text: Schema.String });

	const Count = Task.make({
		name: "test.count",
		version: 1,
		input: Schema.Struct({ text: Schema.String, at: Schema.Date }),
		state: Schema.Struct({ phase: Schema.Literal("count") }),
		result: Schema.Struct({ length: Schema.Number, at: Schema.Date }),
		initial: () => ({ phase: "count" as const }),
		phases: { count: (task) => Effect.succeed(Task.complete({ length: task.input.text.length, at: task.input.at })) },
		abort: () => Effect.succeed(Task.aborted()),
	});

	const Spawn = Tool.make("spawn", {
		description: "Count a text in a task.",
		parameters: CountParameters,
		success: Schema.String,
		replay: "safe",
		handler: ({ text }, api) =>
			Effect.gen(function* () {
				const ownership = { kind: "task", taskId: api.taskId } as const;
				const first = yield* api.createTask(Count, { text, at: AT }, { ownership, key: "count" });
				// The same key gives the same task: a rerun of the handler creates no second one.
				const again = yield* api.createTask(Count, { text, at: AT }, { ownership, key: "count" });
				const other = yield* api.createTask(Count, { text: `${text}!`, at: AT }, { ownership, key: "other" });
				const reused = yield* Effect.flip(
					api.createTask(Count, { text: "another", at: AT }, { ownership, key: "count" }),
				);
				const live = Option.getOrThrow(yield* api.getTask(first));
				const settled = yield* api.waitForTask(first);
				const outcome = yield* Count.outcome(settled.state.outcome);
				const length = outcome.status === "completed" ? outcome.result.length : -1;
				yield* api.waitForTask(other);
				return [
					`same ${first === again}`,
					`other ${other !== first}`,
					`reused ${reused._tag}`,
					`live ${live.kind} owned ${live.owner === api.taskId}`,
					`length ${length}`,
				].join(", ");
			}),
	});

	const PiCount = defineTask<{ text: string; at: string }, { phase: "count" }, { length: number; at: string }>({
		name: "test.count",
		version: 1,
		initial: () => ({ phase: "count" }),
		phases: {
			count: (task, runtime, context) =>
				runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { length: task.input.text.length, at: task.input.at } },
					}),
					context,
				),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const PiSpawn = defineTool({
		name: "spawn",
		description: "Count a text in a task.",
		parameters: toJsonSchema(CountParameters) as object,
		replay: "safe",
		execute: async (args, api, context) => {
			const { text } = args as { readonly text: string };
			const at = AT.toISOString();
			const ownership = { kind: "task", taskId: api.taskId } as const;
			const first = await api.createTask(PiCount, { text, at }, { ownership, key: "count" }, context);
			const again = await api.createTask(PiCount, { text, at }, { ownership, key: "count" }, context);
			const other = await api.createTask(PiCount, { text: `${text}!`, at }, { ownership, key: "other" }, context);
			const reused = await api
				.createTask(PiCount, { text: "another", at }, { ownership, key: "count" }, context)
				.then(
					() => "created",
					() => "UnexpectedError",
				);
			const live = (await api.getTask(first, context))!;
			const settled = await api.waitForTask(first, context);
			const outcome = settled.state.outcome;
			const length = outcome.status === "completed" ? outcome.result.length : -1;
			await api.waitForTask(other, context);
			const text_ = [
				`same ${first === again}`,
				`other ${other !== first}`,
				`reused ${reused}`,
				`live ${live.kind} owned ${live.owner === api.taskId}`,
				`length ${length}`,
			].join(", ");
			return { output: [{ type: "text", text: text_ }] };
		},
	});

	it("creates one task per key, reads it and waits for it, as plain Pi's api does", async () => {
		const both = await runBoth({
			responses: () => [toolCall("spawn", { text: "four" }), answer("Counted.")],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tools: [Spawn], tasks: [Count] })]),
				pi: [defineExtension({ name: "app", tools: [PiSpawn], tasks: [PiCount] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("Count four.");
				yield* root.waitForIdle;
				return yield* results;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await (await root.submit({ type: "input", content: "Count four." }, context)).wait(context);
				await root.waitForIdle(context);
				const page = await root.entries({ order: "ascending" }, 100, undefined, context);
				return page.items.flatMap((entry) => {
					const message = entry.model?.[0];
					return message?.role === "toolResult"
						? [{ text: message.content, isError: message.isError, details: message.details as unknown }]
						: [];
				});
			},
		});
		expect(both.effect.result).toEqual([
			{
				text: [
					{
						type: "text",
						text: "same true, other true, reused UnexpectedError, live test.count owned true, length 4",
					},
				],
				isError: false,
			},
		]);
		expect(both.effect).toEqual(both.pi);
		const counts = both.effect.records.tasks.filter((task) => task.kind === "test.count");
		expect(counts.map((task) => task.input)).toEqual([
			{ text: "four", at: AT.toISOString() },
			{ text: "four!", at: AT.toISOString() },
		]);
	});
});
