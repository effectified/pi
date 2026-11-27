import { join } from "node:path";
import { runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { ModelId, ProviderId } from "@effectified/pi-ai";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ModelRuntime, readStoredCredential, resolveModelScopeWithDiagnostics } from "../src/index.ts";
import { scripted, tempDir } from "./scripted.ts";

describe("ModelRuntime.layer", () => {
	it("holds the providers registered on it, @effectified/pi-ai's scripted one included, and their credentials", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const models = yield* ScriptedModels;
				const authPath = join(dir, "auth.json");
				const runtime = yield* ModelRuntime.make({ authPath, modelsPath: null, refreshOnCreate: false });
				yield* runtime.registerNativeProvider(models.provider);
				const provider = ProviderId.make(models.model.provider);
				yield* runtime.setRuntimeApiKey(provider, Redacted.make("runtime-key"));
				const found = yield* runtime.getModel(provider, ModelId.make(models.model.id));
				return {
					found: found?.id,
					// Pi checks credentials asynchronously; `hasConfiguredAuth` reads the snapshot such a check leaves.
					auth: (yield* runtime.checkAuth(provider))?.type,
					// A runtime key is for this process only: nothing was stored.
					stored: yield* readStoredCredential(provider, authPath),
				};
			}).pipe(Effect.provide(scripted)),
		);
		expect(seen).toEqual({ found: "faux-1", auth: "api_key", stored: undefined });
	});
});

describe("resolveModelScopeWithDiagnostics", () => {
	it("selects the models a pattern names among those with credentials", async () => {
		const ids = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const models = yield* ScriptedModels;
				const runtime = yield* ModelRuntime.make({
					authPath: join(dir, "auth.json"),
					modelsPath: null,
					refreshOnCreate: false,
				});
				yield* runtime.registerNativeProvider(models.provider);
				// The scope is chosen among the models whose credentials Pi checked.
				yield* runtime.getAvailable();
				const scope = yield* resolveModelScopeWithDiagnostics([`${models.model.provider}/*`], runtime);
				return scope.scopedModels.map((scoped) => scoped.model.id);
			}).pipe(Effect.provide(scripted)),
		);
		expect(ids).toEqual(["faux-1"]);
	});
});
