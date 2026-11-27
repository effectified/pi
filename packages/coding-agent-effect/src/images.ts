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
export const convertToPng = Effect.fn("Images.convertToPng")(
	(
		base64Data: string,
		mimeType: string,
	): Effect.Effect<Awaited<ReturnType<typeof piConvertToPng>>, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => piConvertToPng(base64Data, mimeType), catch: fromPi }),
);

/** The image `inputBytes` resized to fit Pi's limits (or `options`'), or `null` when it cannot be read. */
// Written out: the declaration build cannot name Pi's `ImageResizeOptions`, which its package does not export.
export const resizeImage: (
	inputBytes: Uint8Array,
	mimeType: string,
	options?: Parameters<typeof piResizeImage>[2],
) => Effect.Effect<Awaited<ReturnType<typeof piResizeImage>>, CodingAgentFailure> = Effect.fn("Images.resizeImage")(
	(
		inputBytes: Uint8Array,
		mimeType: string,
		options?: Parameters<typeof piResizeImage>[2],
	): Effect.Effect<Awaited<ReturnType<typeof piResizeImage>>, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => piResizeImage(inputBytes, mimeType, options), catch: fromPi }),
);

/** The image type of the file at `filePath` from its first bytes, when a model can take it; else `null`. */
export const detectSupportedImageMimeTypeFromFile = Effect.fn("Images.detectSupportedImageMimeTypeFromFile")(
	(filePath: string): Effect.Effect<string | null, CodingAgentFailure> =>
		Effect.tryPromise({ try: () => piDetectSupportedImageMimeTypeFromFile(filePath), catch: fromPi }),
);
