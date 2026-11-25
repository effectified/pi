import { compile } from "@earendil-works/pi-schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeUnknown, encode, toJsonSchema } from "../src/index.ts";

const Event = Schema.Struct({
	title: Schema.String,
	at: Schema.Date,
	tags: Schema.optional(Schema.Array(Schema.String)),
});

describe("decodeUnknown", () => {
	it("decodes the JSON form into the schema's type", async () => {
		const event = await Effect.runPromise(decodeUnknown(Event)({ title: "launch", at: "2026-11-24T00:00:00.000Z" }));
		expect(event.at).toBeInstanceOf(Date);
		expect(event.at.getUTCFullYear()).toBe(2026);
	});

	it("reports every issue with a JSON Pointer path", async () => {
		const error = await Effect.runPromise(
			Effect.flip(decodeUnknown(Event)({ title: 1, tags: ["a", 2], extra: true })),
		);
		expect(error._tag).toBe("SchemaDecodeError");
		expect(error.issues.map((issue) => issue.path).sort()).toEqual(["/at", "/extra", "/tags/1", "/title"]);
		expect(error.message).toContain("/title: ");
	});

	it("escapes JSON Pointer tokens", async () => {
		const Weird = Schema.Struct({ "a/b~c": Schema.String });
		const error = await Effect.runPromise(Effect.flip(decodeUnknown(Weird)({ "a/b~c": 1 })));
		expect(error.issues.map((issue) => issue.path)).toEqual(["/a~1b~0c"]);
	});

	it("keeps unknown properties out only when objects are closed", async () => {
		const open = await Effect.runPromise(
			decodeUnknown(Event, { onExcessProperty: "ignore" })({ title: "t", at: "2026-01-01T00:00:00.000Z", extra: 1 }),
		);
		expect(open).not.toHaveProperty("extra");
	});

	it("accepts exactly the values its JSON Schema accepts for the cases a model produces", async () => {
		const validator = compile(toJsonSchema(Event));
		const decode = decodeUnknown(Event);
		const cases: unknown[] = [
			{ title: "a", at: "2026-01-01T00:00:00.000Z" },
			{ title: "a", at: "2026-01-01T00:00:00.000Z", tags: [] },
			{ title: "a", at: "2026-01-01T00:00:00.000Z", tags: null },
			{ title: "a" },
			{ title: 1, at: "2026-01-01T00:00:00.000Z" },
			{ title: "a", at: "2026-01-01T00:00:00.000Z", tags: "x" },
			{ title: "a", at: "2026-01-01T00:00:00.000Z", more: 1 },
			"text",
			null,
		];
		for (const input of cases) {
			const decoded = await Effect.runPromise(Effect.result(decode(input)));
			expect(decoded._tag === "Success", JSON.stringify(input)).toBe(validator.check(input));
		}
	});
});

describe("encode", () => {
	it("is the inverse of decodeUnknown", async () => {
		const input = { title: "launch", at: "2026-11-24T00:00:00.000Z", tags: ["a"] };
		const event = await Effect.runPromise(decodeUnknown(Event)(input));
		expect(await Effect.runPromise(encode(Event)(event))).toEqual(input);
	});
});
