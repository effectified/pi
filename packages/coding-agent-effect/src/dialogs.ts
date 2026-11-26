// Interactive mode's dialogs (an extension's input, selection and editor, the login dialog) as scoped components for
// the running TUI, whose answers are a Stream instead of constructor callbacks.

import {
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	LoginDialogComponent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Tui } from "@effectified/pi-tui";
import { Effect, type Scope } from "effect";
import { type WithEvents, withEvents } from "./component-events.ts";

/** A component made for the scope and the running TUI, and what the user does in it. */
type Made<A, C> = Effect.Effect<WithEvents<A, C>, never, Scope.Scope | Tui.Tui>;

type InputArgs = ConstructorParameters<typeof ExtensionInputComponent>;

/** What an input dialog reports: the text submitted, or that the user left it (or its countdown ended). */
export interface ExtensionInputCallbacks {
	readonly submit: InputArgs[2];
	readonly cancel: InputArgs[3];
}

/**
 * Pi's one-line input dialog of `ctx.ui.input`, titled `title`. `options.timeout` (ms) counts down in the title and
 * cancels at its end, on Pi's own timer, which stops when the scope closes.
 */
export function extensionInput(
	title: InputArgs[0],
	placeholder?: InputArgs[1],
	options?: Omit<NonNullable<InputArgs[4]>, "tui">,
): Made<ExtensionInputComponent, ExtensionInputCallbacks> {
	return Effect.gen(function* () {
		const tui = yield* Tui.Tui;
		return yield* withEvents<ExtensionInputComponent, ExtensionInputCallbacks>(
			(emit) => new ExtensionInputComponent(title, placeholder, emit("submit"), emit("cancel"), { ...options, tui }),
			(dialog) => dialog.dispose(),
		);
	});
}

type SelectorArgs = ConstructorParameters<typeof ExtensionSelectorComponent>;

/** What a selection dialog reports: the option chosen, the dialog left (or timed out), the tools expanded or not. */
export interface ExtensionSelectorCallbacks {
	readonly select: SelectorArgs[2];
	readonly cancel: SelectorArgs[3];
	readonly toggleToolsExpanded: NonNullable<NonNullable<SelectorArgs[4]>["onToggleToolsExpanded"]>;
}

/**
 * Pi's selection dialog of `ctx.ui.select`: `options` under `title`. `opts.timeout` (ms) counts down and cancels at
 * its end, on Pi's own timer, which stops when the scope closes. The `app.tools.expand` keybinding is reported, as
 * Pi's own dialog lets it expand the tools behind the dialog.
 */
export function extensionSelector(
	title: SelectorArgs[0],
	options: SelectorArgs[1],
	opts?: Omit<NonNullable<SelectorArgs[4]>, "tui" | "onToggleToolsExpanded">,
): Made<ExtensionSelectorComponent, ExtensionSelectorCallbacks> {
	return Effect.gen(function* () {
		const tui = yield* Tui.Tui;
		return yield* withEvents<ExtensionSelectorComponent, ExtensionSelectorCallbacks>(
			(emit) =>
				new ExtensionSelectorComponent(title, options, emit("select"), emit("cancel"), {
					...opts,
					tui,
					onToggleToolsExpanded: emit("toggleToolsExpanded"),
				}),
			(dialog) => dialog.dispose(),
		);
	});
}

type EditorArgs = ConstructorParameters<typeof ExtensionEditorComponent>;

/** What an editor dialog reports: the text submitted, or that the user left it. */
export interface ExtensionEditorCallbacks {
	readonly submit: EditorArgs[4];
	readonly cancel: EditorArgs[5];
}

/**
 * Pi's multi-line editor dialog of `ctx.ui.editor`, titled `title`, holding `prefill`, matching keys against the
 * process's keybindings (interactive mode's, with the user's configuration, while it runs). Its external editor key
 * (`app.editor.external`) stops the running TUI while `externalEditorCommand` (default: `$VISUAL` or `$EDITOR`) runs.
 */
export function extensionEditor(
	title: EditorArgs[2],
	prefill?: EditorArgs[3],
	options?: EditorArgs[6],
	externalEditorCommand?: EditorArgs[7],
): Made<ExtensionEditorComponent, ExtensionEditorCallbacks> {
	return Effect.gen(function* () {
		const tui = yield* Tui.Tui;
		// Pi types this as its own manager, a subclass of pi-tui's, but the dialog only matches keys with it (`matches`).
		const keybindings = (yield* getKeybindings) as EditorArgs[1];
		return yield* withEvents<ExtensionEditorComponent, ExtensionEditorCallbacks>(
			(emit) =>
				new ExtensionEditorComponent(
					tui,
					keybindings,
					title,
					prefill,
					emit("submit"),
					emit("cancel"),
					options,
					externalEditorCommand,
				),
		);
	});
}

type LoginArgs = ConstructorParameters<typeof LoginDialogComponent>;

/** What a login dialog reports: whether the sign-in succeeded, with a message. */
export interface LoginDialogCallbacks {
	readonly complete: LoginArgs[2];
}

/**
 * Pi's login dialog for the provider `providerId`. The sign-in flow drives it (`showAuth`, `showDeviceCode`,
 * `showPrompt`, ...); the user's cancel aborts its `signal`.
 */
export function loginDialog(
	providerId: LoginArgs[1],
	providerNameOverride?: LoginArgs[3],
	titleOverride?: LoginArgs[4],
): Made<LoginDialogComponent, LoginDialogCallbacks> {
	return Effect.gen(function* () {
		const tui = yield* Tui.Tui;
		return yield* withEvents<LoginDialogComponent, LoginDialogCallbacks>(
			(emit) => new LoginDialogComponent(tui, providerId, emit("complete"), providerNameOverride, titleOverride),
		);
	});
}
