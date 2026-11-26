import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { extension, fitImage, fitImages } from "../../src/images/fit.ts";
import { make } from "../../src/images/index.ts";
import { Extension, Tool } from "../../src/index.ts";
import { answer, TestHarness, toolCall } from "../../src/testing/index.ts";
import { png } from "./png.ts";

const LIMITS = { maxWidth: 10, maxHeight: 10, maxBytes: 100_000 };

/** A processor that turns every image into the same small JPEG, saying it resized it. */
const shrinking = make((_bytes, _mimeType, limits) =>
	Effect.succeed(
		Option.some({
			data: "c21hbGw=",
			mimeType: "image/jpeg",
			resized: { from: { width: 40, height: 40 }, to: { width: limits.maxWidth, height: limits.maxHeight } },
		}),
	),
);

/** A processor that cannot prepare anything. */
const refusing = make(() => Effect.succeedNone);

describe("fitImage", () => {
	it("is the prepared image with notes, or the image left out with a note", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const fitted = yield* fitImage(png(40, 40), "image/png", LIMITS, yield* shrinking);
				const omitted = yield* fitImage(png(40, 40), "image/png", LIMITS, yield* refusing);
				return { fitted, omitted };
			}),
		);
		expect(seen.fitted).toMatchObject({ kind: "fitted", image: { type: "image", mimeType: "image/jpeg" } });
		expect(seen.omitted).toMatchObject({ kind: "omitted" });
	});
});

describe("fitImages", () => {
	it("fits the images of content and keeps its text in place; unchanged when nothing changed", async () => {
		const image = {
			type: "image" as const,
			data: Buffer.from(png(40, 40)).toString("base64"),
			mimeType: "image/png",
		};
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const processor = yield* shrinking;
				return {
					fitted: yield* fitImages([{ type: "text", text: "Look." }, image], LIMITS, processor),
					text: yield* fitImages([{ type: "text", text: "Only text." }], LIMITS, processor),
				};
			}),
		);
		expect(seen.fitted).toMatchObject({
			kind: "fitted",
			content: [
				{ type: "text", text: "Look." },
				{ type: "image", mimeType: "image/jpeg" },
			],
		});
		expect(seen.text).toEqual({ kind: "unchanged" });
	});
});

describe("extension", () => {
	it("fits the images of a tool's result before it is committed, with an info diagnostic", async () => {
		const Snapshot = Tool.make("snapshot", {
			description: "Take a picture.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () =>
				Effect.succeed(
					Tool.result("taken", {
						output: [{ type: "image", data: Buffer.from(png(40, 40)).toString("base64"), mimeType: "image/png" }],
					}),
				),
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const processor = yield* shrinking;
				return yield* Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt("Take one.");
					const entries = yield* root.context();
					return entries.entries.find((entry) => entry.kind === "pi.tool-result");
				}).pipe(
					Effect.provide(
						TestHarness.layer({
							extensions: [Extension.make({ name: "app", tools: [Snapshot] }), extension(processor)],
							responses: [toolCall("snapshot", {}), answer("Done.")],
						}),
					),
				);
			}),
		);
		// The image is fitted; Pi appends the diagnostics block after it.
		expect(result?.model?.[0]).toMatchObject({
			content: expect.arrayContaining([{ type: "image", data: "c21hbGw=", mimeType: "image/jpeg" }]),
		});
		expect(result?.data).toMatchObject({ diagnostics: [{ severity: "info", code: "image" }] });
	});
});
