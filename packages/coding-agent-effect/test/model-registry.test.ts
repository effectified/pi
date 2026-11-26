import { runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ModelRegistry, ModelRuntime } from "../src/index.ts";
import { services } from "./scripted.ts";

describe("ModelRegistry.layer", () => {
	it("is Pi's registry over the program's model runtime, its queries as Effects", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const runtime = yield* ModelRuntime;
				yield* runtime.registerNativeProvider(models.provider);
				const registry = yield* ModelRegistry;
				const all = yield* registry.getAll;
				return {
					listed: all.some((model) => model.id === models.model.id),
					found: (yield* registry.find(models.model.provider, models.model.id))?.id,
					missing: yield* registry.find(models.model.provider, "no-such-model"),
				};
			}).pipe(Effect.provide(Layer.provideMerge(ModelRegistry.layer, services))),
		);
		expect(seen).toEqual({ listed: true, found: "faux-1", missing: undefined });
	});
});
