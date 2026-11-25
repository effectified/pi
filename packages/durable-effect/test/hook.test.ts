import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	GenerationTask,
	type HookRegistration,
	hook,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { type SchemaConversionError, toJsonSchema } from "@gunta/pi-schema-effect";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Extension, Gate, Harness, Hook, Registry, Tool } from "../src/index.ts";
import { answer, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT } from "./scripted.ts";

/** What the hooks of these tests write to, so a test sees that a handler ran with the service it needs. */
class Journal extends Context.Service<Journal, { readonly note: (line: string) => Effect.Effect<void> }>()(
	"test/Journal",
) {}

/** A journal that appends to `lines`. */
function journal(lines: string[]): Layer.Layer<Journal> {
	return Layer.succeed(Journal, { note: (line) => Effect.sync(() => void lines.push(line)) });
}

const note = (line: string) => Journal.use((service) => service.note(line));

const EchoParameters = Schema.Struct({ text: Schema.String });

const Echo = Tool.make("echo", {
	description: "Say it back.",
	parameters: EchoParameters,
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(text),
});

/** The transcript of the root conversation: each entry's kind and what its first message says. */
const transcript = Effect.gen(function* () {
	const root = yield* Harness.root;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return entries.map((entry) => [entry.kind, said(entry)]);
});

function said(entry: EntryRecord): unknown {
	const message = entry.model?.[0];
	if (message === undefined || typeof message.content === "string") return message?.content;
	return message.content.map((part) => (part.type === "text" ? part.text : part.type));
}

const MISSING_ENTRY = 999 as EntryId;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the nine hooks", () => {
	it("each runs with the service its handler needs, and its answer reaches Pi", async () => {
		const lines: string[] = [];
		const shown: number[] = [];
		const sent: unknown[] = [];
		let yields = 0;
		// The scripted provider builds no request body: the first response asks for the payload hooks itself.
		const first: FauxResponseFactory = async (context, options, _state, model) => {
			shown.push(context.messages.length);
			sent.push(await options?.onPayload?.({ body: 1 }, model));
			return toolCall("echo", { text: "hi" }, { id: "call-1" });
		};
		const hooks = [
			Hook.beforeRequest(({ messages }) =>
				Effect.as(
					note(`beforeRequest ${messages.length}`),
					Option.some({ messages: [...messages, { role: "user" as const, content: "(injected)", timestamp: 0 }] }),
				),
			),
			Hook.beforeProviderRequest(({ model, payload }) =>
				Effect.as(
					note(`beforeProviderRequest ${model.id}`),
					Option.some({ payload: { ...(payload as object), tagged: true } }),
				),
			),
			Hook.afterResponse((message) => note(`afterResponse ${message.stopReason}`)),
			Hook.beforeTool((call) => Effect.as(note(`beforeTool ${call.name}`), Gate.rewrite({ text: "HI" }))),
			Hook.afterTool((call, result) =>
				Effect.as(
					note(`afterTool ${call.name} ${JSON.stringify(result.output)}`),
					Option.some({ output: [{ type: "text" as const, text: "replaced" }] }),
				),
			),
			Hook.afterTools((_assistant, results) => Effect.as(note(`afterTools ${results.length}`), Option.none())),
			Hook.onYield(() =>
				Effect.as(
					note("onYield"),
					yields++ === 0 ? Option.some({ kind: "continue" as const, continue: "Once more." }) : Option.none(),
				),
			),
			Hook.afterRun((run) => Effect.as(note(`afterRun ${run.reason}`), Option.none())),
			Hook.beforeCompact((compaction) =>
				Effect.as(
					note(`beforeCompact ${compaction.reason}`),
					Option.some({ kind: "summary" as const, summary: "They said hi." }),
				),
			),
		];
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.");
				yield* root.waitForIdle;
				const answered = yield* transcript;
				yield* Harness.waitForTask(yield* root.compact());
				yield* root.waitForIdle;
				const requests = yield* ScriptedModels.use((models) => models.callCount);
				return { answered, compacted: (yield* transcript).at(-1), requests };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Echo], hooks })],
						responses: [first, answer("Said."), answer("Said again.")],
						// Keeps one token verbatim, so a manual compaction of this short transcript finds a range to summarize.
						harness: { settings: { compaction: { enabled: false, keepRecentTokens: 1 } } },
					}),
				),
				Effect.provide(journal(lines)),
			),
		);
		expect(lines).toEqual([
			"beforeRequest 2",
			"beforeProviderRequest faux-1",
			"afterResponse toolUse",
			"beforeTool echo",
			'afterTool echo [{"type":"text","text":"HI"}]',
			"afterTools 1",
			"beforeRequest 4",
			"afterResponse stop",
			"onYield",
			"beforeRequest 6",
			"afterResponse stop",
			"onYield",
			"afterRun answer",
			"beforeCompact manual",
		]);
		// `beforeRequest` added one message to the two of the first request, for that request only.
		expect(shown).toEqual([3]);
		expect(sent).toEqual([{ body: 1, tagged: true }]);
		expect(seen.answered).toEqual([
			["pi.user", "Say hi."],
			["pi.system", ""],
			["pi.assistant", ["toolCall"]],
			["pi.tool-result", ["replaced"]],
			["pi.assistant", ["Said."]],
			["pi.user", "Once more."],
			["pi.assistant", ["Said again."]],
		]);
		// The compaction took the hook's summary and asked no model for one.
		expect(seen.compacted).toEqual([
			"pi.compaction",
			[
				"The conversation history before this point was compacted into the following summary:\n\n<summary>\nThey said hi.\n</summary>",
			],
		]);
		expect(seen.requests).toBe(3);
	});

	it("a registry whose hooks need a service does not type check until it is provided", () => {
		const Noted = Hook.afterResponse((message) => note(message.stopReason));
		const registration: Equal<typeof Noted.registration, Effect.Effect<HookRegistration, never, Journal>> = true;
		const needsJournal = Registry.layer([Extension.make({ name: "app", tools: [Echo], hooks: [Noted] })]);
		const requirements: Equal<Layer.Services<typeof needsJournal>, Journal> = true;
		// @ts-expect-error The registry's hook needs Journal, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsJournal;
		const provided: Layer.Layer<Registry.Registry, SchemaConversionError> = needsJournal.pipe(
			Layer.provide(journal([])),
		);
		expect([registration, requirements]).toEqual([true, true]);
		expect([unprovided, provided].every(Layer.isLayer)).toBe(true);
	});
});

