import { fromPiModelRef } from "@effectified/pi-ai";
import { ToolName } from "@effectified/pi-durable";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Classification, ModelNotCleared, Policy } from "../src/index.ts";

const labels = ["public", "internal", "confidential"];

const policy = Schema.decodeSync(Policy.Policy)({
	...Policy.empty,
	classifications: labels,
	toolCeilings: { search: "public", summarize: "internal" },
	modelCeilings: [
		{ provider: "acme", modelId: "small", ceiling: "internal" },
		{ provider: "acme", modelId: "vault", ceiling: "confidential" },
	],
});

describe("within", () => {
	it("holds for a classification at or below the ceiling", () => {
		expect(Classification.within(labels, "internal", "public")).toBe(true);
		expect(Classification.within(labels, "internal", "internal")).toBe(true);
		expect(Classification.within(labels, "internal", "confidential")).toBe(false);
	});

	it("puts an absent classification and an unlisted label above every ceiling", () => {
		expect(Classification.within(labels, "confidential", undefined)).toBe(false);
		expect(Classification.within(labels, "confidential", "secret")).toBe(false);
		expect(Classification.within(labels, "secret", "public")).toBe(false);
	});
});

describe("toolCleared", () => {
	it("clears a tool whose ceiling is not below the conversation's classification", () => {
		expect(Classification.toolCleared(policy, ToolName.make("search"), "public")).toBe(true);
		expect(Classification.toolCleared(policy, ToolName.make("search"), "internal")).toBe(false);
		expect(Classification.toolCleared(policy, ToolName.make("summarize"), "internal")).toBe(true);
		expect(Classification.toolCleared(policy, ToolName.make("summarize"), "confidential")).toBe(false);
	});

	it("does not limit a tool without a ceiling, and refuses a tool with one to an unclassified conversation", () => {
		expect(Classification.toolCleared(policy, ToolName.make("read"), "confidential")).toBe(true);
		expect(Classification.toolCleared(policy, ToolName.make("read"), undefined)).toBe(true);
		expect(Classification.toolCleared(policy, ToolName.make("search"), undefined)).toBe(false);
		expect(Classification.toolCleared(policy, ToolName.make("toString"), "confidential")).toBe(true);
	});
});

describe("checkModel", () => {
	const small = fromPiModelRef({ provider: "acme", modelId: "small" });
	const rejected = (model: Classification.ModelRef, classification: string | undefined) =>
		Effect.runPromise(Effect.flip(Classification.checkModel(policy, model, classification)));

	it("accepts a model whose ceiling is at or above the classification", async () => {
		await expect(Effect.runPromise(Classification.checkModel(policy, small, "public"))).resolves.toBeUndefined();
		await expect(Effect.runPromise(Classification.checkModel(policy, small, "internal"))).resolves.toBeUndefined();
		const vault = fromPiModelRef({ provider: "acme", modelId: "vault" });
		await expect(
			Effect.runPromise(Classification.checkModel(policy, vault, "confidential")),
		).resolves.toBeUndefined();
	});

	it("rejects a model whose ceiling is below the classification, with both in the error", async () => {
		const error = await rejected(small, "confidential");
		expect(error).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "acme", modelId: "small" }),
				classification: "confidential",
				ceiling: "internal",
			}),
		);
		expect(error.message).toBe("Model acme/small is cleared up to internal, not for confidential");
	});

	it("rejects a model the policy lists no ceiling for, and any model for an unclassified conversation", async () => {
		const unlisted = await rejected(fromPiModelRef({ provider: "other", modelId: "small" }), "public");
		expect(unlisted).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "other", modelId: "small" }),
				classification: "public",
				ceiling: undefined,
			}),
		);
		expect(unlisted.message).toBe("Model other/small has no classification ceiling");
		const unclassified = await rejected(small, undefined);
		expect(unclassified).toEqual(
			ModelNotCleared.make({
				...fromPiModelRef({ provider: "acme", modelId: "small" }),
				classification: undefined,
				ceiling: "internal",
			}),
		);
		expect(unclassified.message).toBe("Model acme/small may not serve a conversation without a classification");
	});

	it("accepts every model when the policy has no classifications", async () => {
		const check = Classification.checkModel(
			Policy.empty,
			fromPiModelRef({ provider: "any", modelId: "model" }),
			undefined,
		);
		await expect(Effect.runPromise(check)).resolves.toBeUndefined();
	});
});
