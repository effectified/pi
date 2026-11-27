import type { NativeClipboard } from "@earendil-works/pi-tui";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { fromNative, nativeClipboard } from "../src/clipboard.ts";
import { ClipboardError } from "../src/errors.ts";
import { run } from "./run.ts";

/** A clipboard helper of the shape pi-tui's native modules have: it holds one text, and its image read breaks. */
function helper(text: string | null): NativeClipboard & { readonly written: string[] } {
	const written: string[] = [];
	return {
		written,
		getText: async () => text,
		getImage: async () => {
			throw new Error("transfer failed");
		},
		setText: async (value) => {
			written.push(value);
		},
	};
}

describe("nativeClipboard", () => {
	it("is pi-tui's helper for this platform, or none", async () => {
		const clipboard = await run(nativeClipboard);
		// The helper depends on the machine (a prebuilt module, a display on Linux); the test reads no clipboard.
		const headless = process.platform === "linux" && process.env.DISPLAY === undefined;
		expect(headless ? Option.isNone(clipboard) : Option.isOption(clipboard)).toBe(true);
	});
});

describe("fromNative", () => {
	it("gives the helper's results, and its rejections as ClipboardError of the transfer", async () => {
		const native = helper("copied");
		const seen = await run(
			Effect.gen(function* () {
				const clipboard = fromNative(native);
				const text = yield* clipboard.getText;
				const image = yield* Effect.flip(clipboard.getImage);
				yield* clipboard.setText?.("pasted") ?? Effect.void;
				return { text, image, files: yield* clipboard.getFilePaths };
			}),
		);
		expect(seen.text).toBe("copied");
		expect(seen.image).toBeInstanceOf(ClipboardError);
		expect([seen.image.operation, seen.image.message]).toEqual(["getImage", "transfer failed"]);
		// A helper without file paths does not support them: `undefined`, as pi-tui documents.
		expect(seen.files).toBeUndefined();
		expect(native.written).toEqual(["pasted"]);
	});

	it("has no setText where the helper has none", () => {
		const { setText: _, ...readOnly } = helper(null);
		expect(fromNative(readOnly).setText).toBeUndefined();
	});
});
