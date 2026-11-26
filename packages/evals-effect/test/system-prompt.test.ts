import { join } from "node:path";
import { runLive, runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { DOCUMENTATION_EVAL_TOOLS, Environment, Harness, PromptMismatch, SystemPrompt } from "../src/index.ts";
import { temporaryDirectory } from "./fixtures.ts";
import { AZURE_MODEL, responsesServer, serverEnvironment } from "./responses-server.ts";

/** Pi's default system prompt with the documentation tools, as a harness run sends it. */
const defaultPrompt = Effect.gen(function* () {
	const directory = yield* temporaryDirectory;
	yield* Environment.isolated(join(directory, "home"), join(directory, "agent"));
	yield* serverEnvironment(yield* responsesServer([{ kind: "text", text: "ok" }]));
	const harness = yield* Harness.make({
		model: AZURE_MODEL,
		tools: [...DOCUMENTATION_EVAL_TOOLS],
		output: ({ systemPrompt }) => Effect.succeed(systemPrompt),
	});
	return (yield* harness.run("Hello")).output;
});

describe("excludeDocumentation and verify", () => {
	it(
		"take Pi's documentation out of its default prompt, keep the rest, and check each variant's prompt",
		() =>
			runLive(
				Effect.gen(function* () {
					const prompt = yield* defaultPrompt;
					const stripped = yield* SystemPrompt.excludeDocumentation(prompt);
					expect(prompt).toContain("\n<docs>\nPi documentation (read only");
					expect(stripped).not.toContain("<docs>");
					expect(stripped).toContain("\n<rules>\n");
					expect(stripped).toContain("\n<cwd>\n");
					expect(yield* SystemPrompt.verify(prompt, { name: "with_docs", expectedPiDocumentation: true })).toBe(
						prompt,
					);
					expect(
						yield* SystemPrompt.verify(stripped, { name: "without_docs", expectedPiDocumentation: false }),
					).toBe(stripped);
					const mismatch = yield* Effect.flip(
						SystemPrompt.verify(prompt, { name: "without_docs", expectedPiDocumentation: false }),
					);
					expect(mismatch.message).toBe("Pi system prompt does not match the without_docs eval variant.");
				}),
			),
		60_000,
	);

	it("verify accepts any prompt when no documentation is expected either way", async () => {
		expect(await runTest(SystemPrompt.verify("Instructions", {}))).toBe("Instructions");
	});

	it.each([
		["no documentation section", "Instructions", "no Pi documentation section"],
		["no working directory after it", "\n<docs>\nPi documentation\n</docs>", "no working-directory section"],
	])("excludeDocumentation fails with PromptMismatch on a prompt with %s", async (_, prompt, message) => {
		const failure = await runTest(Effect.flip(SystemPrompt.excludeDocumentation(prompt)));
		expect(failure).toBeInstanceOf(PromptMismatch);
		expect(failure.message).toContain(message);
	});

	it("verify fails with PromptMismatch on a prompt that lost its rules", async () => {
		const failure = await runTest(
			Effect.flip(SystemPrompt.verify("no rules", { name: "with_docs", expectedPiDocumentation: true })),
		);
		expect(failure.message).toBe("Pi system prompt lost its rules in the with_docs eval variant.");
	});
});
