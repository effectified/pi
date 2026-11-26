// A Pi agent on pi-ai's scripted provider, run in its own process by the tests of the modes and the RPC client:
// `--mode rpc` serves RPC mode (as RpcClient starts it), `print <message>` runs print mode, `main <args>` runs Pi's
// CLI. Run with Node and `--conditions=source`, so the pi-effect packages load from their TypeScript.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { AgentSessionRuntime, ModelRuntime, Modes, SessionManager, SettingsManager } from "../../src/index.ts";

const [command, ...rest] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "pi-coding-agent-effect-agent-"));

/** A runtime in a fresh directory on the scripted model, which answers `Answer 1.`, `Answer 2.`, ... in turn. */
const runtime = Effect.gen(function* () {
	const models = yield* ScriptedModels;
	yield* models.setResponses(Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`Answer ${index + 1}.`)));
	const modelRuntime = yield* ModelRuntime.make({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	yield* modelRuntime.registerNativeProvider(models.provider);
	return yield* AgentSessionRuntime.make({
		cwd: dir,
		agentDir: dir,
		sessionManager: yield* SessionManager.inMemory(dir),
		modelRuntime,
		settingsManager: yield* SettingsManager.inMemory({ retry: { enabled: false } }),
		resources: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
		session: { model: models.model, thinkingLevel: "off" },
	});
});

const program =
	command === "main"
		? Modes.main(rest)
		: Effect.flatMap(runtime, (served) =>
				command === "print"
					? Effect.map(Modes.print(served, { mode: "text", initialMessage: rest[0] }), (code) => {
							process.exitCode = code;
						})
					: Modes.rpc(served),
			);

await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(ScriptedModels.layer())));
