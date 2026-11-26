// `@effectified/pi-durable/images`: image processors in Effect terms, and Pi's on Photon (Rust compiled to
// WebAssembly) for any runtime that has Photon's WebAssembly at hand.

import { createPhotonImages } from "@earendil-works/pi-durable/images";
import { Effect } from "effect";
import { fromPi, type Processor } from "./processor.ts";

export type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
export { ImageFailed, make, type Processor } from "./processor.ts";

/** Photon's WebAssembly, as bytes or as a compiled module: what `photon` takes. */
export type PhotonWasm = Parameters<typeof createPhotonImages>[0];

/**
 * Pi's processor on Photon, from Photon's `photon_rs_bg.wasm` (`@effectified/pi-durable/images/node` reads it from the
 * installed package, `@effectified/pi-durable/images/cloudflare` imports it as a Workers module). Photon loads once
 * per process; later calls reuse the first `wasm`. The work runs on the calling thread: about a second and a half for
 * a 12-megapixel photo.
 */
export function photon(wasm: PhotonWasm): Effect.Effect<Processor> {
	return Effect.sync(() => fromPi(createPhotonImages(wasm)));
}
