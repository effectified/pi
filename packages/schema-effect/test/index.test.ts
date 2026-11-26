import * as PiSchema from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });
const VALIDATOR = replaced("validator: pi-schema's validators throw, it fails with SchemaDecodeError");

/** What this package does with every value pi-schema exports: its builders as they are, its validators replaced. */
const COVERAGE = {
	arr: offered,
	bigint: offered,
	bool: offered,
	bytes: offered,
	equal: offered,
	int: offered,
	lit: offered,
	map: offered,
	nul: offered,
	nullable: offered,
	num: offered,
	Optional: offered,
	obj: offered,
	oneOf: offered,
	opt: offered,
	recursive: offered,
	str: offered,
	tuple: offered,
	union: offered,
	unknown: offered,
	unsafe: offered,
	compile: VALIDATOR,
	CoercingValidator: VALIDATOR,
	Validator: VALIDATOR,
} satisfies Record<keyof typeof PiSchema, Coverage>;

describe("the coverage of pi-schema", () => {
	it("offers every value it records as offered, so the record stays true", () => {
		const ours = new Set(Object.keys(Package));
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !ours.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});

	it("offers pi-schema's own builders, not copies", () => {
		expect(Package.obj).toBe(PiSchema.obj);
		expect(Package.str({ minLength: 1 })).toEqual(PiSchema.str({ minLength: 1 }));
	});
});
