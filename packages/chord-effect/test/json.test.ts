import * as PiJson from "@earendil-works/chord/json";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/json.ts";
import { copyJson, isJsonValue, NotJson } from "../src/json.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/json` does with every value Chord's `/json` exports. */
const COVERAGE = {
	isJsonValue: offered,
	copyJson: replaced("copyJson: an Effect that fails with NotJson where Chord throws"),
} satisfies Record<keyof typeof PiJson, Coverage>;

describe("the coverage of Chord's /json", () => {
	it("offers every value it records as offered, Chord's own", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiJson;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});
});

describe("copyJson", () => {
	it("copies strict JSON into a tree of its own, with Chord's options", async () => {
		const value = { title: "Report", tags: ["a"], note: undefined };
		const copy = await Effect.runPromise(copyJson(value, { omitUndefinedProperties: true }));
		expect(copy).toEqual({ title: "Report", tags: ["a"] });
		expect(copy).not.toBe(value);
		expect(isJsonValue(copy)).toBe(true);
	});

	it("fails with NotJson where Chord throws, naming what is not JSON", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const failures = await Effect.runPromise(
			Effect.all([Number.NaN, cyclic, new Date(0), { at: undefined }].map((value) => Effect.flip(copyJson(value)))),
		);
		expect(failures.every((failure) => failure instanceof NotJson)).toBe(true);
		expect(failures.map((failure) => failure.message)).toEqual([
			"Value contains a non-finite number and is not strict JSON",
			"Value contains cycles and is not strict JSON",
			"Value must contain strict JSON plain objects or arrays",
			"Value contains a non-JSON undefined; expected strict JSON",
		]);
	});
});
