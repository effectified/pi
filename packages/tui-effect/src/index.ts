// pi-tui in Effect: a running TUI as a scoped service, terminal and component input as Streams, renders, clipboard and
// autocomplete as Effects, and pi-tui's components and pure helpers as they are.

// Every type pi-tui declares (`Component`, `TUI`, `Terminal`, `KeyId`, `Keybindings`, the component and theme types),
// so an application names them without importing pi-tui.
export type * from "@earendil-works/pi-tui";
// pi-tui's components, which are plain objects an application builds and renders synchronously, and its pure helpers:
// colors, keys, keybinding definitions, fuzzy matching, Markdown and LaTeX, image encoding, text width and wrapping.
// The ones that hold a timer or take callbacks have Effect forms below.
export {
	Box,
	backgroundAnsi,
	CombinedAutocompleteProvider,
	Container,
	CURSOR_MARKER,
	calculateImageRows,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	compositeTuiLine,
	decodeKittyPrintable,
	deleteAllKittyImages,
	deleteKittyImage,
	Editor,
	encodeITerm2,
	encodeKitty,
	foregroundAnsi,
	formatProgramStatus,
	fuzzyFilter,
	fuzzyMatch,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getOsc8LinkAtColumn,
	getPngDimensions,
	getSelectPageIndex,
	getWebpDimensions,
	HStack,
	hyperlink,
	Image,
	Input,
	imageFallback,
	indexedColor,
	isFocusable,
	isKeyRelease,
	isKeyRepeat,
	isViewportTUI,
	Key,
	KeybindingsManager,
	Markdown,
	Marked,
	MouseRegion,
	matchesKey,
	mixColors,
	okhslColor,
	oklabToOkhslLightness,
	oklchColor,
	parseKey,
	parseTerminalColorSchemeReport,
	renderFakeCursor,
	renderImage,
	renderLatex,
	replaceControlCharacters,
	rgbColor,
	ScrollView,
	SelectList,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	styleText,
	styleTextWithAnsi,
	Text,
	TruncatedText,
	TUI_KEYBINDINGS,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
export { getSuggestions } from "./autocomplete.ts";
export {
	detectCapabilities,
	getCapabilities,
	getCellDimensions,
	getTerminalColorMode,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
} from "./capabilities.ts";
export { type Clipboard, nativeClipboard } from "./clipboard.ts";
export { parseColor } from "./colors.ts";
export { AutocompleteError, ClipboardError, InvalidColor, TuiError } from "./errors.ts";
export { type EventKey, type EventOf, events } from "./events.ts";
export { allocateImageId, setImageTranscoder } from "./images.ts";
export { getKeybindings, setKeybindings } from "./keybindings.ts";
export { isKittyProtocolActive, setKittyProtocolActive } from "./kitty-protocol.ts";
export { cancellableLoader, type LoaderArgs, loader, untilCancelled } from "./loader.ts";
export { SettingsListEvent, type SettingsListOf, settingsList } from "./settings-list.ts";
export { InputSequence, splitInput } from "./split-input.ts";
export * as Tui from "./tui.ts";
export { isAppleTerminalSession } from "./tui-terminal.ts";
