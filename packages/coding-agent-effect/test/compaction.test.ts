import { StreamFn } from "@effectified/pi-agent";
import { fauxAssistantMessage, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Compaction, SessionManager } from "../src/index.ts";
import { held, scripted } from "./scripted.ts";

/** The scripted provider behind `StreamFn`, through which the summaries are requested. */
const services = Layer.provideMerge(StreamFn.models, scripted);

const conversation = [
	{ role: "user" as const, content: "Plan the release.", timestamp: 1 },
	{
		role: "user" as const,
		content: "Then tag it.",
		timestamp: 2,
	},
];

describe("Compaction.generateSummary", () => {
	it("asks the model for a summary through StreamFn and gives its text and usage", async () => {
		const summary = await runTest(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([fauxAssistantMessage("The release is planned.")]);
				return yield* Compaction.generateSummary(conversation, { model: models.model });
			}).pipe(Effect.provide(services)),
		);
		expect(summary.text).toBe("The release is planned.");
		expect(summary.usage).toBeDefined();
	});

	it("cancels the request when its fiber is interrupted", async () => {
		const exit = await runTest(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const started = yield* Latch.make();
				yield* models.setResponses([held(started)]);
				const summarizing = yield* Effect.forkChild(
					Compaction.generateSummary(conversation, { model: models.model }),
					{
						startImmediately: true,
					},
				);
				yield* Latch.await(started);
				yield* Fiber.interrupt(summarizing);
				return yield* Fiber.await(summarizing);
			}).pipe(Effect.provide(services)),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});

describe("Compaction.generateBranchSummary", () => {
	it("summarizes the entries of a branch as Pi does when the session moves in its tree", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const sessions = yield* SessionManager.inMemory("/project");
				for (const message of conversation) yield* sessions.appendMessage(message);
				yield* models.setResponses([fauxAssistantMessage("The branch planned a release.")]);
				return yield* Compaction.generateBranchSummary(yield* sessions.getEntries(), { model: models.model });
			}).pipe(Effect.provide(services)),
		);
		expect(result.summary).toContain("The branch planned a release.");
	});
});
