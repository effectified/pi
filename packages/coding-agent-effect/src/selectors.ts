// Interactive mode's selectors (themes, thinking levels, models, providers, sessions, the session tree, messages,
// settings) as scoped components whose choices are a Stream instead of constructor callbacks.

import {
	ModelSelectorComponent,
	OAuthSelectorComponent,
	SessionSelectorComponent,
	type SettingsCallbacks,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	TreeSelectorComponent,
	UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { Tui } from "@effectified/pi-tui";
import { Effect, Record, type Scope } from "effect";
import { type WithEvents, withEvents } from "./component-events.ts";
import type { ModelRuntimeHandle } from "./model-runtime.ts";
import { runner } from "./runner.ts";

/** A component made for the scope, and what the user does in it. */
type Made<A, C> = Effect.Effect<WithEvents<A, C>, never, Scope.Scope>;

type ThemeArgs = ConstructorParameters<typeof ThemeSelectorComponent>;

/** What a theme selector reports: a theme chosen, the selector left, the theme the user moved to (to preview it). */
export interface ThemeSelectorCallbacks {
	readonly select: ThemeArgs[1];
	readonly cancel: ThemeArgs[2];
	readonly preview: ThemeArgs[3];
}

/** Pi's selector of the themes it knows, with `currentTheme` marked and selected. */
export const themeSelector = Effect.fn("Selectors.themeSelector")(
	(currentTheme: ThemeArgs[0]): Made<ThemeSelectorComponent, ThemeSelectorCallbacks> =>
		withEvents((emit) => new ThemeSelectorComponent(currentTheme, emit("select"), emit("cancel"), emit("preview"))),
);

type ShowImagesArgs = ConstructorParameters<typeof ShowImagesSelectorComponent>;

/** What the selector of whether to show images reports: the choice, or that the user left it. */
export interface ShowImagesSelectorCallbacks {
	readonly select: ShowImagesArgs[1];
	readonly cancel: ShowImagesArgs[2];
}

/** Pi's yes-or-no selector of whether images show inline, `currentValue` selected. */
export const showImagesSelector = Effect.fn("Selectors.showImagesSelector")(
	(currentValue: ShowImagesArgs[0]): Made<ShowImagesSelectorComponent, ShowImagesSelectorCallbacks> =>
		withEvents((emit) => new ShowImagesSelectorComponent(currentValue, emit("select"), emit("cancel"))),
);

type ThinkingArgs = ConstructorParameters<typeof ThinkingSelectorComponent>;

/** What a thinking level selector reports: a level chosen, the selector left, a level saved as the default. */
export interface ThinkingSelectorCallbacks {
	readonly select: ThinkingArgs[2];
	readonly cancel: ThinkingArgs[3];
	readonly selectAsDefault: NonNullable<ThinkingArgs[4]>;
}

/**
 * Pi's selector of `availableLevels`, `currentLevel` selected, and `defaultThinkingLevel` marked. The
 * `app.thinking.save` keybinding saves the selected level as the default, as in Pi's own `/thinking`.
 */
export const thinkingSelector = Effect.fn("Selectors.thinkingSelector")(
	(
		currentLevel: ThinkingArgs[0],
		availableLevels: ThinkingArgs[1],
		defaultThinkingLevel?: ThinkingArgs[5],
	): Made<ThinkingSelectorComponent, ThinkingSelectorCallbacks> =>
		withEvents(
			(emit) =>
				new ThinkingSelectorComponent(
					currentLevel,
					availableLevels,
					emit("select"),
					emit("cancel"),
					emit("selectAsDefault"),
					defaultThinkingLevel,
				),
		),
);

type UserMessageArgs = ConstructorParameters<typeof UserMessageSelectorComponent>;

/** What the selector of a user message reports: the entry chosen (to fork from it), or that the user left it. */
export interface UserMessageSelectorCallbacks {
	readonly select: UserMessageArgs[1];
	readonly cancel: UserMessageArgs[2];
}

/** Pi's selector of the session's user `messages`, `initialSelectedId` selected (default: the last). */
// The signatures of this and `modelSelector` are written on the binding: inferred, their declarations would name Pi's
// internal item types, which no `.d.ts` can import.
export const userMessageSelector: (
	messages: UserMessageArgs[0],
	initialSelectedId?: UserMessageArgs[3],
) => Made<UserMessageSelectorComponent, UserMessageSelectorCallbacks> = Effect.fn("Selectors.userMessageSelector")(
	(messages: UserMessageArgs[0], initialSelectedId?: UserMessageArgs[3]) =>
		withEvents<UserMessageSelectorComponent, UserMessageSelectorCallbacks>(
			(emit) => new UserMessageSelectorComponent(messages, emit("select"), emit("cancel"), initialSelectedId),
		),
);

type TreeArgs = ConstructorParameters<typeof TreeSelectorComponent>;

/** What the session tree selector reports: the entry chosen, the selector left, an entry's label set or removed. */
export interface TreeSelectorCallbacks {
	readonly select: TreeArgs[3];
	readonly cancel: TreeArgs[4];
	readonly labelChange: NonNullable<TreeArgs[5]>;
}

/**
 * Pi's selector of the session tree `tree` (`/tree`), the leaf `currentLeafId` marked, `terminalHeight` rows tall.
 * Its `onCopy` property is a Stream through `@effectified/pi-tui`'s `events`.
 */
// Written out: the declaration build cannot name Pi's `FilterMode`, which its package does not export.
export const treeSelector: (
	tree: TreeArgs[0],
	currentLeafId: TreeArgs[1],
	terminalHeight: TreeArgs[2],
	initialSelectedId?: TreeArgs[6],
	initialFilterMode?: TreeArgs[7],
) => Made<TreeSelectorComponent, TreeSelectorCallbacks> = Effect.fn("Selectors.treeSelector")(
	(
		tree: TreeArgs[0],
		currentLeafId: TreeArgs[1],
		terminalHeight: TreeArgs[2],
		initialSelectedId?: TreeArgs[6],
		initialFilterMode?: TreeArgs[7],
	): Made<TreeSelectorComponent, TreeSelectorCallbacks> =>
		withEvents(
			(emit) =>
				new TreeSelectorComponent(
					tree,
					currentLeafId,
					terminalHeight,
					emit("select"),
					emit("cancel"),
					emit("labelChange"),
					initialSelectedId,
					initialFilterMode,
				),
		),
);

type ModelArgs = ConstructorParameters<typeof ModelSelectorComponent>;

/** What a model selector reports: a model chosen, the selector left, a model saved as the default. */
export interface ModelSelectorCallbacks {
	readonly select: ModelArgs[4];
	readonly cancel: ModelArgs[5];
	readonly selectAsDefault: NonNullable<ModelArgs[7]>;
}

/**
 * Pi's selector of the models of `modelRuntime` (or of `scopedModels`), for the running TUI: `currentModel` selected,
 * `defaultModel` marked, the search field holding `initialSearchInput`. It refreshes the model catalogs on its own
 * (at most 15 s, on Pi's timer) until the scope closes. The `app.models.save` keybinding saves the selected model as
 * the default, as in Pi's own `/model`.
 */
export const modelSelector: (
	currentModel: ModelArgs[1],
	modelRuntime: ModelRuntimeHandle,
	scopedModels: ModelArgs[3],
	initialSearchInput?: ModelArgs[6],
	defaultModel?: ModelArgs[8],
) => Effect.Effect<WithEvents<ModelSelectorComponent, ModelSelectorCallbacks>, never, Scope.Scope | Tui.Tui> =
	Effect.fn("Selectors.modelSelector")(function* (
		currentModel: ModelArgs[1],
		modelRuntime: ModelRuntimeHandle,
		scopedModels: ModelArgs[3],
		initialSearchInput?: ModelArgs[6],
		defaultModel?: ModelArgs[8],
	) {
		const tui = yield* Tui.Tui;
		return yield* withEvents<ModelSelectorComponent, ModelSelectorCallbacks>(
			(emit) =>
				new ModelSelectorComponent(
					tui,
					currentModel,
					modelRuntime.pi,
					scopedModels,
					emit("select"),
					emit("cancel"),
					initialSearchInput,
					emit("selectAsDefault"),
					defaultModel,
				),
			(selector) => selector.dispose(),
		);
	});

type OAuthArgs = ConstructorParameters<typeof OAuthSelectorComponent>;

/** What the provider selector of `/login` and `/logout` reports: a provider and how to sign in, or that the user left. */
export interface OAuthSelectorCallbacks {
	readonly select: OAuthArgs[2];
	readonly cancel: OAuthArgs[3];
}

/**
 * Pi's selector of `providers` to sign in to (`mode` `"login"`) or out of (`"logout"`), for the running TUI, which
 * animates the selected provider's brand until the scope closes.
 */
// Written out: the declaration build cannot name Pi's `AuthSelectorProvider`, which its package does not export.
export const oauthSelector: (
	mode: OAuthArgs[0],
	providers: OAuthArgs[1],
	initialSearchInput?: OAuthArgs[4],
) => Effect.Effect<WithEvents<OAuthSelectorComponent, OAuthSelectorCallbacks>, never, Scope.Scope | Tui.Tui> =
	Effect.fn("Selectors.oauthSelector")(function* (
		mode: OAuthArgs[0],
		providers: OAuthArgs[1],
		initialSearchInput?: OAuthArgs[4],
	): Effect.fn.Return<WithEvents<OAuthSelectorComponent, OAuthSelectorCallbacks>, never, Scope.Scope | Tui.Tui> {
		const tui = yield* Tui.Tui;
		return yield* withEvents<OAuthSelectorComponent, OAuthSelectorCallbacks>(
			(emit) => new OAuthSelectorComponent(mode, providers, emit("select"), emit("cancel"), initialSearchInput, tui),
			(selector) => selector.dispose(),
		);
	});

type SessionArgs = ConstructorParameters<typeof SessionSelectorComponent>;

/** The sessions a session selector lists, as its loaders give them. */
type Sessions = Awaited<ReturnType<SessionArgs[0]>>;

/**
 * What `sessionSelector` lists, and what it may do besides, as Effects that fail with `E` (the selector shows a failed
 * listing; a failed rename is Pi's error) and need `R`.
 */
export interface SessionSelectorOptions<R, E = never> {
	/** The sessions of the current directory, listed first. Interrupted when the user switches scope or leaves. */
	readonly current: Effect.Effect<Sessions, E, R>;
	/** The sessions of every directory. Interrupted when the user switches scope or leaves. */
	readonly all: Effect.Effect<Sessions, E, R>;
	/** Renames a session (its file and its new name); without it, the selector has no rename key. */
	readonly renameSession?: (
		...args: Parameters<NonNullable<NonNullable<SessionArgs[6]>["renameSession"]>>
	) => Effect.Effect<void, E, R>;
	/** Shows the rename key's hint. */
	readonly showRenameHint?: NonNullable<SessionArgs[6]>["showRenameHint"];
	/** The keybindings the list reads (default: the process's). */
	readonly keybindings?: NonNullable<SessionArgs[6]>["keybindings"];
	/** The session file to mark as the current one. */
	readonly currentSessionFilePath?: SessionArgs[7];
}

/** What a session selector reports: a session chosen, the selector left, and the user asking to quit Pi. */
export interface SessionSelectorCallbacks {
	readonly select: SessionArgs[2];
	readonly cancel: SessionArgs[3];
	readonly exit: SessionArgs[4];
}

/**
 * Pi's session selector (`/resume`) for the running TUI, listing what `options.current` and `options.all` give. A
 * failed listing is shown in the selector, as in Pi. Pi's progress of a listing is not shown: the Effects report none.
 */
export const sessionSelector = Effect.fn("Selectors.sessionSelector")(function* <R = never, E = never>(
	options: SessionSelectorOptions<R, E>,
): Effect.fn.Return<WithEvents<SessionSelectorComponent, SessionSelectorCallbacks>, never, Scope.Scope | Tui.Tui | R> {
	const tui = yield* Tui.Tui;
	const context = yield* Effect.context<R>();
	const run = runner(context);
	const { current, all, renameSession, currentSessionFilePath, ...rest } = options;
	return yield* withEvents<SessionSelectorComponent, SessionSelectorCallbacks>(
		(emit) =>
			new SessionSelectorComponent(
				(_progress, signal) => run(current, signal),
				(_progress, signal) => run(all, signal),
				emit("select"),
				emit("cancel"),
				emit("exit"),
				() => tui.requestRender(),
				{
					...rest,
					...(renameSession === undefined
						? {}
						: { renameSession: (path, name) => run(renameSession(path, name)) }),
				},
				currentSessionFilePath,
			),
	);
});

/**
 * The callbacks of Pi's settings selector, each a kind of `settingsSelector`'s events: written out because the selector
 * needs every one; `test/pi-conformance.ts` checks the list against Pi's `SettingsCallbacks`.
 */
export const SETTINGS_CALLBACKS = [
	"onAutoCompactChange",
	"onShowImagesChange",
	"onImageWidthCellsChange",
	"onAutoResizeImagesChange",
	"onBlockImagesChange",
	"onEnableSkillCommandsChange",
	"onSteeringModeChange",
	"onFollowUpModeChange",
	"onTransportChange",
	"onSessionShareDestinationChange",
	"onHttpIdleTimeoutMsChange",
	"onCacheWarmingModeChange",
	"onModelThinkingLevelChange",
	"onModelThinkingLevelRemove",
	"onThemeChange",
	"onThemePreview",
	"onHideThinkingBlockChange",
	"onMermaidRenderingModeChange",
	"onCollapseChangelogChange",
	"onEnableInstallTelemetryChange",
	"onDoubleEscapeActionChange",
	"onTreeFilterModeChange",
	"onShowHardwareCursorChange",
	"onEditorPaddingXChange",
	"onOutputPadChange",
	"onAutocompleteMaxVisibleChange",
	"onQuietStartupChange",
	"onDefaultProjectTrustChange",
	"onClearOnShrinkChange",
	"onShowTerminalProgressChange",
	"onTuiModeChange",
	"onFullscreenExitOutputChange",
	"onFullscreenScrollbarChange",
	"onFullscreenCopyOnSelectChange",
	"onFullscreenWheelScrollLinesChange",
	"onWarningsChange",
	"onNoticeChange",
	"onCancel",
] as const;

/**
 * Pi's settings selector (`/settings`) showing `config`. Each change the user makes is an event named for Pi's
 * callback (`onThemeChange`, ...); the selector changes no setting itself, so the program applies what it reports.
 */
export const settingsSelector = Effect.fn("Selectors.settingsSelector")(
	(
		config: ConstructorParameters<typeof SettingsSelectorComponent>[0],
	): Made<SettingsSelectorComponent, SettingsCallbacks> =>
		withEvents((emit) => {
			const callbacks = Record.fromIterableWith(SETTINGS_CALLBACKS, (name) => [name, emit(name)]);
			// One callback of `SettingsCallbacks` per name of the list, which the conformance check equates.
			return new SettingsSelectorComponent(config, callbacks as unknown as SettingsCallbacks);
		}),
);
