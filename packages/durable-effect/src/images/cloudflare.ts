// `@effectified/pi-durable/images/cloudflare`: Pi's Photon processor for Cloudflare Workers and Durable Objects, built
// with Wrangler, whose default `CompiledWasm` rule turns Photon's WebAssembly import into a module.

import { createCloudflarePhotonImages } from "@earendil-works/pi-durable/images/cloudflare";
import { Effect } from "effect";
import { fromPi, type Processor } from "./processor.ts";

/** Pi's Photon processor on the WebAssembly module Wrangler bundled. */
export const cloudflarePhoton: Effect.Effect<Processor> = Effect.sync(() => fromPi(createCloudflarePhotonImages()));
