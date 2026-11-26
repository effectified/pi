import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Command, Extension, ExtensionApi, ExtensionContext, Tool } from "../src/index.ts";
import { openSession, services } from "./scripted.ts";

/** A service of the application that the extension's Effects use. */
class Greetings extends Context.Service<Greetings, { readonly greet: (name: string) => Effect.Effect<string> }>()(
	"test/Greetings",
) {}

const GreetingsLive = Layer.succeed(Greetings, { greet: (name) => Effect.succeed(`Hello, ${name}!`) });

const greet = Tool.make("greet", {
	label: "Greet",
	description: "Greets someone by name.",
	parameters: Schema.Struct({ name: Schema.String }),
	success: Schema.String,
	handler: ({ name }) => Effect.flatMap(Greetings, (greetings) => greetings.greet(name)),
});

const hello = Command.make("hello", {
	description: "Records who said hello.",
	handler: (args) =>
		Effect.gen(function* () {
			const api = yield* ExtensionApi;
			const ctx = yield* ExtensionContext;
			yield* api.appendEntry("hello", { args, cwd: yield* ctx.cwd });
		}),
});

/** The texts of the tool results of `name` in `messages`. */
function toolResults(messages: ReadonlyArray<{ readonly role: string }>, name: string): string[] {
	return messages.flatMap((message) =>
		message.role === "toolResult" && "toolName" in message && message.toolName === name && "content" in message
			? (message.content as ReadonlyArray<{ readonly type: string; readonly text?: string }>).flatMap((part) =>
					part.type === "text" && part.text !== undefined ? [part.text] : [],
				)
			: [],
	);
}

describe("Extension.make", () => {
	it("loads into a real session: the model calls its tool, whose handler uses the application's services", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession({
					extensions: [Extension.make("greeter", { tools: [greet] })],
				});
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("greet", { name: "Ada" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Greeted."),
				]);
				yield* session.prompt("Greet Ada.");
				expect(yield* session.getActiveToolNames()).toContain("greet");
				return toolResults(yield* session.messages, "greet");
			}).pipe(Effect.provide(Layer.merge(services, GreetingsLive))),
		);
		expect(results).toEqual(["Hello, Ada!"]);
	});

	it("runs its command for `/name args`, with the extension API and the command's context as services", async () => {
		const entry = await runTest(
			Effect.gen(function* () {
				const { session, dir } = yield* openSession({
					extensions: [Extension.make("greeter", { commands: [hello] })],
				});
				yield* session.prompt("/hello from the test");
				const entries = yield* session.sessionManager.getEntries();
				return { entries, dir };
			}).pipe(Effect.provide(services)),
		);
		const custom = entry.entries.find((candidate) => candidate.type === "custom");
		expect(custom).toMatchObject({ customType: "hello", data: { args: "from the test", cwd: entry.dir } });
	});

	it("asks its handlers with the event and the context: a tool_call handler blocks a call", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const guard = Extension.make("guard", {
					tools: [greet],
					on: {
						tool_call: (event) =>
							Effect.succeed(
								event.toolName === "greet" && event.input.name === "Mallory"
									? { block: true, reason: "Mallory is not greeted" }
									: undefined,
							),
					},
				});
				const { session, models } = yield* openSession({ extensions: [guard] });
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("greet", { name: "Mallory" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Blocked."),
				]);
				yield* session.prompt("Greet Mallory.");
				return toolResults(yield* session.messages, "greet");
			}).pipe(Effect.provide(Layer.merge(services, GreetingsLive))),
		);
		expect(results).toEqual(["Mallory is not greeted"]);
	});

	it("runs `setup` with the extension API after registering the rest", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const dynamic = Extension.make("dynamic", {
					flags: [{ name: "shout", type: "boolean", default: true }],
					setup: Effect.gen(function* () {
						const api = yield* ExtensionApi;
						if ((yield* api.getFlag("shout")) === true) yield* api.registerTool(greet);
					}),
				});
				const { session } = yield* openSession({ extensions: [dynamic] });
				return yield* session.getActiveToolNames();
			}).pipe(Effect.provide(Layer.merge(services, GreetingsLive))),
		);
		expect(names).toContain("greet");
	});

	it("reports a failing handler as an extension error with its message", async () => {
		const errors = await runTest(
			Effect.gen(function* () {
				const failing = Extension.make("failing", {
					on: { agent_start: () => Effect.fail(new Error("the handler failed")) },
				});
				const { session, models } = yield* openSession({ extensions: [failing] });
				const reported = yield* session.extensionErrors;
				yield* models.setResponses([fauxAssistantMessage("Done.")]);
				yield* session.prompt("Start.");
				return yield* reported.pipe(Stream.take(1), Stream.runCollect);
			}).pipe(Effect.provide(services)),
		);
		expect(errors).toMatchObject([
			{ extensionPath: "<inline:failing>", event: "agent_start", error: "the handler failed" },
		]);
	});
});

describe("Extension.factory", () => {
	it("gives Pi's extension factory, which a Pi host loads like any other", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const plain = Tool.make("plain", {
					label: "Plain",
					description: "Answers.",
					parameters: Schema.Struct({}),
					success: Schema.String,
					handler: () => Effect.succeed("plain"),
				});
				const factory = Extension.factory(Extension.make("file", { tools: [plain] }));
				const { session } = yield* openSession({ extensionFactories: [factory] });
				return yield* session.getActiveToolNames();
			}).pipe(Effect.provide(services)),
		);
		expect(names).toContain("plain");
	});
});
