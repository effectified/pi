// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the package, this file its sources), and what the README leaves to the reader
// (`theme`, `list`, `userConfig`, `search`, `dim`, `terminal`) is made here, with a test terminal for the real one.

import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	CombinedAutocompleteProvider,
	cancellableLoader,
	Editor,
	events,
	getKeybindings,
	getSuggestions,
	KeybindingsManager,
	type KeybindingsManager as Manager,
	nativeClipboard,
	parseColor,
	rgbColor,
	SelectList,
	setKeybindings,
	splitInput,
	Text,
	TUI_KEYBINDINGS,
	Tui,
	untilCancelled,
} from "../src/index.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

const userConfig = { "app.quit": "ctrl+q" } as const;
// README: presses. A declaration of a module is made at the top of a file: the example is here, and run below.
declare module "@effectified/pi-tui" {
	interface Keybindings {
		"app.quit": true;
	}
}

// userConfig: the user's own keys, such as { "app.quit": "ctrl+q" }, from the program's settings.
const quit = Effect.gen(function* () {
	yield* setKeybindings(
		new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, "app.quit": { defaultKeys: "ctrl+x", description: "Quit" } },
			userConfig,
		),
	);
	yield* Stream.runHead(Tui.presses(["app.quit"]));
});

const plain = (text: string): string => text;
const theme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

let defaults: Manager | undefined;
afterEach(async () => {
	if (defaults !== undefined) await run(setKeybindings(defaults));
});

describe("README: A running TUI", () => {
	it("gives the first text the user submits in the editor", async () => {
		const terminal = new TestTerminal(40, 6);
		// README: program.
		// theme: the Editor's colors (an EditorTheme).
		const program = Effect.gen(function* () {
			const tui = yield* Tui.Tui;
			const editor = new Editor(tui, theme);
			tui.addChild(new Text("Say something, then press Enter."));
			tui.addChild(editor);
			yield* Tui.setFocus(editor);
			yield* Tui.requestRender();
			// The first text the user submits.
			return yield* Stream.runHead(events(editor, "onSubmit"));
		});

		const said = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(program, { startImmediately: true });
				for (const key of ["h", "i", "\r"]) terminal.sendInput(key);
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(said).toEqual(Option.some("hi"));
	});

	it("shows an overlay until its scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const item = { value: "a", label: "A" };
		const list = new SelectList([item], 5, theme.selectList);
		// README: overlay.
		// list: a SelectList. Hidden, and focus given back, when the scope closes.
		const pick = Effect.scoped(
			Effect.gen(function* () {
				yield* Tui.showOverlay(list, { width: "50%", anchor: "center" });
				yield* Tui.requestRender();
				return yield* Stream.runHead(events(list, "onSelect"));
			}),
		);

		const picked = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(pick, { startImmediately: true });
				terminal.sendInput("\r");
				const chosen = yield* Fiber.join(fiber);
				return { chosen, shown: (yield* Tui.Tui).hasOverlay() };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(picked).toEqual({ chosen: Option.some(item), shown: false });
	});
});

describe("README: Input as Streams", () => {
	it("ends at the user's own key for the program's keybinding", async () => {
		defaults = await run(getKeybindings);
		const terminal = new TestTerminal(40, 6);
		const exit = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(quit, { startImmediately: true });
				// Ctrl+X, the default the user's configuration replaced, then Ctrl+Q.
				terminal.sendInput("\x18");
				const early = fiber.pollUnsafe();
				terminal.sendInput("\x11");
				return { early, done: yield* Fiber.await(fiber) };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(exit.early).toBeUndefined();
		expect(Exit.isSuccess(exit.done)).toBe(true);
	});

	it("splits raw input into whole sequences", async () => {
		// README: splitInput.
		// An arrow key cut in two, two letters in one chunk, and a bracketed paste.
		const sequences = Stream.runCollect(splitInput(Stream.make("\x1b[", "Aab", "\x1b[200~pasted\x1b[201~")));
		// [{ kind: "data", sequence: "\x1b[A" }, { kind: "data", sequence: "a" }, { kind: "data", sequence: "b" },
		//  { kind: "paste", content: "pasted" }]

		expect(await run(sequences)).toEqual([
			{ kind: "data", sequence: "\x1b[A" },
			{ kind: "data", sequence: "a" },
			{ kind: "data", sequence: "b" },
			{ kind: "paste", content: "pasted" },
		]);
	});
});

describe("README: Components with timers and callbacks", () => {
	it("interrupts the search when the user cancels the spinner", async () => {
		const terminal = new TestTerminal(40, 6);
		const search = Effect.never;
		const dim = plain;
		// README: cancellableLoader.
		// search: the work, an Effect. dim: a style for the text.
		const searching = Effect.scoped(
			Effect.gen(function* () {
				const spinner = yield* cancellableLoader(dim, dim, "Searching...");
				(yield* Tui.Tui).addChild(spinner);
				yield* Tui.setFocus(spinner);
				return yield* search.pipe(untilCancelled(spinner));
			}),
		);

		const exit = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(searching, { startImmediately: true });
				terminal.sendInput("\x1b");
				return yield* Fiber.await(fiber);
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});

describe("README: Clipboard, autocomplete and colors", () => {
	it("asks for suggestions and parses a color; the clipboard read is only built", async () => {
		// README: clipboard.
		const pasted = Effect.gen(function* () {
			const clipboard = yield* nativeClipboard;
			return Option.isSome(clipboard) ? yield* clipboard.value.getText : undefined;
		});

		// Slash commands and paths after "@"; interrupting the fiber aborts a file search.
		const provider = new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd());
		const suggestions = getSuggestions(provider, ["/he"], 0, 3);

		// A theme's color: InvalidColor where pi-tui cannot parse it.
		const accent = parseColor("#ff8000");

		// `pasted` is not run: it would read this machine's clipboard.
		expect(Effect.isEffect(pasted)).toBe(true);
		const [found, color] = await run(Effect.all([suggestions, accent]));
		expect(found?.items.map((item) => item.value)).toEqual(["help"]);
		expect(color).toEqual(rgbColor(255, 128, 0));
	});
});

describe("README: Testing", () => {
	it("draws on a virtual terminal", async () => {
		const terminal = new TestTerminal(40, 6);
		// README: testing.
		// terminal: a virtual terminal (pi-tui's VirtualTerminal), 40 columns by 6 rows.
		const drawn = Effect.gen(function* () {
			(yield* Tui.Tui).addChild(new Text("hello", 0, 0));
			yield* Tui.render();
		}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal })));

		await run(drawn);
		expect(await run(terminal.screen)).toEqual(["hello"]);
	});
});
