import { join } from "node:path";
import { fauxAssistantMessage, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	Extension,
	ModelRuntime,
	ReplacedSessionContext,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";
import { services, tempDir } from "./scripted.ts";

/** A runtime in a temporary directory on the scripted model, with `extensions` and nothing discovered. */
function openRuntime(extensions: ReadonlyArray<Extension.Extension<never>> = []) {
	return Effect.gen(function* () {
		const dir = yield* tempDir;
		const models = yield* ScriptedModels;
		const modelRuntime = yield* ModelRuntime;
		yield* modelRuntime.registerNativeProvider(models.provider);
		const runtime = yield* AgentSessionRuntime.make({
			cwd: dir,
			agentDir: join(dir, "agent"),
			sessionManager: yield* SessionManager.inMemory(dir),
			modelRuntime,
			settingsManager: yield* SettingsManager.inMemory({ retry: { enabled: false } }),
			resources: { extensions, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
			session: { model: models.model, thinkingLevel: "off" },
		});
		return { runtime, models, dir };
	});
}

describe("AgentSessionRuntime.make", () => {
	it("makes the first session and replaces it with a new one, in which `withSession` runs", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { runtime, models } = yield* openRuntime();
				const first = yield* runtime.session;
				yield* models.setResponses([fauxAssistantMessage("First.")]);
				yield* first.prompt("Hello.");
				const replaced = yield* runtime.newSession({
					withSession: Effect.flatMap(ReplacedSessionContext, (ctx) =>
						ctx.sendMessage({ customType: "note", content: "Started fresh.", display: true }),
					),
				});
				const second = yield* runtime.session;
				return {
					replaced,
					different: (yield* first.sessionId) !== (yield* second.sessionId),
					firstAnswer: yield* first.getLastAssistantText(),
					notes: (yield* second.sessionManager.getEntries()).filter((entry) => entry.type === "custom_message")
						.length,
				};
			}).pipe(Effect.provide(services)),
		);
		expect(seen).toEqual({ replaced: { cancelled: false }, different: true, firstAnswer: "First.", notes: 1 });
	});

	it("fails to import a session file that does not exist with SessionImportFileNotFound", async () => {
		const failure = await runTest(
			Effect.gen(function* () {
				const { runtime, dir } = yield* openRuntime();
				return yield* Effect.flip(runtime.importFromJsonl(join(dir, "missing.jsonl")));
			}).pipe(Effect.provide(services)),
		);
		expect(failure._tag).toBe("SessionImportFileNotFound");
	});

	it("disposes the runtime as Pi's quit does when its scope closes: extensions see session_shutdown", async () => {
		const reasons = await runTest(
			Effect.gen(function* () {
				const seen: string[] = [];
				const watcher = Extension.make("watcher", {
					on: { session_shutdown: (event) => Effect.sync(() => void seen.push(event.reason)) },
				});
				yield* Effect.scoped(
					Effect.gen(function* () {
						const { runtime } = yield* openRuntime([watcher]);
						yield* (yield* runtime.session).bindExtensions();
					}),
				);
				return seen;
			}).pipe(Effect.provide(services)),
		);
		expect(reasons).toEqual(["quit"]);
	});
});
