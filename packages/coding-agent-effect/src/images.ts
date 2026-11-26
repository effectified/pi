// pi-coding-agent's image helpers in Effect: converting, resizing and recognizing the images a session sends to a
// model, as Effects.

import {
	convertToPng as piConvertToPng,
	detectSupportedImageMimeTypeFromFile as piDetectSupportedImageMimeTypeFromFile,
	resizeImage as piResizeImage,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** The image `base64Data` of type `mimeType` as PNG, or `undefined` when Pi cannot convert it. */
export function convertToPng(
	base64Data: string,
	mimeType: string,
): Effect.Effect<Awaited<ReturnType<typeof piConvertToPng>>, CodingAgentFailure> {
	return Effect.tryPromise({ try: () => piConvertToPng(base64Data, mimeType), catch: fromPi });
}

/** The image `inputBytes` resized to fit Pi's limits (or `options`'), or `null` when it cannot be read. */
export function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: Parameters<typeof piResizeImage>[2],
): Effect.Effect<Awaited<ReturnType<typeof piResizeImage>>, CodingAgentFailure> {
	return Effect.tryPromise({ try: () => piResizeImage(inputBytes, mimeType, options), catch: fromPi });
}

/** The image type of the file at `filePath` from its first bytes, when a model can take it; else `null`. */
export function detectSupportedImageMimeTypeFromFile(
	filePath: string,
): Effect.Effect<string | null, CodingAgentFailure> {
	return Effect.tryPromise({ try: () => piDetectSupportedImageMimeTypeFromFile(filePath), catch: fromPi });
}
