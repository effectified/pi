import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Reported, reported } from "../src/reported.ts";

describe("Reported", () => {
	const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Reported));
	const encode = Schema.encodeSync(Schema.toCodecJson(Reported));

	it("keeps a finite number as reported, a fraction included, and writes it back as it was", () => {
		expect([decode(12), decode(1.5), decode(-3)]).toEqual([12, 1.5, -3]);
		expect(encode(1.5)).toBe(1.5);
	});

	it("reads a non-finite number a record stored before 0.3.0 kept as a string as 0", () => {
		expect([decode("NaN"), decode("Infinity"), decode("-Infinity")]).toEqual([0, 0, 0]);
	});

	it("refuses any other string", () => {
		expect(() => decode("12")).toThrow();
	});
});

describe("reported", () => {
	it("is a finite number itself, and 0 for one that is not", () => {
		expect([reported(7), reported(0.25), reported(Number.NaN), reported(Number.POSITIVE_INFINITY)]).toEqual([
			7, 0.25, 0, 0,
		]);
	});
});
