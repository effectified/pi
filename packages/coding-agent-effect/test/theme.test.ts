import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { getSelectListTheme, highlightCode, initTheme, keyText } from "../src/index.ts";

describe("initTheme", () => {
	it("sets the theme the helpers draw with: a light theme styles text in other colors than a dark one", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				yield* initTheme("dark");
				const dark = getSelectListTheme().selectedText("item");
				yield* initTheme("light");
				const light = getSelectListTheme().selectedText("item");
				return {
					dark,
					light,
					code: highlightCode("const a = 1;", "typescript").join("\n"),
					key: keyText("tui.select.confirm"),
				};
			}),
		);
		expect(seen.dark).toContain("item");
		expect(seen.light).toContain("item");
		expect(seen.dark).not.toBe(seen.light);
		expect(seen.code).toContain("const");
		expect(seen.key).toBe("enter");
	});
});
