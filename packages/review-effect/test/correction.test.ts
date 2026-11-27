import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Check, Correction, type Found } from "../src/index.ts";

const MODEL = Check.Name.make("review.model");
const DATE: Found = { check: MODEL, severity: "block", text: "The date is wrong.", location: "in 1999" };
const SOURCE: Found = {
	check: Check.Name.make("review.citations"),
	severity: "block",
	text: "The citation does not resolve.",
};

describe("Correction.standard", () => {
	it("numbers the blocking findings, with their locations, and ends with the instruction", () => {
		expect(Correction.standard({ pass: 1, blocking: [DATE, SOURCE], remarks: [] })).toBe(
			[
				"A review of your answer found problems that must be fixed:",
				"1. [block] The date is wrong. (at: in 1999)",
				"2. [block] The citation does not resolve.",
				"Correct your answer and give it again in full.",
			].join("\n"),
		);
	});

	it("lists the findings that do not block as remarks", () => {
		const remarks: ReadonlyArray<Found> = [{ check: MODEL, severity: "info", text: "Shorter would do." }];
		expect(Correction.standard({ pass: 2, blocking: [DATE], remarks })).toBe(
			[
				"A review of your answer found problems that must be fixed:",
				"1. [block] The date is wrong. (at: in 1999)",
				"Other remarks:",
				"- [info] Shorter would do.",
				"Correct your answer and give it again in full.",
			].join("\n"),
		);
	});
});

describe("Correction.write", () => {
	const request: Correction.Request = {
		pass: 1,
		blocking: [{ check: MODEL, severity: "block", text: "The date is wrong." }],
		remarks: [],
	};

	it("gives the product's text, data-first or data-last", () => {
		const writer: Correction.Writer = ({ pass, blocking }) => `${pass}: ${blocking.length} to fix`;
		expect([Correction.write(writer, request), Correction.write(request)(writer)]).toEqual([
			"1: 1 to fix",
			"1: 1 to fix",
		]);
	});

	it("gives this package's text when the product's writer throws", () => {
		const broken: Correction.Writer = () => {
			throw new Error("no template");
		};
		expect(Correction.write(broken, request)).toBe(Correction.standard(request));
	});
});

describe("Correction.Request", () => {
	it("refuses a request without a blocking finding: a correction always has one", () => {
		expect(() => Schema.decodeUnknownSync(Correction.Request)({ pass: 1, blocking: [], remarks: [] })).toThrow(
			/blocking/,
		);
	});
});
