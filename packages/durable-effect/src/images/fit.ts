// `@effectified/pi-durable/images/fit`: images entering a conversation, fitted to its model's limits by a processor
// before they are stored, so the transcript (and the provider's prompt cache) never changes later.

import {
	createFitImagesExtension,
	fitImage as piFitImage,
	fitImages as piFitImages,
} from "@earendil-works/pi-durable/images/fit";
import type { ImageLimits } from "@earendil-works/pi-durable/tools";
import type { ImageContent, TextContent } from "@effectified/pi-ai";
import { Effect } from "effect";
import { extension as fromPi, type PiMade } from "../pi-made.ts";
import type { Processor } from "./processor.ts";

export type { FittedImage, FittedImages } from "@earendil-works/pi-durable/images/fit";

/**
 * The image in `bytes`, declared as `mimeType`, prepared by `processor` to fit `limits`, with notes for the model on
 * what changed; or left out with a note when the processor cannot prepare it or fails. Its type is read from its
 * bytes. It never fails: an image that cannot be fitted is the outcome `omitted`.
 */
export function fitImage(
	bytes: Uint8Array,
	mimeType: string,
	limits: ImageLimits,
	processor: Processor,
): Effect.Effect<Awaited<ReturnType<typeof piFitImage>>> {
	return Effect.promise(() => piFitImage(bytes, mimeType, limits, processor.pi));
}

/** `content` with each image fitted by `fitImage`; text stays where it is. `unchanged` when every image came back as it was. */
export function fitImages(
	content: ReadonlyArray<TextContent | ImageContent>,
	limits: ImageLimits,
	processor: Processor,
): Effect.Effect<Awaited<ReturnType<typeof piFitImages>>> {
	return Effect.promise(() => piFitImages(content, limits, processor.pi));
}

/**
 * The `fit-images` extension: an `afterTool` hook that fits the images of every result the model gets to the
 * conversation model's current limits before it is committed, whichever tool made them, and says what changed in an
 * `info` diagnostic (code `image`). Install it after the extensions whose hooks must see the images unfitted.
 */
export function extension(processor: Processor): PiMade {
	return fromPi(createFitImagesExtension(processor.pi));
}
