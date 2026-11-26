import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CODEMODE_OPTIONS_PREFIX, parse } from "../src/source.ts";

describe("parse", () => {
	it("splits the options line from the code and keeps the line numbers", async () => {
		const parsed = await runTest(
			parse(`${CODEMODE_OPTIONS_PREFIX} {"max_output_tokens": 2000, "timeout_ms": 30000}\nreturn 1;`),
		);
		expect(parsed).toEqual({ code: "\nreturn 1;", options: { maxOutputTokens: 2000, timeoutMs: 30000 } });
	});

	it("takes a script without an options line as it is", async () => {
		expect(await runTest(parse("return 1;"))).toEqual({ code: "return 1;", options: {} });
	});

	it("fails with CodemodeSourceError, with Pi's message, for what Pi refuses", async () => {
		const failures = await runTest(
			Effect.forEach(
				["  ", `${CODEMODE_OPTIONS_PREFIX} {"colour": 1}\nreturn 1;`, `return 1;\n${CODEMODE_OPTIONS_PREFIX} {}`],
				(input) => Effect.flip(parse(input)),
			),
		);
		expect(failures.map((failure) => failure._tag)).toEqual([
			"CodemodeSourceError",
			"CodemodeSourceError",
			"CodemodeSourceError",
		]);
		expect(failures[1]?.message).toBe("@options only supports `max_output_tokens` and `timeout_ms`; got `colour`");
		expect(failures[2]?.message).toContain("must be the first line");
	});
});
