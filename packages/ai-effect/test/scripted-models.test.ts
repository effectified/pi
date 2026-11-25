import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { complete, Models } from "../src/index.ts";
import { fauxAssistantMessage, ScriptedModels } from "../src/testing/index.ts";

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

describe("ScriptedModels.layer", () => {
	it("provides a Models that holds only the scripted provider", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const models = yield* Models;
				return {
					sameProvider: models.getProvider("faux") === scripted.provider,
					providers: models.getProviders().map((provider) => provider.id),
					model: `${scripted.model.provider}/${scripted.model.id}`,
					listed: scripted.models.map((model) => model.id),
				};
			}).pipe(Effect.provide(ScriptedModels.layer())),
		);
		expect(result).toEqual({ sameProvider: true, providers: ["faux"], model: "faux/faux-1", listed: ["faux-1"] });
	});

	it("answers requests with the queued responses in order and counts the calls", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				yield* scripted.setResponses([fauxAssistantMessage("one")]);
				yield* scripted.appendResponses([fauxAssistantMessage("two")]);
				const pendingBefore = yield* scripted.pendingResponseCount;
				const first = yield* complete(scripted.model, context);
				const second = yield* complete(scripted.model, context);
				return {
					pendingBefore,
					texts: [first.content, second.content],
					calls: yield* scripted.callCount,
					pendingAfter: yield* scripted.pendingResponseCount,
				};
			}).pipe(Effect.provide(ScriptedModels.layer())),
		);
		expect(result).toEqual({
			pendingBefore: 2,
			texts: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]],
			calls: 2,
			pendingAfter: 0,
		});
	});

	it("replaces the queue with setResponses", async () => {
		const message = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				yield* scripted.setResponses([fauxAssistantMessage("dropped")]);
				yield* scripted.setResponses([fauxAssistantMessage("kept")]);
				return yield* complete(scripted.model, context);
			}).pipe(Effect.provide(ScriptedModels.layer())),
		);
		expect(message.content).toEqual([{ type: "text", text: "kept" }]);
	});

	it("passes pi-ai's faux options through: provider id and models", async () => {
		const ids = await Effect.runPromise(
			ScriptedModels.use((scripted) =>
				Effect.succeed(scripted.models.map((model) => `${model.provider}/${model.id}`)),
			).pipe(Effect.provide(ScriptedModels.layer({ provider: "lab", models: [{ id: "a" }, { id: "b" }] }))),
		);
		expect(ids).toEqual(["lab/a", "lab/b"]);
	});
});
