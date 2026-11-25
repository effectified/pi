import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { getModel, ModelRef } from "../src/index.ts";
import { ScriptedModels } from "../src/testing/index.ts";

const scripted = ScriptedModels.layer({ models: [{ id: "small" }, { id: "large", contextWindow: 200000 }] });

describe("getModel", () => {
	it("returns the registered chat model a reference names", async () => {
		const model = await Effect.runPromise(
			getModel({ provider: "faux", modelId: "large" }).pipe(Effect.provide(scripted)),
		);
		expect(model.id).toBe("large");
		expect(model.provider).toBe("faux");
		expect(model.contextWindow).toBe(200000);
	});

	it("fails with ModelNotFound for a model the provider does not list", async () => {
		const error = await Effect.runPromise(
			Effect.flip(getModel({ provider: "faux", modelId: "medium" })).pipe(Effect.provide(scripted)),
		);
		expect(error._tag).toBe("ModelNotFound");
		expect(error.provider).toBe("faux");
		expect(error.modelId).toBe("medium");
		expect(error.message).toBe('No chat model "medium" is registered for provider "faux"');
	});

	it("fails with ModelNotFound for a provider that is not registered", async () => {
		const error = await Effect.runPromise(
			Effect.flip(getModel({ provider: "nowhere", modelId: "small" })).pipe(Effect.provide(scripted)),
		);
		expect(error._tag).toBe("ModelNotFound");
		expect(error.provider).toBe("nowhere");
	});
});

describe("ModelRef", () => {
	it("decodes the provider and the model id, and rejects a reference without them", () => {
		const decode = Schema.decodeUnknownExit(ModelRef);
		expect(Exit.isSuccess(decode({ provider: "faux", modelId: "small" }))).toBe(true);
		expect(Exit.isFailure(decode({ provider: "faux" }))).toBe(true);
	});
});
