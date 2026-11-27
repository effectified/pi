// What pi-tui's images need that is not pure: the converter to PNG it renders with, and fresh Kitty image ids.

import {
	type ImageTranscoder,
	allocateImageId as piAllocateImageId,
	setImageTranscoder as piSetImageTranscoder,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";

/**
 * Sets the converter `Image` uses for non-PNG images on terminals of the Kitty protocol, which take only PNG, for the
 * whole process; `undefined` removes it, and such images render as text. pi-tui calls it while rendering: it must be
 * synchronous, and return the PNG's base64 data or `null` when it cannot convert.
 */
export const setImageTranscoder = Effect.fn("Tui.setImageTranscoder")((transcoder: ImageTranscoder | undefined) =>
	Effect.sync(() => piSetImageTranscoder(transcoder)),
);

/** A fresh random Kitty image id, for an `Image` that is replaced in place (`ImageOptions.imageId`). */
export const allocateImageId: Effect.Effect<number> = Effect.sync(piAllocateImageId);
