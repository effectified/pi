// An image processor in Effect terms: what prepares images for a model (decodes, turns upright, scales, re-encodes).

import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import { Effect, Option, Predicate, Schema } from "effect";

/** A processor failed to prepare an image for another reason than that it cannot be decoded or made to fit. */
export class ImageFailed extends Schema.TaggedError<ImageFailed>()("ImageFailed", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** Prepares images to fit a model's limits. */
export interface Processor {
	/**
	 * The image in `bytes`, declared as `mimeType`, prepared to fit `limits`: none when it cannot be decoded or made to
	 * fit.
	 */
	readonly prepare: (
		bytes: Uint8Array,
		mimeType: string,
		limits: ImageLimits,
	) => Effect.Effect<Option.Option<PreparedImage>, ImageFailed>;
	/** Pi's processor, for what takes one as it is. */
	readonly pi: ImageProcessor;
}

/**
 * A processor of your own: `prepare` as an Effect, run with the services of the context this Effect runs in. A
 * failure of `prepare` reaches Pi as a processor's rejection, which Pi turns into an image left out with a note.
 */
export function make<E, R>(
	prepare: (
		bytes: Uint8Array,
		mimeType: string,
		limits: ImageLimits,
	) => Effect.Effect<Option.Option<PreparedImage>, E, R>,
): Effect.Effect<Processor, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.runPromiseWith(context);
		return fromPi({
			prepare: (bytes, mimeType, limits) => run(Effect.map(prepare(bytes, mimeType, limits), Option.getOrUndefined)),
		});
	});
}

/** Pi's processor in Effect terms. */
export function fromPi(pi: ImageProcessor): Processor {
	return {
		prepare: (bytes, mimeType, limits) =>
			Effect.map(
				Effect.tryPromise({
					try: () => pi.prepare(bytes, mimeType, limits),
					catch: (cause) =>
						new ImageFailed({ message: Predicate.isError(cause) ? cause.message : String(cause), cause }),
				}),
				Option.fromUndefinedOr,
			),
		pi,
	};
}
