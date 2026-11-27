// The system clipboard through pi-tui's native helper, its transfers as Effects that fail with `ClipboardError`.

import { getNativeClipboard, type NativeClipboard } from "@earendil-works/pi-tui";
import { Effect, Option } from "effect";
import { ClipboardError } from "./errors.ts";

/**
 * pi-tui's native clipboard with Effects for its promises. Each transfer fails with `ClipboardError` where pi-tui's
 * helper rejects. The helper takes no signal: an interrupted transfer finishes in the background.
 */
export interface Clipboard {
	/** The clipboard's text: `null` when it holds none, `undefined` when the clipboard is unavailable. */
	readonly getText: Effect.Effect<Awaited<ReturnType<NativeClipboard["getText"]>>, ClipboardError>;
	/** The clipboard's image as encoded bytes: `null` when it holds none, `undefined` when unavailable. */
	readonly getImage: Effect.Effect<Awaited<ReturnType<NativeClipboard["getImage"]>>, ClipboardError>;
	/** The POSIX paths of the files on the clipboard: `null` when it holds none, `undefined` where unsupported. */
	readonly getFilePaths: Effect.Effect<
		Awaited<ReturnType<NonNullable<NativeClipboard["getFilePaths"]>>>,
		ClipboardError
	>;
	/** Puts `text` on the clipboard. Absent on Linux, where pi-tui's helper does not write. */
	readonly setText?: (text: string) => Effect.Effect<void, ClipboardError>;
}

/**
 * The native clipboard of this platform, or none: pi-tui has a helper for macOS and Windows, and for Linux when a
 * display is set (`DISPLAY`). Loading the helper opens no display; the first transfer does.
 */
export const nativeClipboard: Effect.Effect<Option.Option<Clipboard>> = Effect.sync(() =>
	Option.map(Option.fromUndefinedOr(getNativeClipboard()), fromNative),
);

/** `native` with its promises as Effects: what `nativeClipboard` gives for pi-tui's helper. */
export function fromNative(native: NativeClipboard): Clipboard {
	const { getFilePaths, setText } = native;
	return {
		getText: transfer("getText", () => native.getText()),
		getImage: transfer("getImage", () => native.getImage()),
		getFilePaths:
			getFilePaths === undefined ? Effect.undefined : transfer("getFilePaths", () => getFilePaths.call(native)),
		...(setText === undefined ? {} : { setText: (text) => transfer("setText", () => setText.call(native, text)) }),
	};
}

/** One transfer of the helper, in a span named for it: what it rejects with is a `ClipboardError` of `operation`. */
function transfer<A>(operation: ClipboardError["operation"], run: () => Promise<A>): Effect.Effect<A, ClipboardError> {
	return Effect.tryPromise({ try: run, catch: (cause) => ClipboardError.make({ operation, cause }) }).pipe(
		Effect.withSpan(`Tui.Clipboard.${operation}`),
	);
}
