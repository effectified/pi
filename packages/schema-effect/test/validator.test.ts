import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { validator } from "../src/index.ts";

const Read = obj({
	path: str({ minLength: 1 }),
	offset: opt(int({ minimum: 1 })),
	mode: oneOf(["text", "binary"]),
});

describe("validator", () => {
	it("returns a valid value typed and unchanged", async () => {
		const read = await Effect.runPromise(validator(Read));
		const value = { path: "a.txt", mode: "text" };
		const checked = await Effect.runPromise(read.validate(value));
		expect(checked).toBe(value);
		expect(checked.mode).toBe("text");
	});

	it("fails with pi-schema's errors: path, keyword and message", async () => {
		const read = await Effect.runPromise(validator(Read));
		const error = await Effect.runPromise(Effect.flip(read.validate({ offset: 0, extra: true })));
		expect(error._tag).toBe("SchemaDecodeError");
		expect(error.issues).toEqual([
			{ path: "/path", keyword: "required", message: "missing" },
			{ path: "/mode", keyword: "required", message: "missing" },
			{ path: "/offset", keyword: "minimum", message: "expected >= 1" },
			{ path: "/extra", keyword: "additionalProperties", message: "unknown field" },
		]);
	});

	it("coerces loosely typed arguments in parse, never in validate", async () => {
		const read = await Effect.runPromise(validator(Read));
		const loose = { path: "a.txt", offset: "10", mode: "text" };
		expect(await Effect.runPromise(read.parse(loose))).toEqual({ path: "a.txt", offset: 10, mode: "text" });
		expect((await Effect.runPromise(Effect.flip(read.validate(loose)))).issues[0]?.path).toBe("/offset");
	});

	it("fails with a typed error for a reference that names nothing", async () => {
		const error = await Effect.runPromise(Effect.flip(validator({ $ref: "#/$defs/Missing" })));
		expect(error._tag).toBe("SchemaConversionError");
	});
});
