// `@effectified/pi-durable/images/node`: Pi's Photon processor for Node and Bun, Photon's WebAssembly read from the
// installed package.

import { createNodePhotonImages, type NodePhotonImagesOptions } from "@earendil-works/pi-durable/images/node";
import { Effect, Predicate } from "effect";
import { fromPi, ImageFailed, type Processor } from "./processor.ts";

export type { NodePhotonImagesOptions } from "@earendil-works/pi-durable/images/node";

/**
 * Pi's Photon processor with Photon's WebAssembly read from the installed `@silvia-odwyer/photon`, by default in a
 * worker thread that keeps the process alive only while it prepares an image and exits after `idleMs` without one. A
 * worker that cannot start falls back to the calling thread. Fails with `ImageFailed` when the WebAssembly cannot be
 * read.
 */
export function nodePhoton(options?: NodePhotonImagesOptions): Effect.Effect<Processor, ImageFailed> {
	return Effect.map(
		Effect.tryPromise({
			try: () => createNodePhotonImages(options),
			catch: (cause) =>
				new ImageFailed({ message: Predicate.isError(cause) ? cause.message : String(cause), cause }),
		}),
		fromPi,
	);
}
