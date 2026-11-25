import {
	defineExtension,
	defineTask,
	GenerationTask,
	hook,
	hookTask,
	type YieldDecision,
} from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Harness, Hook, Registry, Task, Tool } from "../src/index.ts";
import { answer, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { correction, MODELS, review, Verdict } from "./review.ts";
import { AGENT } from "./scripted.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const textOf = (message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
	message.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");

/** Completes with the decision its input asks for: `stand`, or a correction to continue with. */
const Decide = Task.make({
	name: "test.decide",
	version: 1,
	input: Schema.Struct({ answer: Schema.String, at: Schema.Date }),
	state: Schema.Struct({ phase: Schema.Literal("decide") }),
	result: Hook.YieldDecision,
	initial: () => ({ phase: "decide" as const }),
	phases: {
		decide: (task) =>
			Effect.succeed(
				Task.complete(task.input.answer.includes("42") ? Hook.stand : Hook.continueWith("Look again.")),
			),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const AT = new Date("2026-11-25T00:00:00.000Z");

describe("task", () => {
	it("builds Pi's hook task from the task's token and the input, encoded", async () => {
		const request = await Effect.runPromise(Hook.task(Decide, { answer: "It is 42.", at: AT }));
		expect(request).toEqual({ task: Decide.token, input: { answer: "It is 42.", at: AT.toISOString() } });
		expect(request).toEqual(hookTask(Decide.token, { answer: "It is 42.", at: AT.toISOString() }));
	});

	it("takes the input the task's schema types, and fails with SchemaDecodeError for one it cannot encode", async () => {
		// @ts-expect-error The input of `Decide` has an `answer` and a date.
		const mistyped = Hook.task(Decide, { answer: 42 });
		const failure = await Effect.runPromise(Effect.flip(mistyped));
		expect(failure._tag).toBe("SchemaDecodeError");
	});
});

describe("the decisions", () => {
	it("are Pi's YieldDecision and AfterToolsDecision, typed by the result schemas", () => {
		const yielded: Equal<Hook.YieldDecision, (typeof Hook.YieldDecision)["Type"]> = true;
		const fits: YieldDecision = Hook.continueWith("Explain.");
		expect(yielded).toBe(true);
		expect(fits).toEqual({ continue: "Explain." });
		expect(Hook.stand).toEqual({});
		expect(Hook.continueWith([{ type: "text", text: "Explain." }])).toEqual({
			continue: [{ type: "text", text: "Explain." }],
		});
		expect(Hook.proceed).toEqual({});
		expect(Hook.terminate).toEqual({ terminate: true });
	});

	it("encode to the JSON Pi reads, and decode from it", async () => {
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
		const decision = Hook.continueWith([{ type: "text", text: "See this." }, image]);
		const encode = Schema.encodeEffect(Schema.toCodecJson(Hook.YieldDecision));
		const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(Hook.YieldDecision));
		const stored = await Effect.runPromise(encode(decision));
		expect(stored).toEqual({ continue: [{ type: "text", text: "See this." }, image] });
		expect(await Effect.runPromise(decode(stored))).toEqual(decision);
		expect(await Effect.runPromise(encode(Hook.stand))).toEqual({});
		expect(
			await Effect.runPromise(Schema.encodeEffect(Schema.toCodecJson(Hook.AfterToolsDecision))(Hook.terminate)),
		).toEqual({ terminate: true });
	});
});

describe("an empty continuation", () => {
	it("cannot be written, and neither encodes nor decodes, because Pi would ignore it", async () => {
		// @ts-expect-error A continuation holds at least one item: Pi ignores an empty one.
		Hook.continueWith([]);
		// What a cast lets through: a result like this one is refused at the boundary.
		const empty = { continue: [] } as unknown as Hook.YieldDecision;
		const codec = Schema.toCodecJson(Hook.YieldDecision);
		const encoded = await Effect.runPromise(Effect.result(Schema.encodeEffect(codec)(empty)));
		const decoded = await Effect.runPromise(Effect.result(Schema.decodeUnknownEffect(codec)({ continue: [] })));
		expect([encoded._tag, decoded._tag]).toEqual(["Failure", "Failure"]);
	});

	it("ends the task that completes with one faulted, and the answer stands", async () => {
		const Empty = Task.make({
			name: "test.empty",
			version: 1,
			input: Schema.Struct({}),
			state: Schema.Struct({ phase: Schema.Literal("decide") }),
			result: Hook.YieldDecision,
			initial: () => ({ phase: "decide" as const }),
			phases: { decide: () => Effect.succeed(Task.complete({ continue: [] } as unknown as Hook.YieldDecision)) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const Asker = Extension.make({
			name: "asker",
			tasks: [Empty],
			hooks: [
				Hook.onYield(() =>
					Effect.map(Hook.task(Empty, {}), (request) => Option.some({ kind: "tasks" as const, tasks: [request] })),
				),
			],
		});
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const tasks = yield* Stream.runCollect(Harness.scanTasks());
				return { settled, empty: tasks.filter((task) => task.kind === "test.empty").map((task) => task.state) };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Asker], responses: [answer("It is 42.")] }))),
		);
		expect(seen.settled.status).toBe("done");
		expect(seen.empty).toMatchObject([{ status: "terminal", outcome: { status: "faulted" } }]);
	});
});

