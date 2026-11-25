import { fauxProvider } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Models } from "../src/index.ts";

describe("Models.layer", () => {
	it("provides pi-ai's own collection holding the providers", async () => {
		const first = fauxProvider({ provider: "first", models: [{ id: "a" }] });
		const second = fauxProvider({ provider: "second", models: [{ id: "b" }] });
		const listed = await Effect.runPromise(
			Models.use((models) =>
				Effect.succeed({
					providers: models.getProviders().map((provider) => provider.id),
					models: models.getModels().map((model) => `${model.provider}/${model.id}`),
				}),
			).pipe(Effect.provide(Models.layer([first.provider, second.provider]))),
		);
		expect(listed).toEqual({ providers: ["first", "second"], models: ["first/a", "second/b"] });
	});

	it("lets a later provider replace an earlier one with the same id", async () => {
		const earlier = fauxProvider({ provider: "same", models: [{ id: "old" }] });
		const later = fauxProvider({ provider: "same", models: [{ id: "new" }] });
		const ids = await Effect.runPromise(
			Models.use((models) => Effect.succeed(models.getModels("same").map((model) => model.id))).pipe(
				Effect.provide(Models.layer([earlier.provider, later.provider])),
			),
		);
		expect(ids).toEqual(["new"]);
	});

	it("builds a fresh collection for each build of the layer", async () => {
		const layer = Models.layer([]);
		const added = fauxProvider({ provider: "added" });
		const afterAdding = await Effect.runPromise(
			Models.use((models) =>
				Effect.sync(() => {
					models.setProvider(added.provider);
					return models.getProviders().length;
				}),
			).pipe(Effect.provide(layer)),
		);
		const secondBuild = await Effect.runPromise(
			Models.use((models) => Effect.succeed(models.getProviders().length)).pipe(Effect.provide(layer)),
		);
		expect([afterAdding, secondBuild]).toEqual([1, 0]);
	});
});
