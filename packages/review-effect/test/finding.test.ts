import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { blocks, Finding, Severity } from "../src/index.ts";

describe("blocks", () => {
	it("blocks from the lowest blocking severity upwards", () => {
		const table = Severity.literals.map((severity) => Severity.literals.map((from) => blocks(severity, from)));
		// Rows: info, warn, block. Columns: the policy blocks from info, from warn, from block.
		expect(table).toEqual([
			[true, false, false],
			[true, true, false],
			[true, true, true],
		]);
	});

	it("pipes: data-last with the lowest blocking severity", () => {
		expect(Severity.literals.map(blocks("warn"))).toEqual([false, true, true]);
	});
});

describe("Finding", () => {
	const decode = Schema.decodeUnknownSync(Finding);

	it("decodes a finding with and without a location", () => {
		expect(decode({ severity: "warn", text: "Too long." })).toEqual({ severity: "warn", text: "Too long." });
		expect(decode({ severity: "block", text: "Wrong.", location: "line 2" })).toEqual({
			severity: "block",
			text: "Wrong.",
			location: "line 2",
		});
	});

	it("refuses a severity it does not know", () => {
		expect(() => decode({ severity: "fatal", text: "Wrong." })).toThrow(/severity/);
	});
});