describe("an onYield task", () => {
	const Decider = Extension.make({
		name: "decider",
		tasks: [Decide],
		hooks: [
			Hook.onYield((answered) =>
				Effect.map(Hook.task(Decide, { answer: textOf(answered), at: AT }), (request) =>
					Option.some({ kind: "tasks" as const, tasks: [request] }),
				),
			),
		],
	});

	it("continues the run with the task's correction, then lets the next answer stand, as plain Pi's hook task does", async () => {
		const PiDecide = defineTask<{ answer: string; at: string }, { phase: "decide" }, YieldDecision>({
			name: "test.decide",
			version: 1,
			initial: () => ({ phase: "decide" }),
			phases: {
				decide: (task, runtime, context) =>
					runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "completed",
								result: task.input.answer.includes("42") ? {} : { continue: "Look again." },
							},
						}),
						context,
					),
			},
			abort: (_task, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		const PiDecider = defineExtension({
			name: "decider",
			tasks: [PiDecide],
			hooks: [
				hook(GenerationTask, {
					onYield: (answered) => ({
						kind: "tasks",
						tasks: [hookTask(PiDecide, { answer: textOf(answered), at: AT.toISOString() })],
					}),
				}),
			],
		});
		const both = await runBoth({
			responses: () => [answer("It is 41."), answer("It is 42.")],
			extensions: { effect: Registry.layer([Decider]), pi: [PiDecider] },
			effect: Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("What is six times seven?")),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return (await root.submit({ type: "input", content: "What is six times seven?" }, context)).wait(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { entries, tasks } = both.effect.records;
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
		expect(entries[2]).toMatchObject({ model: [{ role: "user", content: "Look again." }] });
		// The answer the caller gets is the one the task let stand.
		expect(both.effect.result).toMatchObject({ status: "done", answer: entries[3]?.id });
		const decided = tasks.filter((task) => task.kind === "test.decide");
		expect(decided.map((task) => [task.input, task.state])).toEqual([
			[
				{ answer: "It is 41.", at: AT.toISOString() },
				{ status: "terminal", outcome: { status: "completed", result: { continue: "Look again." } } },
			],
			[
				{ answer: "It is 42.", at: AT.toISOString() },
				{ status: "terminal", outcome: { status: "completed", result: {} } },
			],
		]);
		// Children of the generation that asked for them.
		expect(decided.every((task) => typeof task.owner === "number")).toBe(true);
	});
});

describe("the review shape", () => {
	it("asks a second model, commits each verdict with its decision, and continues the run once with a correction", async () => {
		const scenario = review();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				const verdicts = yield* Effect.forEach(entries, Verdict.read);
				return {
					settled,
					kinds: entries.map((entry) => entry.kind),
					users: entries.flatMap((entry) => (entry.model?.[0]?.role === "user" ? [entry.model[0].content] : [])),
					answers: entries.flatMap((entry) =>
						entry.model?.[0]?.role === "assistant" ? [[entry.id, textOf(entry.model[0])]] : [],
					),
					verdicts: verdicts.flatMap((verdict) => Option.toArray(verdict)).map((verdict) => verdict.data),
					byTask: verdicts
						.flatMap((verdict) => Option.toArray(verdict))
						.every((verdict) => verdict.byTaskId !== undefined),
					requests: yield* ScriptedModels.use((models) => models.callCount),
				};
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [scenario.extension],
						responses: [scenario.model, scenario.model, scenario.model, scenario.model],
						provider: { api: "scripted", models: MODELS },
					}),
				),
			),
		);
		expect(seen.kinds).toEqual([
			"pi.user",
			"pi.assistant",
			"review.verdict",
			"pi.user",
			"pi.assistant",
			"review.verdict",
		]);
		expect(seen.users).toEqual(["What is six times seven?", correction("Six times seven is 42.")]);
		expect(seen.answers.map(([, text]) => text)).toEqual(["It is 41.", "It is 42."]);
		expect(seen.verdicts).toEqual([
			{ approved: false, note: "Six times seven is 42." },
			{ approved: true, note: "Correct." },
		]);
		expect(seen.byTask).toBe(true);
		expect(seen.settled).toMatchObject({ status: "done", answer: seen.answers[1]?.[0] });
		expect(scenario.requests).toEqual({ author: 2, reviewer: 2 });
		expect(seen.requests).toBe(4);
	});
});

