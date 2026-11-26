import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { err, FileError, fromResult, ok } from "../../src/env/index.ts";

describe("fromResult", () => {
	it("succeeds with an ok result's value and fails with an err result's error", async () => {
		const error = new FileError("not_found", "No such file", "/missing");
		const exits = await Promise.all([
			Effect.runPromiseExit(fromResult(ok<number, FileError>(7))),
			Effect.runPromiseExit(fromResult(err<number, FileError>(error))),
		]);
		expect(exits).toEqual([Exit.succeed(7), Exit.fail(error)]);
	});
});
