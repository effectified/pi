import * as PiOutput from "@earendil-works/chord/output";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/output.ts";

const offered: Coverage = { kind: "offered" };
const open = (why: string): Coverage => ({ kind: "open", why });

/** What `@effectified/pi-chord/output` does with every value Chord's `/output` exports. */
const COVERAGE = {
	boundOutput: offered,
	characterEnd: offered,
	OutputBuffer: offered,
	PROGRESS_BYTES_PER_SECOND: offered,
	sanitizeOutput: offered,
	utf8ByteLength: offered,
	Progress: open(
		"paces a promise-returning write on its own timers and reports errors to a callback; an Effect form would be a " +
			"Clock-driven writer of ours, which is behaviour, not a wrapper",
	),
} satisfies Record<keyof typeof PiOutput, Coverage>;

describe("the coverage of Chord's /output", () => {
	it("offers every value it records as offered, Chord's own", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiOutput;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("bounds a stream to the window a tool keeps", () => {
		const buffer = new Package.OutputBuffer({ maxBytes: 1_000, maxLines: 2, retain: "tail" });
		buffer.push("one\ntwo\nthree\n");
		expect(buffer.snapshot()).toMatchObject({ text: "two\nthree\n", droppedLines: 1 });
		expect(Package.utf8ByteLength("é")).toBe(2);
	});
});