describe("an afterTools task and an afterRun task", () => {
	const ran: string[] = [];
	const Stop = Task.make({
		name: "test.stop",
		version: 1,
		input: Schema.Struct({ results: Schema.Number }),
		state: Schema.Struct({ phase: Schema.Literal("stop") }),
		result: Hook.AfterToolsDecision,
		initial: () => ({ phase: "stop" as const }),
		phases: {
			stop: (task) =>
				Effect.sync(() => {
					ran.push(`stop after ${task.input.results} result`);
					return Task.complete(Hook.terminate);
				}),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	const Deliver = Task.make({
		name: "test.deliver",
		version: 1,
		input: Schema.Struct({ reason: Schema.String }),
		state: Schema.Struct({ phase: Schema.Literal("deliver") }),
		result: Schema.Null,
		initial: () => ({ phase: "deliver" as const }),
		phases: {
			deliver: (task) =>
				Effect.sync(() => {
					ran.push(`deliver after ${task.input.reason}`);
					return Task.complete(null);
				}),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	const Echo = Tool.make("echo", {
		description: "Say it back.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) => Effect.succeed(text),
	});
	const App = Extension.make({
		name: "app",
		tools: [Echo],
		tasks: [Stop, Deliver],
		hooks: [
			Hook.afterTools((_assistant, results) =>
				Effect.map(Hook.task(Stop, { results: results.length }), (request) => Option.some({ tasks: [request] })),
			),
			Hook.afterRun((run) =>
				Effect.map(Hook.task(Deliver, { reason: run.reason }), (request) => Option.some({ tasks: [request] })),
			),
		],
	});

	it("ends the run after the round when the afterTools task terminates, then runs the afterRun task", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("Echo hi.");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return {
					status: settled.status,
					kinds: entries.map((entry) => entry.kind),
					requests: yield* ScriptedModels.use((models) => models.callCount),
				};
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [App],
						responses: [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("never asked for")],
					}),
				),
			),
		);
		// The round's terminate ends the run: the model is not asked for an answer.
		expect(seen).toEqual({
			status: "done",
			kinds: ["pi.user", "pi.system", "pi.assistant", "pi.tool-result"],
			requests: 1,
		});
		expect(ran).toEqual(["stop after 1 result", "deliver after terminate"]);
	});
});
