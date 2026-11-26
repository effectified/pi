import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Section, Tool } from "../src/index.ts";

describe("a wrapper's registration", () => {
	it("is Pi's wrapper of a tool or a section, by name or key", async () => {
		const wraps = await Effect.runPromise(
			Effect.all([
				Tool.wrap("echo", () => ({})).registration,
				Section.wrap("motto", () => ({ render: () => Effect.succeed(Option.none()) })).registration,
			]),
		);
		expect(wraps.map((wrap) => [wrap.kind, wrap.kind === "tool" ? wrap.tool : wrap.section])).toEqual([
			["tool", "echo"],
			["section", "motto"],
		]);
	});
});
