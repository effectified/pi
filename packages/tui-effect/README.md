# @effectified/pi-tui

[`@earendil-works/pi-tui`](../tui/README.md) in Effect terms: the terminal UI's renderer, components, editor,
keybindings and input. For `effect` 4.1.

- **A running TUI is a scoped service.** `Tui.layer` starts pi-tui's renderer on a terminal and stops it when the
  Layer's scope closes, which hands the terminal back as it was. Renders, focus and overlays are Effects; an overlay
  is hidden when its scope closes.
- **Input is a Stream.** What the terminal sends, the presses of named keybindings, the terminal's color scheme and
  Ctrl+Z are Streams; so are a component's callbacks (`onSubmit`, `onSelect`, ...), and raw input split into whole
  key sequences.
- **Components stay pi-tui's own.** Text, boxes, the editor, lists, Markdown and images are plain objects you build
  and add as in pi-tui. The ones that hold a timer (the spinners) are scoped; the clipboard, autocomplete and color
  parsing are Effects that fail with tagged errors.

The package adds no behaviour of its own, and leaves nothing of pi-tui out: `test/index.test.ts` records, value by
value, what it offers as pi-tui has it and what it replaces with an Effect form.

## Installation

```bash
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-tui-0.1.0.tgz effect
```

## A running TUI

