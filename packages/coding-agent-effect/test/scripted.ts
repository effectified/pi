// What the tests share: a temporary directory, pi-ai's scripted provider on a model runtime, and a session over them
// with in-memory settings and storage. No network, no keys.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@effectified/pi-agent";
import { type FauxResponseFactory, fauxAssistantMessage, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Latch, Layer, type Scope } from "effect";
import {
	AgentSession,
	type AgentSessionOptions,
	type Extension,
	ModelRuntime,
	ResourceLoader,
	type ResourceLoaderOptions,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

/** A new directory under the system's temporary directory, removed when the scope closes. */
export const tempDir: Effect.Effect<string, never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "pi-coding-agent-effect-"))),
	(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

/** pi-ai's scripted provider; a test queues its responses with `setResponses`. */
export const scripted = ScriptedModels.layer({ tokenSize: { min: 64, max: 64 } });

/** What `openSession` takes: the session's options, its extensions and its settings. */
export interface SessionOptions<R> extends Omit<AgentSessionOptions<R>, "cwd" | "agentDir"> {
	readonly extensions?: ReadonlyArray<Extension.Extension<R>>;
	readonly extensionFactories?: ResourceLoaderOptions<R>["extensionFactories"];
	readonly settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

/**
 * A session in a temporary directory on the scripted provider's model, its extensions loaded, nothing else
 * discovered: no global agent directory, no project resources, no context files.
 */
export function openSession<R = never>(options: SessionOptions<R> = {}) {
	const { extensions, extensionFactories, settings, ...rest } = options;
	return Effect.gen(function* () {
		const dir = yield* tempDir;
		const models = yield* ScriptedModels;
		const modelRuntime = yield* ModelRuntime;
		yield* modelRuntime.registerNativeProvider(models.provider);
		const settingsManager = yield* SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			...settings,
		});
		const resourceLoader = yield* ResourceLoader.make({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			extensions: extensions ?? [],
			extensionFactories: extensionFactories ?? [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		const session = yield* AgentSession.make({
			cwd: dir,
			agentDir: dir,
			model: models.model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			sessionManager: yield* SessionManager.inMemory(dir),
			resourceLoader,
			...rest,
		});
		return { session, models, dir };
	});
}

/** The model runtime of a test: credentials in memory, no `models.json`, no catalog refresh. */
export const runtime = Layer.unwrap(
	Effect.map(tempDir, (dir) =>
		ModelRuntime.layer({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false }),
	),
);

/** The scripted provider and the model runtime a session of `openSession` needs. */
export const services = Layer.merge(scripted, Layer.orDie(runtime));

/**
 * A response that never comes: the request waits until its run is aborted, then ends as pi-ai ends an aborted one.
 * `started` opens when the request arrives, so a test knows the run is waiting on the model.
 */
export function held(started: Latch.Latch): FauxResponseFactory {
	return (_context, options) =>
		new Promise((resolve) => {
			options?.signal?.addEventListener(
				"abort",
				() => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
				{ once: true },
			);
			// Opened last: the waiting fiber may run at once and abort the request.
			Latch.openUnsafe(started);
		});
}

/** The texts of the messages of `role` in `messages`. */
export function texts(messages: ReadonlyArray<AgentMessage>, role: AgentMessage["role"]): string[] {
	return messages.flatMap((message) =>
		message.role === role && "content" in message && Array.isArray(message.content)
			? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			: [],
	);
}
