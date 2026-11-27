import { fauxProvider } from "@earendil-works/pi-ai";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Credentials, getAuth, Models, ProviderAuthContext, ProviderId } from "../src/index.ts";

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

describe("Models.layerWithAuth", () => {
	it("asks the Credentials and ProviderAuthContext services of the context it is built in", async () => {
		const asked: string[] = [];
		const credentials = Layer.succeed(Credentials, {
			read: (providerId) => Effect.sync(() => void asked.push(`read ${providerId}`)).pipe(Effect.as(Option.none())),
			list: Effect.succeed([]),
			modify: () => Effect.succeed(Option.none()),
			delete: () => Effect.void,
		});
		const authContext = Layer.succeed(ProviderAuthContext, {
			env: (name) => Effect.sync(() => void asked.push(`env ${name}`)).pipe(Effect.as(Option.none())),
			fileExists: () => Effect.succeed(false),
		});
		const { provider } = fauxProvider({ provider: "faux" });
		const auth = await Effect.runPromise(
			getAuth(ProviderId.make("faux")).pipe(
				Effect.provide(Models.layerWithAuth([provider]).pipe(Layer.provide(Layer.merge(credentials, authContext)))),
			),
		);
		expect(Option.isSome(auth)).toBe(true);
		expect(asked).toEqual(["read faux"]);
	});
});
