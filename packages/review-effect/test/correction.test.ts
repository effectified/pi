import { describe, expect, it } from "vitest";
import { Correction } from "../src/index.ts";

describe("Correction.standard", () => {
	const blocking = [
		{ check: "review.model", severity: "block" as const, text: "The date is wrong.", location: "in 1999" },
		{ check: "review.citations", severity: "block" as const, text: "The citation does not resolve." },
	];

	it("numbers the blocking findings, with their locations, and ends with the instruction", () => {
		expect(Correction.standard({ pass: 1, blocking, remarks: [] })).toBe(
			[
				"A review of your answer found problems that must be fixed:",
				"1. [block] The date is wrong. (at: in 1999)",
				"2. [block] The citation does not resolve.",
				"Correct your answer and give it again in full.",
			].join("\n"),
		);
	});

	it("lists the findings that do not block as remarks", () => {
		const remarks = [{ check: "review.model", severity: "info" as const, text: "Shorter would do." }];
		expect(Correction.standard({ pass: 2, blocking: blocking.slice(0, 1), remarks })).toBe(
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
	const request = {
		pass: 1,
		blocking: [{ check: "review.model", severity: "block" as const, text: "The date is wrong." }],
		remarks: [],
	};

	it("gives the product's text", () => {
		expect(Correction.write(({ pass, blocking }) => `${pass}: ${blocking.length} to fix`, request)).toBe(
			"1: 1 to fix",
		);
	});

	it("gives this package's text when the product's writer throws", () => {
		const broken: Correction.Writer = () => {
			throw new Error("no template");
		};
		expect(Correction.write(broken, request)).toBe(Correction.standard(request));
	});
});
