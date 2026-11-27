// What tui-effect writes by hand that mirrors a pi-tui type, checked against pi-tui's own types. Type-only: nothing
// here runs. Everything else of ours is derived from pi-tui (imported types, `Parameters`, indexed access).

import type * as PiTui from "@earendil-works/pi-tui";
import type {
	NativeClipboard,
	parseColor as piParseColor,
	SettingsList,
	StdinBufferEventMap,
	TuiAltScreenOptions,
	TuiMode,
} from "@earendil-works/pi-tui";
import type { Assert, Conform } from "../../../effect/conformance.ts";
import type { Clipboard } from "../src/clipboard.ts";
import type { ClipboardError, InvalidColor } from "../src/errors.ts";
import type { SettingsListEvent } from "../src/settings-list.ts";
import type { InputSequence } from "../src/split-input.ts";
import type { FullscreenOptions, LayerOptions } from "../src/tui.ts";

/** `Clipboard` has the members of pi-tui's `NativeClipboard`, and `setText` takes what pi-tui's takes. */
export type ClipboardMembers = Assert<Conform<keyof Clipboard, keyof NativeClipboard>>;
export type ClipboardSetText = Assert<
	Conform<Parameters<NonNullable<Clipboard["setText"]>>, Parameters<NonNullable<NativeClipboard["setText"]>>>
>;

/** `ClipboardError.operation` names a transfer of pi-tui's `NativeClipboard`: one per member. */
export type ClipboardOperations = Assert<Conform<ClipboardError["operation"], keyof NativeClipboard>>;

/** `InvalidColor.value` is what pi-tui's `parseColor` takes. */
export type InvalidColorValue = Assert<Conform<InvalidColor["value"], Parameters<typeof piParseColor>[0]>>;

/** An `InputSequence` has a kind for each event of pi-tui's `StdinBuffer`, carrying what that event is called with. */
export type InputSequenceKinds = Assert<Conform<InputSequence["kind"], keyof StdinBufferEventMap>> &
	Assert<
		Conform<
			[Extract<InputSequence, { kind: "data" }>["sequence"], Extract<InputSequence, { kind: "paste" }>["content"]],
			[StdinBufferEventMap["data"][0], StdinBufferEventMap["paste"][0]]
		>
	>;

/** A `change` event of `settingsList` carries what pi-tui's `onChange` is called with. */
export type SettingsListChange = Assert<
	Conform<
		[Extract<SettingsListEvent, { kind: "change" }>["id"], Extract<SettingsListEvent, { kind: "change" }>["value"]],
		Parameters<ConstructorParameters<typeof SettingsList>[3]>
	>
>;

/** `fullscreen`'s alternate-screen options are pi-tui's, by name: the callbacks among them are Effects here. */
export type FullscreenOptionNames = Assert<
	Conform<keyof NonNullable<FullscreenOptions["altScreen"]>, keyof TuiAltScreenOptions>
>;

/** `layer`'s modes are pi-tui's names of its two TUIs. */
export type LayerModes = Assert<Conform<LayerOptions["mode"], TuiMode>>;

/** The names of the error classes pi-tui exports. */
type PiErrorClass = {
	[K in keyof typeof PiTui]: (typeof PiTui)[K] extends abstract new (...args: never[]) => Error ? K : never;
}[keyof typeof PiTui];

/** pi-tui exports no error class, so `TuiError` maps none: a class pi-tui adds fails here until it has a tag. */
export type ErrorClasses = Assert<Conform<PiErrorClass, never>>;
