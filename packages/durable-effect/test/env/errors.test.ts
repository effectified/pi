import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecFailed, FILE_ERROR_CODES, FileFailed } from "../../src/env/index.ts";

describe("the environment's failures", () => {
	it("are tagged errors that keep Pi's code, message and details", async () => {
		const file = new FileFailed({ code: "not_found", message: "No such file", path: "/missing" });
		const exec = new ExecFailed({ code: "timeout", message: "Timed out", spillPath: "/tmp/out" });
		const caught = await Effect.runPromise(
			Effect.flip(Effect.fail(file)).pipe(Effect.map((error) => [error._tag, error.code, error.path])),
		);
		expect(caught).toEqual(["FileFailed", "not_found", "/missing"]);
		expect([exec._tag, exec.code, exec.spillPath]).toEqual(["ExecFailed", "timeout", "/tmp/out"]);
	});

	it("refuse a code Pi does not have", () => {
		expect(Schema.is(FileFailed)(new FileFailed({ code: "invalid", message: "x" }))).toBe(true);
		expect(FILE_ERROR_CODES).toContain("permission_denied");
		expect(() => Schema.decodeUnknownSync(FileFailed)({ _tag: "FileFailed", code: "gone", message: "x" })).toThrow();
	});
});