`Tui.layer` gives the `Tui` service: a TUI started on the terminal (by default this process's stdin and stdout),
stopped when the Layer's scope closes. Its value is pi-tui's own object, which components such as `Editor` take.

```typescript
import { Effect, Stream } from "effect";
import { Editor, events, Text, Tui } from "@effectified/pi-tui";

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
```

Run it with `Effect.provide(program, Tui.layer({ mode: "regular" }))`.

- **`Tui.layer({ mode })`** starts a TUI in the terminal's main screen and scrollback (`"regular"`) or on the
  alternate screen with a scrollable viewport (`"fullscreen"`). `terminal` gives it another terminal, `stop` the
  options pi-tui's `stop` gets (`preserveScreen` for a TUI that takes over). **`Tui.regular`** and
  **`Tui.fullscreen`** start one in the current scope and give the typed object (`TuiMainScreen`, `TuiAltScreen`).
- A fullscreen TUI's callbacks are Effects: `altScreen.openUrl`, `onRightClickPaste` and `copySelection` run in the
  TUI's scope with the Layer's services, and are interrupted when it closes.
- **`Tui.render(force?)`** draws a frame now; **`Tui.requestRender(force?)`** asks for one on the next tick, which is
  how a change made to a component is shown. **`Tui.setFocus`** gives keyboard focus.
- **`Tui.showOverlay(component, options?)`** shows a component above the content, focused, until the scope closes.
- **`Tui.queryColors(timeout)`** asks the terminal for its theme colors. **`Tui.setTitle`**,
  **`Tui.setProgramStatus`**, **`Tui.progress`** (a busy indicator until the scope closes) and **`Tui.drainInput`**
  reach the terminal.

```typescript
import { Effect, Stream } from "effect";
import { events, Tui } from "@effectified/pi-tui";

// list: a SelectList. Hidden, and focus given back, when the scope closes.
const pick = Effect.scoped(
	Effect.gen(function* () {
		yield* Tui.showOverlay(list, { width: "50%", anchor: "center" });
		yield* Tui.requestRender();
		return yield* Stream.runHead(events(list, "onSelect"));
	}),
);
```

## Input as Streams

**`Tui.presses(keybindings)`** gives the presses of named keybindings and takes those keys from the focused
component. Keys are matched against the keybindings pi-tui's components use, which a program sets from its users'
configuration with `setKeybindings`, so keys stay configurable. A program names its own keybindings by adding them
to `Keybindings`, without importing pi-tui:

```typescript
import { Effect, Stream } from "effect";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, Tui } from "@effectified/pi-tui";

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
```

- **`Tui.input`** gives every input sequence the TUI receives and leaves it to the focused component.
- **`Tui.colorSchemes`** gives the terminal's color scheme (`"dark"`, `"light"`) each time it reports a change.
- **`Tui.suspends`** gives Ctrl+Z (SIGTSTP) while it runs; meanwhile the signal does not suspend the process.
- **`events(component, "on...")`** gives each call of a component's callback: an `Editor`'s or an `Input`'s
  `onSubmit`, a `SelectList`'s `onSelect` and `onCancel`. One stream at a time listens to a callback.
- **`splitInput(chunks)`** splits raw terminal input into whole sequences, a key or a paste each, with pi-tui's
  `StdinBuffer`:

```typescript
import { Stream } from "effect";
import { splitInput } from "@effectified/pi-tui";

// An arrow key cut in two, two letters in one chunk, and a bracketed paste.
const sequences = Stream.runCollect(splitInput(Stream.make("\x1b[", "Aab", "\x1b[200~pasted\x1b[201~")));
// [{ kind: "data", sequence: "\x1b[A" }, { kind: "data", sequence: "a" }, { kind: "data", sequence: "b" },
//  { kind: "paste", content: "pasted" }]
```

## Components with timers and callbacks

pi-tui's spinners animate on a timer from the moment they are made: **`loader`** and **`cancellableLoader`** make
them for the `Tui` service and stop them when the scope closes. **`untilCancelled`** runs work that the user can
cancel through the loader (`tui.select.cancel`, Escape by default): the work is interrupted.

```typescript
import { Effect } from "effect";
import { cancellableLoader, Tui, untilCancelled } from "@effectified/pi-tui";

// search: the work, an Effect. dim: a style for the text.
const searching = Effect.scoped(
	Effect.gen(function* () {
		const spinner = yield* cancellableLoader(dim, dim, "Searching...");
		(yield* Tui.Tui).addChild(spinner);
		yield* Tui.setFocus(spinner);
		return yield* untilCancelled(spinner, search);
	}),
);
```

**`settingsList(items, maxVisible, theme)`** makes pi-tui's `SettingsList` and gives what the user does in it as a
Stream of `{ kind: "change", id, value }` and `{ kind: "cancel" }`, until the scope closes.

## Clipboard, autocomplete and colors

```typescript
import { Effect, Option } from "effect";
import { CombinedAutocompleteProvider, getSuggestions, nativeClipboard, parseColor } from "@effectified/pi-tui";

const pasted = Effect.gen(function* () {
	const clipboard = yield* nativeClipboard;
	return Option.isSome(clipboard) ? yield* clipboard.value.getText : undefined;
});

// Slash commands and paths after "@"; interrupting the fiber aborts a file search.
const provider = new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd());
const suggestions = getSuggestions(provider, ["/he"], 0, 3);

// A theme's color: InvalidColor where pi-tui cannot parse it.
const accent = parseColor("#ff8000");
```

- **`nativeClipboard`** is pi-tui's native helper of this platform, or none; its transfers fail with
  `ClipboardError`.
- **`getSuggestions(provider, lines, line, column)`** asks an autocomplete provider; it fails with
  `AutocompleteError`.
- **`parseColor`** fails with `InvalidColor`. `TuiError` is the union of the three.

## What the whole process shares

pi-tui keeps some state for the whole process: the keybindings its components read, what the terminal can show
(images, true color, hyperlinks), the size of a cell, the Kitty keyboard protocol flag and the image converter.
**`getKeybindings`**, **`setKeybindings`**, **`getCapabilities`**, **`setCapabilities`**,
**`setCapabilityOverrides`**, **`resetCapabilitiesCache`**, **`detectCapabilities`**, **`getTerminalColorMode`**,
**`getCellDimensions`**, **`setCellDimensions`**, **`isKittyProtocolActive`**, **`setKittyProtocolActive`**,
**`setImageTranscoder`** and **`allocateImageId`** read and set it as Effects.

Everything else pi-tui exports is offered as it is: its components (`Text`, `Box`, `Container`, `Editor`, `Input`,
`SelectList`, `Markdown`, `Image`, `ScrollView`, ...), its colors, key decoding (`matchesKey`, `Key`), keybinding
definitions (`TUI_KEYBINDINGS`, `KeybindingsManager`), fuzzy matching, LaTeX, image encoding and text width. Every
type of pi-tui is exported, so an application imports `@effectified/pi-tui` and never pi-tui.

## Testing

A test gives `Tui.layer` a terminal of its own, never a real TTY. pi-tui's tests use a virtual terminal on xterm.js
(`@xterm/headless`), which this package's tests use too: it shows what was drawn and sends keys.

```typescript
import { Effect } from "effect";
import { Text, Tui } from "@effectified/pi-tui";

// terminal: a virtual terminal (pi-tui's VirtualTerminal), 40 columns by 6 rows.
const drawn = Effect.gen(function* () {
	(yield* Tui.Tui).addChild(new Text("hello", 0, 0));
	yield* Tui.render();
}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal })));
```

pi-tui's own timers (the render throttle, the spinners, input timeouts, the color query's timeout) are not Effect's
`Clock`: `TestClock` does not move them. `Tui.render` draws without waiting for one.
