import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Declarations from "../src/declarations.ts";
import { ScriptTool } from "../src/index.ts";
import { greet, lookup, records } from "./tools.ts";

describe("the declarations entry", () => {
	it("renders the declarations a model reads for tools made from Effect tools", async () => {
		const tools = await runTest(
			Effect.all([ScriptTool.fromAgent(lookup), ScriptTool.fromAgent(greet)]).pipe(Effect.provide(records)),
		);
		expect(Declarations.renderDeclarations({ tools })).toBe(
			[
				"declare const tools: {",
				"  /** Look a record up by id. */",
				"  lookup(args: { id: string; }): Promise<{ title: string; }>;",
				"  /** Greet someone. */",
				"  greet(args: { name: string; }): Promise<string>;",
				"};",
			].join("\n"),
		);
	});
});
