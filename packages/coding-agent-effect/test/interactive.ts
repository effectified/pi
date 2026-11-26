// What the tests of interactive mode share: a session runtime on the scripted model in a temporary directory, Pi's
// process environment kept offline, and interactive mode on pi-tui's virtual terminal. Never a real TTY.

import { join } from "node:path";
import { ScriptedModels } from "@effectified/pi-ai/testing";
import { Tui } from "@effectified/pi-tui";
import { Effect, Layer, type Scope, Stream } from "effect";
import { TestTerminal } from "../../tui-effect/test/terminal.ts";
import {
	type AgentSessionEvent,
	AgentSessionRuntime,
	type AgentSessionRuntimeHandle,
	type Extension,
	InteractiveMode,
	type InteractiveModeHandle,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";
import { tempDir } from "./scripted.ts";

export { TestTerminal };

/**
 * Sets `variables` in the process environment until the scope closes: Pi's interactive mode reads its agent directory
 * and whether it may go online from there.
 */
export function environment(variables: Record<string, string>): Effect.Effect<void, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => {
			const before = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
			Object.assign(process.env, variables);
			return before;
		}),
		(before) =>
			Effect.sync(() => {
				for (const [key, value] of Object.entries(before)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}),
	);
}

/**
 * A session runtime on the scripted model with `extensions`, nothing else discovered, and Pi's process environment
 * offline: no catalog refresh, version or package check, no download of `fd` and `rg`, and the agent directory in a
 * temporary directory.
 */
export function openRuntime(extensions: ReadonlyArray<Extension.Extension<never>> = []) {
	return Effect.gen(function* () {
		const dir = yield* tempDir;
		const agentDir = join(dir, "agent");
		yield* environment({ PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir });
		const models = yield* ScriptedModels;
		const modelRuntime = yield* ModelRuntime;
		yield* modelRuntime.registerNativeProvider(models.provider);
		const runtime = yield* AgentSessionRuntime.make({
			cwd: dir,
			agentDir,
			sessionManager: yield* SessionManager.inMemory(dir),
			modelRuntime,
			settingsManager: yield* SettingsManager.inMemory({ retry: { enabled: false }, quietStartup: true }),
			resources: { extensions, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
			session: { model: models.model, thinkingLevel: "off" },
		});
		return { runtime, models, dir };
	});
}

/** Interactive mode over `runtime` on `terminal`, in Pi's dark theme. */
export function openMode(
	runtime: AgentSessionRuntimeHandle,
	terminal: TestTerminal,
): Effect.Effect<InteractiveModeHandle, never, Scope.Scope> {
	return Effect.gen(function* () {
		yield* initTheme("dark");
		return yield* Effect.orDie(InteractiveMode.make(runtime, { terminal }));
	});
}

/** The session's events from now until the scope closes. */
export function sessionEvents(
	runtime: AgentSessionRuntimeHandle,
): Effect.Effect<Stream.Stream<AgentSessionEvent>, never, Scope.Scope> {
	return Effect.flatMap(runtime.session, (session) => session.subscribe);
}

/** Waits for the first event of `type` in `events`. */
export function next(events: Stream.Stream<AgentSessionEvent>, type: AgentSessionEvent["type"]): Effect.Effect<void> {
	return Effect.asVoid(Stream.runHead(Stream.filter(events, (event) => event.type === type)));
}

/** Draws a frame of `mode` now and gives the terminal's rows. */
export function screen(mode: InteractiveModeHandle, terminal: TestTerminal): Effect.Effect<string[]> {
	return Effect.andThen(Effect.provideService(Tui.render(), Tui.Tui, mode.tui), terminal.screen);
}

/** pi-tui's `Tui` service on `terminal`, a regular TUI, in Pi's dark theme: what interactive mode's components need. */
export function onTui(terminal: TestTerminal): Layer.Layer<Tui.Tui> {
	return Layer.merge(Tui.layer({ mode: "regular", terminal }), Layer.effectDiscard(initTheme("dark")));
}