describe("the api of a hook", () => {
	it("reads the asking task, the clock, memos and the conversation's history", async () => {
		const seen: Record<string, unknown> = {};
		let asking: TaskId | undefined;
		const hooks = [
			Hook.beforeTool((_call, api) =>
				Effect.gen(function* () {
					asking = api.taskId;
					seen.absent = Option.isNone(yield* api.memo("test.choice"));
					seen.first = yield* api.memo("test.choice", "first");
					seen.second = yield* api.memo("test.choice", "second");
					seen.kept = Option.getOrThrow(yield* api.memo<string>("test.choice"));
					return Gate.allow;
				}),
			),
			Hook.afterRun((run, api) =>
				Effect.gen(function* () {
					const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
					seen.run = (yield* Stream.runCollect(api.entries({ ...range, pageSize: 2 }))).map((entry) => entry.kind);
					seen.answer = Option.getOrThrow(yield* api.entry(run.answer)).kind;
					seen.missing = Option.isNone(yield* api.entry(MISSING_ENTRY));
					seen.conversation = api.conversationId;
					seen.clock = (yield* api.now) === api.pi.now();
					return Option.none();
				}),
			),
		];
		const task = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.");
				yield* root.waitForIdle;
				return Option.getOrThrow(yield* Harness.getTask(asking!));
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Echo], hooks })],
						responses: [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("Said.")],
					}),
				),
				Effect.provide(TestClock.layer()),
			),
		);
		expect(task.kind).toBe("pi.tool");
		expect(seen).toEqual({
			absent: true,
			first: "first",
			second: "first",
			kept: "first",
			run: ["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"],
			answer: "pi.assistant",
			missing: true,
			conversation: 1,
			clock: true,
		});
	});
});

