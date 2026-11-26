import * as PiCompression from "@earendil-works/chord/compression";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../../effect/conformance.ts";
import * as Package from "../../src/node/compression.ts";

const offered: Coverage = { kind: "offered" };

/** What `@effectified/pi-chord/compression` does with every value Chord's `/compression` exports. */
const COVERAGE = { nodeCompression: offered } satisfies Record<keyof typeof PiCompression, Coverage>;

describe("the coverage of Chord's /compression", () => {
	it("offers Chord's own compressor", () => {
		expect(Object.keys(COVERAGE)).toEqual(["nodeCompression"]);
		expect(Package.nodeCompression).toBe(PiCompression.nodeCompression);
	});

	it("deflates and inflates within a limit", () => {
		const bytes = new TextEncoder().encode("chord ".repeat(100));
		const inflated = Package.nodeCompression.inflate(Package.nodeCompression.deflate(bytes), bytes.byteLength);
		expect(inflated).toEqual({ kind: "bytes", bytes: expect.any(Uint8Array) });
		expect(Package.nodeCompression.inflate(Package.nodeCompression.deflate(bytes), 10)).toEqual({
			kind: "too_large",
		});
	});
});
