import { compile, int, obj, opt, str } from "@earendil-works/pi-schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { fromJsonSchema, toJsonSchema } from "../src/index.ts";

const Lookup = Schema.Struct({
	id: Schema.String.annotate({ description: "Record id" }),
	limit: Schema.optional(Schema.Int),
	kind: Schema.Literals(["a", "b"]),
});

describe("toJsonSchema", () => {
	it("writes closed objects that pi-schema compiles and checks", () => {
		const jsonSchema = toJsonSchema(Lookup);
		expect(jsonSchema).toMatchObject({
			type: "object",
			required: ["id", "kind"],
			additionalProperties: false,
			properties: { id: { type: "string", description: "Record id" }, kind: { enum: ["a", "b"] } },
		});
		const validator = compile(jsonSchema);
		expect(validator.check({ id: "42", kind: "a" })).toBe(true);
		expect(validator.check({ id: "42", kind: "a", limit: 3 })).toBe(true);
		expect(validator.errors({ id: 42, kind: "c", extra: true }).map((error) => error.path)).toEqual([
			"/id",
			"/kind",
			"/extra",
		]);
	});

	it("leaves objects open when asked", () => {
		expect(toJsonSchema(Lookup, { onExcessProperty: "ignore" })).toMatchObject({ additionalProperties: true });
	});

	it("keeps shared definitions under $defs so the schema stands alone", () => {
		class Node extends Schema.Class<Node>("Node")({ name: Schema.String }) {}
		const jsonSchema = toJsonSchema(Schema.Struct({ root: Node, others: Schema.Array(Node) }));
		const validator = compile(jsonSchema);
		expect(validator.check({ root: { name: "a" }, others: [{ name: "b" }] })).toBe(true);
		expect(validator.check({ root: { name: 1 }, others: [] })).toBe(false);
	});
});

describe("fromJsonSchema", () => {
	it("accepts what a pi-schema tool definition accepts", async () => {
		const read = obj({ path: str({ minLength: 1 }), offset: opt(int({ minimum: 1 })) });
		const schema = await Effect.runPromise(fromJsonSchema(read));
		const decode = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" });
		expect(decode({ path: "a.txt", offset: 2 })._tag).toBe("Success");
		expect(decode({ path: "", offset: 2 })._tag).toBe("Failure");
		expect(decode({ path: "a.txt", offset: 0 })._tag).toBe("Failure");
		expect(decode({ path: "a.txt", extra: true })._tag).toBe("Failure");
	});

	it("reads draft 7 definitions", async () => {
		const schema = await Effect.runPromise(
			fromJsonSchema(
				{ type: "array", items: { $ref: "#/definitions/Name" }, definitions: { Name: { type: "string" } } },
				{ draft: "7" },
			),
		);
		expect(Schema.decodeUnknownResult(schema)(["a"])._tag).toBe("Success");
		expect(Schema.decodeUnknownResult(schema)([1])._tag).toBe("Failure");
	});

	it("fails with a typed error for a pattern unless patterns are trusted", async () => {
		const pattern = { type: "string", pattern: "^a" };
		const error = await Effect.runPromise(Effect.flip(fromJsonSchema(pattern)));
		expect(error._tag).toBe("SchemaConversionError");
		expect(error.message).toContain("Patterns");
		const trusted = await Effect.runPromise(fromJsonSchema(pattern, { patterns: "apply" }));
		expect(Schema.decodeUnknownResult(trusted)("b")._tag).toBe("Failure");
	});

	it("fails with a typed error for a keyword Effect cannot express", async () => {
		const error = await Effect.runPromise(
			Effect.flip(fromJsonSchema({ type: "array", contains: { type: "string" } })),
		);
		expect(error._tag).toBe("SchemaConversionError");
	});
});