describe("a failing hook", () => {
	class Refused extends Schema.TaggedError<Refused>()("Refused", { why: Schema.String }) {
		override get message(): string {
			return `Refused: ${this.why}`;
		}
	}

	const run = (hooks: ReadonlyArray<Hook.Hook<never>>) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("Say hi.");
				yield* root.waitForIdle;
				return { settled, transcript: yield* transcript };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [{ name: "app", tools: [Echo], hooks }],
						responses: [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("Said.")],
					}),
				),
			),
		);

	it("is skipped by Pi, with a failure and with a defect, and the run goes on as without it", async () => {
		const failing = await run([
			Hook.beforeRequest(() => Effect.fail(new Refused({ why: "no" }))),
			Hook.beforeProviderRequest(() => Effect.fail("a string")),
			Hook.afterResponse(() => Effect.die(new Error("defect"))),
			Hook.afterTool(() => Effect.fail(new Refused({ why: "no" }))),
			Hook.afterTools(() => Effect.die("defect")),
			Hook.onYield(() => Effect.fail(new Refused({ why: "no" }))),
			Hook.afterRun(() => Effect.fail(new Refused({ why: "no" }))),
		]);
		const without = await run([]);
		expect(failing.settled.status).toBe("done");
		expect(failing.transcript).toEqual(without.transcript);
		expect(failing.transcript).toEqual([
			["pi.user", "Say hi."],
			["pi.system", ""],
			["pi.assistant", ["toolCall"]],
			["pi.tool-result", ["hi"]],
			["pi.assistant", ["Said."]],
		]);
	});

	it("blocks the call when it is beforeTool: the model reads the error's message and the tool never runs", async () => {
		let ran = false;
		const Guarded = Tool.make("echo", {
			description: "Say it back.",
			parameters: EchoParameters,
			success: Schema.String,
			handler: ({ text }) =>
				Effect.sync(() => {
					ran = true;
					return text;
				}),
		});
		const blocked = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("Say hi.");
				yield* root.waitForIdle;
				return { settled, result: (yield* Stream.runCollect(root.entries({ order: "ascending" })))[3] };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [
							Extension.make({
								name: "app",
								tools: [Guarded],
								hooks: [Hook.beforeTool(() => Effect.fail(new Refused({ why: "the gate broke" })))],
							}),
						],
						responses: [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("Said.")],
					}),
				),
			),
		);
		const message = "Tool call blocked: Refused: the gate broke";
		expect(ran).toBe(false);
		expect(blocked.settled.status).toBe("done");
		expect(blocked.result?.model?.[0]).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [{ type: "text", text: `<harness>\n[error] ${message}\n</harness>` }],
		});
		expect(blocked.result?.data).toEqual({ diagnostics: [{ severity: "error", code: "blocked", message }] });
	});
});

describe("an aborted hook", () => {
	it("has its fiber interrupted when Pi aborts the invocation", async () => {
		const started = Promise.withResolvers<void>();
		let interrupted = false;
		const Slow = Hook.beforeRequest(() =>
			Effect.sync(() => started.resolve()).pipe(
				Effect.andThen(Effect.never),
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			),
		);
		const status = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go." });
				yield* Effect.promise(() => started.promise);
				yield* root.abort();
				return yield* submission.status;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", hooks: [Slow] })],
						responses: [answer("Never asked.")],
					}),
				),
			),
		);
		expect(interrupted).toBe(true);
		expect(status).toMatchObject({ status: "unanswered", reason: "aborted" });
	});
});

describe("parity with Pi Durable", () => {
	it("hooks leave the records of the same hooks written with hook()", async () => {
		const piEcho = defineTool({
			name: "echo",
			description: "Say it back.",
			parameters: toJsonSchema(EchoParameters) as object,
			execute: async (args) => ({ output: [{ type: "text", text: (args as { text: string }).text }] }),
		});
		const injected = { role: "user" as const, content: "(injected)", timestamp: 0 };
		const replaced = { output: [{ type: "text" as const, text: "replaced" }] };
		const effectHooks = () => {
			let yields = 0;
			return [
				Hook.beforeRequest(({ messages }) => Effect.succeed(Option.some({ messages: [...messages, injected] }))),
				Hook.afterResponse(() => Effect.void),
				Hook.beforeTool(() => Effect.succeed(Gate.rewrite({ text: "HI" }))),
				Hook.afterTool(() => Effect.succeed(Option.some(replaced))),
				Hook.afterTools(() => Effect.succeed(Option.none())),
				Hook.onYield(() =>
					Effect.sync(() =>
						yields++ === 0 ? Option.some({ kind: "continue" as const, continue: "Once more." }) : Option.none(),
					),
				),
				Hook.afterRun(() => Effect.succeed(Option.none())),
			];
		};
		const piHooks = () => {
			let yields = 0;
			return [
				hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: [...messages, injected] }) }),
				hook(GenerationTask, { afterResponse: () => {} }),
				hook(ToolTask, { beforeTool: () => ({ arguments: { text: "HI" } }) }),
				hook(ToolTask, { afterTool: () => replaced }),
				hook(GenerationTask, { afterTools: () => undefined }),
				hook(GenerationTask, {
					onYield: () => (yields++ === 0 ? { kind: "continue", continue: "Once more." } : undefined),
				}),
				hook(GenerationTask, { afterRun: () => undefined }),
			];
		};
		const both = await runBoth({
			responses: () => [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("Said."), answer("Said again.")],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tools: [Echo], hooks: effectHooks() })]),
				pi: [defineExtension({ name: "app", tools: [piEcho], hooks: piHooks() })],
			},
			effect: Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Say hi.")),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return (await root.submit({ type: "input", content: "Say hi." }, context)).wait(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
		]);
		expect(both.effect.records.entries[3]?.model).toMatchObject([
			{ role: "toolResult", content: [{ type: "text", text: "replaced" }] },
		]);
	});
});
