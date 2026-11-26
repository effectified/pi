import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	ArtifactFailed,
	DockerFailed,
	type EvalsError,
	InvalidPlan,
	InvalidSetting,
	PromptMismatch,
	RunFailed,
} from "../src/index.ts";

const RUN = { output: undefined, session: { events: [] }, usage: {}, errors: [{ message: "boom" }] };

describe("the errors", () => {
	it("are tagged, carry Pi's message, and one catchTags covers the union", async () => {
		const cause = new Error("boom");
		const failures: ReadonlyArray<EvalsError> = [
			new InvalidPlan({ message: "plan" }),
			new InvalidSetting({ message: "setting" }),
			new PromptMismatch({ message: "prompt" }),
			new RunFailed({ message: "run", run: RUN, cause }),
			new DockerFailed({ message: "docker", cause }),
			new ArtifactFailed({ message: "artifact", cause }),
		];
		const handled = await runTest(
			Effect.forEach(failures, (failure) =>
				Effect.fail(failure).pipe(
					Effect.catchTags({
						InvalidPlan: (error) => Effect.succeed(`plan: ${error.message}`),
						InvalidSetting: (error) => Effect.succeed(`setting: ${error.message}`),
						PromptMismatch: (error) => Effect.succeed(`prompt: ${error.message}`),
						RunFailed: (error) => Effect.succeed(`run: ${error.message}, ${error.run.errors.length} error`),
						DockerFailed: (error) => Effect.succeed(`docker: ${error.message}`),
						ArtifactFailed: (error) => Effect.succeed(`artifact: ${error.message}`),
					}),
				),
			),
		);
		expect(handled).toEqual([
			"plan: plan",
			"setting: setting",
			"prompt: prompt",
			"run: run, 1 error",
			"docker: docker",
			"artifact: artifact",
		]);
	});
});
