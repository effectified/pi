import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { splitInput } from "../src/split-input.ts";
import { run } from "./run.ts";

describe("splitInput", () => {
	it("joins a sequence cut in two, splits several in one chunk, and gives a paste whole", async () => {
		const sequences = await run(
			Stream.runCollect(splitInput(Stream.make("\x1b[", "Aab", "\x1b[200~pasted\nlines\x1b[201~", "\r"))),
		);
		expect(sequences).toEqual([
			{ kind: "data", sequence: "\x1b[A" },
			{ kind: "data", sequence: "a" },
			{ kind: "data", sequence: "b" },
			{ kind: "paste", content: "pasted\nlines" },
			{ kind: "data", sequence: "\r" },
		]);
	});

	it("gives what still waits for its rest when the input ends", async () => {
		const sequences = await run(Stream.runCollect(splitInput(Stream.make("x", "\x1b"))));
		expect(sequences).toEqual([
			{ kind: "data", sequence: "x" },
			{ kind: "data", sequence: "\x1b" },
		]);
	});

	it("fails with the input's failure", async () => {
		const failure = await run(
			Effect.flip(Stream.runCollect(splitInput(Stream.concat(Stream.make("a"), Stream.fail("closed"))))),
		);
		expect(failure).toBe("closed");
	});
});
