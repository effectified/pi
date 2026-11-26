import { readFileSync } from "node:fs";
import * as PiTui from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

const SET = "an Effect that sets pi-tui's process-wide value";
const READ = "an Effect that reads pi-tui's process-wide value";

/** What this package does with every value pi-tui's root exports. pi-tui has no subpaths. */
const COVERAGE = {
	// Markdown's lexer, and the autocomplete provider an `Editor` takes (`getSuggestions` asks it as an Effect).
	Marked: offered,
	CombinedAutocompleteProvider: offered,
	// Colors.
	backgroundAnsi: offered,
	colorToHex: offered,
	colorToOkhsl: offered,
	colorToOklch: offered,
	colorToRgb: offered,
	foregroundAnsi: offered,
	indexedColor: offered,
	mixColors: offered,
	okhslColor: offered,
	oklchColor: offered,
	rgbColor: offered,
	styleText: offered,
	styleTextWithAnsi: offered,
	oklabToOkhslLightness: offered,
	parseColor: replaced("parseColor: an Effect that fails with InvalidColor where pi-tui throws"),
	// Components: plain objects, rendered synchronously. Their callback properties are Streams through `events`.
	Box: offered,
	Container: offered,
	Editor: offered,
	HStack: offered,
	Image: offered,
	Input: offered,
	Markdown: offered,
	MouseRegion: offered,
	ScrollView: offered,
	SelectList: offered,
	Spacer: offered,
	Text: offered,
	TruncatedText: offered,
	VStack: offered,
	Loader: replaced("loader: a scoped Effect, the Loader made for the Tui service and stopped when the scope closes"),
	CancellableLoader: replaced(
		"cancellableLoader: a scoped Effect like loader; untilCancelled interrupts work when the user cancels",
	),
	SettingsList: replaced(
		"settingsList: a scoped Effect giving pi-tui's SettingsList and its change and cancel callbacks as a Stream",
	),
	setImageTranscoder: replaced(`setImageTranscoder: ${SET}`),
	// Fuzzy matching.
	fuzzyFilter: offered,
	fuzzyMatch: offered,
	// Keybindings: definitions and the manager are data; the process-wide manager is read and set by Effects.
	KeybindingsManager: offered,
	TUI_KEYBINDINGS: offered,
	getSelectPageIndex: offered,
	getKeybindings: replaced(`getKeybindings: ${READ}`),
	setKeybindings: replaced(`setKeybindings: ${SET}`),
	// Keys: decoders of input sequences.
	Key: offered,
	decodeKittyPrintable: offered,
	isKeyRelease: offered,
	isKeyRepeat: offered,
	matchesKey: offered,
	parseKey: offered,
	isKittyProtocolActive: replaced(`isKittyProtocolActive: ${READ}`),
	setKittyProtocolActive: replaced(`setKittyProtocolActive: ${SET}`),
	// LaTeX, program status, terminal reports.
	renderLatex: offered,
	formatProgramStatus: offered,
	parseTerminalColorSchemeReport: offered,
	// The native clipboard, input buffering, the terminal and the TUIs.
	getNativeClipboard: replaced("nativeClipboard: an Effect of the helper, whose transfers are Effects"),
	StdinBuffer: replaced("splitInput: a Stream of whole input sequences from a Stream of raw chunks"),
	ProcessTerminal: replaced("Tui.regular and Tui.fullscreen: the terminal a TUI starts on unless given another"),
	isAppleTerminalSession: replaced("isAppleTerminalSession: an Effect, since it reads the process's environment"),
	TuiMainScreen: replaced("Tui.regular and Tui.layer: a started TUI, stopped when the scope closes"),
	TuiAltScreen: replaced("Tui.fullscreen and Tui.layer: a started TUI, stopped when the scope closes"),
	// Terminal images: encoding is pure; what the terminal can show and its cell size are process-wide values.
	calculateImageRows: offered,
	deleteAllKittyImages: offered,
	deleteKittyImage: offered,
	encodeITerm2: offered,
	encodeKitty: offered,
	getGifDimensions: offered,
	getImageDimensions: offered,
	getJpegDimensions: offered,
	getPngDimensions: offered,
	getWebpDimensions: offered,
	hyperlink: offered,
	imageFallback: offered,
	renderImage: offered,
	allocateImageId: replaced("allocateImageId: an Effect, since each id is random"),
	detectCapabilities: replaced("detectCapabilities: an Effect, since it reads the environment and may ask tmux"),
	getCapabilities: replaced(`getCapabilities: ${READ}`),
	getCellDimensions: replaced(`getCellDimensions: ${READ}`),
	getTerminalColorMode: replaced(`getTerminalColorMode: ${READ} when given no capabilities`),
	resetCapabilitiesCache: replaced(`resetCapabilitiesCache: ${SET}`),
	setCapabilities: replaced(`setCapabilities: ${SET}`),
	setCapabilityOverrides: replaced(`setCapabilityOverrides: ${SET}`),
	setCellDimensions: replaced(`setCellDimensions: ${SET}`),
	// The renderer's pure helpers.
	CURSOR_MARKER: offered,
	compositeTuiLine: offered,
	isFocusable: offered,
	isViewportTUI: offered,
	renderFakeCursor: offered,
	// Text width, slicing and wrapping.
	getOsc8LinkAtColumn: offered,
	replaceControlCharacters: offered,
	sliceByColumn: offered,
	stripTerminalSequences: offered,
	truncateToWidth: offered,
	visibleWidth: offered,
	wrapTextWithAnsi: offered,
} satisfies Record<keyof typeof PiTui, Coverage>;

describe("the coverage of pi-tui", () => {
	it("records every value pi-tui's root exports", () => {
		expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(PiTui).sort());
	});

	it("offers every value it records as offered, pi-tui's own and not copies", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiTui;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("exports no value it records as replaced under pi-tui's name unless it is the Effect form", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiTui;
		const same = Object.entries(COVERAGE)
			.filter(
				([name, coverage]) => coverage.kind === "replaced" && ours[name] !== undefined && ours[name] === pi[name],
			)
			.map(([name]) => name);
		expect(same).toEqual([]);
	});

	it("leaves nothing open", () => {
		expect(Object.values(COVERAGE).filter((coverage) => coverage.kind === "open")).toEqual([]);
	});

	it("has no subpath of pi-tui to record: pi-tui exports only its root", () => {
		// Trust boundary: a manifest is a file, read as untyped JSON.
		const manifest: { exports?: unknown } = JSON.parse(
			readFileSync(new URL("../../tui/package.json", import.meta.url), "utf8"),
		);
		expect(manifest.exports).toBeUndefined();
	});
});
