import { join } from "node:path";
import type { SettingsConfig } from "@earendil-works/pi-coding-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { Tui } from "@effectified/pi-tui";
import { Deferred, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	ModelRuntime,
	modelSelector,
	oauthSelector,
	SessionManager,
	SettingsManager,
	sessionSelector,
	settingsSelector,
	showImagesSelector,
	themeSelector,
	thinkingSelector,
	treeSelector,
	userMessageSelector,
} from "../src/index.ts";
import { environment, onTui, TestTerminal } from "./interactive.ts";
import { tempDir } from "./scripted.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

/** The first `count` events of a component. */
function first<A>(events: Stream.Stream<A>, count: number): Effect.Effect<ReadonlyArray<A>> {
	return Stream.runCollect(Stream.take(events, count));
}

describe("themeSelector", () => {
	it("reports the theme the user moves to and the one chosen", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* themeSelector("dark");
				component.getSelectList().handleInput(DOWN);
				component.getSelectList().handleInput(ENTER);
				return yield* first(events, 2);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen.map((event) => event.kind)).toEqual(["preview", "select"]);
		expect(seen[0]?.args).toEqual(seen[1]?.args);
	});
});

describe("showImagesSelector", () => {
	it("reports the choice", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* showImagesSelector(true);
				component.getSelectList().handleInput(DOWN);
				component.getSelectList().handleInput(ENTER);
				return yield* first(events, 1);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([{ kind: "select", args: [false] }]);
	});
});

describe("thinkingSelector", () => {
	it("reports the level chosen, and the user leaving", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* thinkingSelector("off", ["off", "low", "high"]);
				component.handleInput(DOWN);
				component.handleInput(ENTER);
				component.handleInput(ESCAPE);
				return yield* first(events, 2);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([
			{ kind: "select", args: ["low"] },
			{ kind: "cancel", args: [] },
		]);
	});
});

describe("userMessageSelector", () => {
	it("reports the message chosen to fork from", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* userMessageSelector(
					[
						{ id: "first", text: "First message" },
						{ id: "second", text: "Second message" },
					],
					"first",
				);
				component.getMessageList().handleInput(ENTER);
				return yield* first(events, 1);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([{ kind: "select", args: ["first"] }]);
	});
});

describe("treeSelector", () => {
	it("reports the entry of the session tree chosen", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const sessions = yield* SessionManager.inMemory(yield* tempDir);
				const id = yield* sessions.appendMessage({ role: "user", content: "Only message", timestamp: 0 });
				const { component, events } = yield* treeSelector(yield* sessions.getTree(), id, 20);
				component.handleInput(ENTER);
				return { id, events: yield* first(events, 1) };
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen.events).toEqual([{ kind: "select", args: [seen.id] }]);
	});
});

describe("modelSelector", () => {
	it("lists the runtime's models for the running TUI and reports the user leaving", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* environment({ PI_OFFLINE: "1" });
				const runtime = yield* ModelRuntime.make({
					authPath: join(dir, "auth.json"),
					modelsPath: null,
					refreshOnCreate: false,
				});
				const { component, events } = yield* modelSelector(undefined, runtime, []);
				component.handleInput(ESCAPE);
				return yield* first(events, 1);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([{ kind: "cancel", args: [] }]);
	});
});

describe("oauthSelector", () => {
	it("reports the provider chosen and how to sign in", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* oauthSelector("login", [
					{ id: "faux", name: "Faux", authType: "api_key" },
				]);
				component.handleInput(ENTER);
				return yield* first(events, 1);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([{ kind: "select", args: ["faux", "api_key"] }]);
	});
});

describe("sessionSelector", () => {
	it("lists what its Effect gives and reports the user leaving", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const listed = yield* Deferred.make<void>();
				const { component, events } = yield* sessionSelector({
					current: Effect.as(Deferred.succeed(listed, undefined), []),
					all: Effect.succeed([]),
				});
				yield* Deferred.await(listed);
				component.handleInput(ESCAPE);
				return yield* first(events, 1);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([{ kind: "cancel", args: [] }]);
	});
});

describe("settingsSelector", () => {
	it("reports the setting the user changes under the name of Pi's callback", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const settings = (yield* SettingsManager.inMemory()).pi;
				const config: SettingsConfig = {
					autoCompact: true,
					defaultModel: "not set",
					availableDefaultModels: [],
					showImages: settings.getShowImages(),
					imageWidthCells: settings.getImageWidthCells(),
					autoResizeImages: settings.getImageAutoResize(),
					blockImages: settings.getBlockImages(),
					enableSkillCommands: settings.getEnableSkillCommands(),
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					transport: settings.getTransport(),
					sessionShareDestination: settings.getSessionShareDestination(),
					httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
					cacheWarmingMode: settings.getCacheWarmingMode(),
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					modelThinkingLevels: settings.getAllModelThinkingLevels(),
					currentTheme: "dark",
					terminalTheme: "dark",
					availableThemes: ["dark", "light"],
					hideThinkingBlock: false,
					mermaidRenderingMode: settings.getMermaidRenderingMode(),
					collapseChangelog: settings.getCollapseChangelog(),
					enableInstallTelemetry: settings.getEnableInstallTelemetry(),
					doubleEscapeAction: settings.getDoubleEscapeAction(),
					treeFilterMode: settings.getTreeFilterMode(),
					showHardwareCursor: settings.getShowHardwareCursor(),
					defaultProjectTrust: settings.getDefaultProjectTrust(),
					editorPaddingX: settings.getEditorPaddingX(),
					outputPad: settings.getOutputPad(),
					autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
					quietStartup: settings.getQuietStartup(),
					clearOnShrink: settings.getClearOnShrink(),
					showTerminalProgress: settings.getShowTerminalProgress(),
					tuiMode: "regular",
					fullscreenExitOutput: settings.getFullscreenExitOutput(),
					fullscreenScrollbar: settings.getFullscreenScrollbar(),
					fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
					fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
					warnings: settings.getWarnings(),
					notices: settings.getNotices(),
				};
				const { component, events } = yield* settingsSelector(config);
				// The first setting is auto-compaction: Enter toggles it, Escape leaves.
				component.getSettingsList().handleInput(ENTER);
				component.getSettingsList().handleInput(ESCAPE);
				return yield* first(events, 2);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toEqual([
			{ kind: "onAutoCompactChange", args: [false] },
			{ kind: "onCancel", args: [] },
		]);
	});
});

describe("the selectors' Tui", () => {
	it("is the program's: a selector made for one TUI renders in it", async () => {
		const terminal = new TestTerminal(80, 24);
		const screen = await runTest(
			Effect.gen(function* () {
				const tui = yield* Tui.Tui;
				const { component } = yield* showImagesSelector(true);
				tui.addChild(component);
				yield* Tui.render();
				return (yield* terminal.screen).join("\n");
			}).pipe(Effect.provide(onTui(terminal))),
		);
		expect(screen).toContain("Show images inline in terminal");
	});
});
