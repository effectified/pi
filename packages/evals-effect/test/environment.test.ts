import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { Environment, InvalidSetting } from "../src/index.ts";
import { processEnvironment } from "./fixtures.ts";

describe("modelSelection", () => {
	it("prefers the explicit model to the environment's", async () => {
		const selection = await runTest(
			Environment.modelSelection(
				{ provider: "anthropic", id: "claude" },
				{ PI_PROVIDER: "openai", PI_MODEL: "gpt" },
			),
		);
		expect(selection).toEqual({ provider: "anthropic", id: "claude" });
	});

	it("reads PI_PROVIDER and PI_MODEL, trimmed, and the process environment when none is given", async () => {
		const selections = await runTest(
			Effect.gen(function* () {
				yield* processEnvironment({ PI_PROVIDER: " openai ", PI_MODEL: " gpt " });
				return [
					yield* Environment.modelSelection(undefined, { PI_PROVIDER: " azure ", PI_MODEL: " o4 " }),
					yield* Environment.modelSelection(undefined),
				];
			}),
		);
		expect(selections).toEqual([
			{ provider: "azure", id: "o4" },
			{ provider: "openai", id: "gpt" },
		]);
	});

	it("fails with InvalidSetting when no model is named whole", async () => {
		const failure = await runTest(Effect.flip(Environment.modelSelection(undefined, { PI_PROVIDER: "openai" })));
		expect(failure).toBeInstanceOf(InvalidSetting);
		expect(failure.message).toContain("Select a harness model explicitly");
	});
});

describe("documentationVariant", () => {
	it("accepts both variants, from the argument or PI_EVAL_VARIANT", async () => {
		const variants = await runTest(
			Effect.gen(function* () {
				yield* processEnvironment({ PI_EVAL_VARIANT: "with_docs" });
				return [yield* Environment.documentationVariant("without_docs"), yield* Environment.documentationVariant()];
			}),
		);
		expect(variants).toEqual(["without_docs", "with_docs"]);
	});

	it("fails with InvalidSetting on another value", async () => {
		const failure = await runTest(Effect.flip(Environment.documentationVariant("other")));
		expect(failure._tag).toBe("InvalidSetting");
		expect(failure.message).toContain("PI_EVAL_VARIANT");
	});
});

describe("isolated", () => {
	it("sets the home and agent directory and drops PI_EVAL_* for the scope, and restores them when it closes", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				yield* processEnvironment({ PI_EVAL_ARTIFACT_DIR: "/tmp/artifacts" });
				const home = process.env.HOME;
				const scope = yield* Scope.make();
				yield* Environment.isolated("/tmp/eval-home", "/tmp/eval-agent").pipe(Scope.provide(scope));
				const inside = [process.env.HOME, process.env.PI_CODING_AGENT_DIR, process.env.PI_EVAL_ARTIFACT_DIR];
				yield* Scope.close(scope, Exit.void);
				return { inside, after: [process.env.HOME === home, process.env.PI_EVAL_ARTIFACT_DIR] };
			}),
		);
		expect(seen.inside).toEqual(["/tmp/eval-home", "/tmp/eval-agent", undefined]);
		expect(seen.after).toEqual([true, "/tmp/artifacts"]);
	});
});
