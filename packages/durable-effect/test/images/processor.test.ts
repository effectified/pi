import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { Context, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { make } from "../../src/images/index.ts";
import { fromPi } from "../../src/images/processor.ts";

const LIMITS = { maxWidth: 100, maxHeight: 100, maxBytes: 1_000 };

class Encoder extends Context.Service<Encoder, { readonly mimeType: string }>()("test/Encoder") {}

describe("make", () => {
	it("is a processor whose prepare is an Effect with the services of its context, and Pi's form calls it", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const processor = yield* make((bytes, _mimeType, limits) =>
					Encoder.use(({ mimeType }) =>
						Effect.succeed(
							bytes.length > limits.maxBytes ? Option.none() : Option.some({ data: "AAAA", mimeType }),
						),
					),
				);
				return {
					fits: yield* processor.prepare(new Uint8Array(3), "image/png", LIMITS),
					tooLarge: yield* processor.prepare(new Uint8Array(2_000), "image/png", LIMITS),
					pi: yield* Effect.promise(() => processor.pi.prepare(new Uint8Array(3), "image/png", LIMITS)),
				};
			}).pipe(Effect.provide(Layer.succeed(Encoder, { mimeType: "image/webp" }))),
		);
		expect(seen).toEqual({
			fits: Option.some({ data: "AAAA", mimeType: "image/webp" }),
			tooLarge: Option.none(),
			pi: { data: "AAAA", mimeType: "image/webp" },
		});
	});
});

describe("a processor of Pi's", () => {
	it("fails with ImageFailed where Pi's processor rejects", async () => {
		const pi: ImageProcessor = { prepare: () => Promise.reject(new Error("worker died")) };
		const failure = await Effect.runPromise(Effect.flip(fromPi(pi).prepare(new Uint8Array(3), "image/png", LIMITS)));
		expect([failure._tag, failure.message]).toEqual(["ImageFailed", "worker died"]);
	});
});
