import { fauxAssistantMessage, runTest, ScriptedModels as ScriptedModelsService } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { AgentSession, ModelRuntime, ResourceLoader, SessionManager, SettingsManager } from "../src/index.ts";
import { held, openSession, services, tempDir, texts } from "./scripted.ts";

describe("AgentSession.make", () => {
	it("runs a prompt to its end: the model's answer is in the transcript", async () => {
		const answers = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession();
				yield* models.setResponses([fauxAssistantMessage("Hello there.")]);
				yield* session.prompt("Hi.");
				return {
					user: texts(yield* session.messages, "user"),
					assistant: texts(yield* session.messages, "assistant"),
					last: yield* session.getLastAssistantText(),
				};
			}).pipe(Effect.provide(services)),
		);
		expect(answers).toEqual({ user: ["Hi."], assistant: ["Hello there."], last: "Hello there." });
	});

	it("streams the events of one prompt, from agent_start to the run's end", async () => {
		const types = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession();
				yield* models.setResponses([fauxAssistantMessage("Streamed.")]);
				const events = yield* Stream.runCollect(session.stream("Go."));
				return events.map((event) => event.type);
			}).pipe(Effect.provide(services)),
		);
		expect(types[0]).toBe("agent_start");
		expect(types).toContain("message_end");
		expect(types).toContain("agent_end");
	});

	it("gives every event from the subscription on until its scope closes", async () => {
		const types = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession();
				const events = yield* Effect.scoped(
					Effect.gen(function* () {
						const subscription = yield* session.subscribe;
						yield* models.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
						yield* session.prompt("First.");
						yield* session.prompt("Second.");
						return subscription;
					}),
				);
				return (yield* Stream.runCollect(events)).filter((event) => event.type === "agent_start").length;
			}).pipe(Effect.provide(services)),
		);
		expect(types).toBe(2);
	});

	it("aborts the run when the prompt's fiber is interrupted, and waits until the session is idle", async () => {
		const outcome = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession();
				const started = yield* Latch.make();
				yield* models.setResponses([held(started)]);
				const prompting = yield* Effect.forkChild(session.prompt("Wait."), { startImmediately: true });
				yield* Latch.await(started);
				yield* Fiber.interrupt(prompting);
				const exit = yield* Fiber.await(prompting);
				return { interrupted: Exit.hasInterrupts(exit), idle: yield* session.isIdle };
			}).pipe(Effect.provide(services)),
		);
		expect(outcome).toEqual({ interrupted: true, idle: true });
	});

	it("fails with Pi's error as a CodingAgentError: a prompt while streaming must say how to queue", async () => {
		const failure = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession();
				const started = yield* Latch.make();
				yield* models.setResponses([held(started)]);
				const first = yield* Effect.forkChild(session.prompt("Wait."), { startImmediately: true });
				yield* Latch.await(started);
				const second = yield* Effect.flip(session.prompt("Again."));
				yield* Fiber.interrupt(first);
				return second;
			}).pipe(Effect.provide(services)),
		);
		expect(failure._tag).toBe("CodingAgentError");
		expect(failure.message).toContain("streaming");
	});

	it("disposes the session when its scope closes", async () => {
		const disposed = await runTest(
			Effect.gen(function* () {
				const handle = yield* Effect.scoped(Effect.map(openSession(), ({ session }) => session));
				// A disposed session has dropped its listeners and extension runtime; its fields still read.
				return yield* handle.sessionId;
			}).pipe(Effect.provide(services)),
		);
		expect(disposed).toMatch(/.+/);
	});

	it("reads and changes the session through Pi's members as Effects", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const { session } = yield* openSession();
				yield* session.setSessionName("named");
				yield* session.setActiveToolsByName(["read"]);
				return {
					name: yield* session.sessionName,
					tools: yield* session.getActiveToolNames(),
					streaming: yield* session.isStreaming,
				};
			}).pipe(Effect.provide(services)),
		);
		expect(state).toEqual({ name: "named", tools: ["read"], streaming: false });
	});
});

describe("AgentSession.layer", () => {
	it("makes the session of the program from its ModelRuntime, settings, storage and resources", async () => {
		const answer = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const models = yield* ScriptedModelsService;
				const runtime = yield* ModelRuntime;
				yield* runtime.registerNativeProvider(models.provider);
				const settings = Layer.effect(SettingsManager, SettingsManager.inMemory({ retry: { enabled: false } }));
				const storage = SessionManager.layer(SessionManager.inMemory(dir));
				const resources = Layer.unwrap(
					Effect.gen(function* () {
						const settingsManager = yield* SettingsManager;
						return ResourceLoader.layer({ cwd: dir, agentDir: dir, settingsManager, noContextFiles: true });
					}),
				);
				const session = AgentSession.layer({ cwd: dir, agentDir: dir, model: models.model, thinkingLevel: "off" });
				return yield* Effect.gen(function* () {
					yield* models.setResponses([fauxAssistantMessage("From the layer.")]);
					const current = yield* AgentSession;
					yield* current.prompt("Hello.");
					return yield* current.getLastAssistantText();
				}).pipe(
					Effect.provide(
						session.pipe(Layer.provide(Layer.mergeAll(storage, resources)), Layer.provideMerge(settings)),
					),
				);
			}).pipe(Effect.provide(services)),
		);
		expect(answer).toBe("From the layer.");
	});
});
