import { compile } from "@earendil-works/pi-schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeUnknown, encode, toJsonSchema, validator } from "../src/index.ts";

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

describe("decodeUnknown against pi-schema", () => {
	const Item = Schema.Struct({ name: Schema.String, qty: Schema.Number });
	const Kind = Schema.Union([
		Schema.Struct({ kind: Schema.Literal("a"), n: Schema.Number }),
		Schema.Struct({ kind: Schema.Literal("b"), s: Schema.String }),
	]);
	/** A schema and a value it rejects, named for what the value exercises. */
	const corpus: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>, unknown]> = [
		["the value itself", Item, "text"],
		[
			"nested objects",
			Schema.Struct({ a: Schema.Struct({ b: Schema.Struct({ c: Schema.String }) }) }),
			{ a: { b: { c: 1 } } },
		],
		["missing keys", Schema.Struct({ a: Schema.Struct({ b: Schema.String, c: Schema.Number }) }), { a: { c: "x" } }],
		[
			"array items",
			Schema.Struct({ items: Schema.Array(Item) }),
			{ items: [{ name: "a", qty: 1 }, { name: 2, qty: "x" }, { qty: 3 }] },
		],
		["a tuple", Schema.Struct({ t: Schema.Tuple([Schema.String, Schema.Number]) }), { t: ["a", "b"] }],
		["record values", Schema.Struct({ r: Schema.Record(Schema.String, Schema.Number) }), { r: { a: 1, b: "x" } }],
		["a union of primitives", Schema.Struct({ v: Schema.Union([Schema.String, Schema.Number]) }), { v: true }],
		["a discriminated union", Schema.Struct({ v: Kind }), { v: { kind: "a", n: "x" } }],
		[
			"keys that need escaping",
			Schema.Struct({ "a/b": Schema.Struct({ "~c": Schema.Number }) }),
			{ "a/b": { "~c": "x" } },
		],
		["an excess key that needs escaping", Schema.Struct({ a: Schema.String }), { a: "x", "x/~y": 1 }],
	];

	it.each(corpus)("reports the paths pi-schema's validator reports for %s", async (_name, schema, value) => {
		const pi = await Effect.runPromise(
			Effect.flatMap(validator(toJsonSchema(schema)), (compiled) => Effect.flip(compiled.validate(value))),
		);
		const ours = await Effect.runPromise(Effect.flip(decodeUnknown(schema)(value)));
		expect(ours.issues.map((issue) => issue.path).sort()).toEqual(pi.issues.map((issue) => issue.path).sort());
	});

	it("reports the issues of every member of a union with no discriminator, pi-schema those of the closest one", async () => {
		const schema = Schema.Struct({
			v: Schema.Union([Schema.Struct({ x: Schema.Number }), Schema.Struct({ y: Schema.String })]),
		});
		const value = { v: { x: "x" } };
		const pi = await Effect.runPromise(
			Effect.flatMap(validator(toJsonSchema(schema)), (compiled) => Effect.flip(compiled.validate(value))),
		);
		const ours = await Effect.runPromise(Effect.flip(decodeUnknown(schema)(value)));
		const paths = new Set(ours.issues.map((issue) => issue.path));
		expect(pi.issues.map((issue) => issue.path)).toEqual(["/v/x"]);
		expect([...paths].sort()).toEqual(["/v/x", "/v/y"]);
	});
});

describe("encode", () => {
	it("is the inverse of decodeUnknown", async () => {
		const input = { title: "launch", at: "2026-11-24T00:00:00.000Z", tags: ["a"] };
		const event = await Effect.runPromise(decodeUnknown(Event)(input));
		expect(await Effect.runPromise(encode(Event)(event))).toEqual(input);
	});
});
