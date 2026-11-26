// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the package, this file the sources). The model answers from a loopback server and
// `docker` is a fake on `PATH`.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTest } from "@effectified/pi-ai/testing";
import { Console, Context, Effect, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	createDockerContext,
	Docker,
	Environment,
	type EvalObservation,
	formatEvalComparisonReport,
	Harness,
	type PiCodingAgentModelSelection,
	Plan,
	summarizeEvalObservations,
} from "../src/index.ts";
import { fakeDocker } from "./fake-docker.ts";
import { processEnvironment, temporaryDirectory } from "./fixtures.ts";
import { AZURE_MODEL, responsesServer, serverEnvironment } from "./responses-server.ts";
import { TASK, vitestReport } from "./vitest-report.ts";

// README: quick start
// A service of your program. The output reaches it through what the harness was made with.
class Capitals extends Context.Service<Capitals, { readonly of: (country: string) => string }>()("app/Capitals") {}

const scoreCapital = (model: PiCodingAgentModelSelection) =>
	Effect.gen(function* () {
		const harness = yield* Harness.make({
			name: "capitals",
			model,
			noTools: "all",
			// The scorer's input: computed after the agent answered, with the session and the prompt it was sent.
			output: ({ response }) =>
				Capitals.use((capitals) =>
					Effect.succeed({ answer: response, correct: response === capitals.of("France") }),
				),
		});
		const run = yield* harness.run("What's the capital of France? Respond with only the city name.");
		return { output: run.output, tokens: run.usage.totalTokens, errors: run.errors };
	}).pipe(
		Effect.provideService(Capitals, { of: (country) => (country === "France" ? "Paris" : "unknown") }),
		// RunFailed holds Pi's message and the partial run: its transcript, usage and errors.
		Effect.catchTag("RunFailed", (failure) => Effect.succeed({ failed: failure.message })),
	);

// README: a documentation comparison
const compare = (files: ReadonlyArray<string>, provider: string, model: string, artifacts: string) =>
	Effect.gen(function* () {
		const authPath = yield* Docker.requireAuthFile(provider); // InvalidSetting without a credential
		const images = yield* Docker.buildImages; // DockerFailed when a build fails
		const context = createDockerContext(images, artifacts, authPath, provider, model, 1);
		// Pi's runner also checks that both variants list the same cases; one is read here.
		const listed = yield* Docker.discoverCases(context, "without_docs", files, []);
		const discovered: unknown = JSON.parse(yield* Effect.promise(() => readFile(listed, "utf8")));
		const tasks = yield* Plan.createTaskPlan(yield* Plan.parseDiscoveredCases(discovered), `${provider}/${model}`, 1);
		const observations = yield* Docker.observe(context, tasks).pipe(
			Stream.tap((observation) =>
				Console.log(`${observation.caseId} | ${observation.variant} | ${observation.outcome}`),
			),
			Stream.runCollect,
		);
		return formatEvalComparisonReport(summarizeEvalObservations("protocol", tasks, observations));
	});

// README: plans and reports
const lift = Effect.gen(function* () {
	const cases = yield* Plan.parseDiscoveredCases([
		{ name: "Add a model > adds it", file: "evals/models.docs.eval.ts" },
	]);
	const tasks = yield* Plan.createTaskPlan(cases, "openai/gpt-5", 1); // InvalidPlan on a model without a provider
	const observations = tasks.map(
		(task): EvalObservation => ({ ...task, outcome: "scored", score: task.variant === "with_docs" ? 1 : 0 }),
	);
	const [comparison] = summarizeEvalObservations("protocol", tasks, observations).comparisons;
	return { lift: comparison?.lift, flags: comparison?.flags }; // { lift: 1, flags: ["treatment-saturated"] }
});

describe("the README", () => {
	it(
		"quick start: a run of Pi's coding agent, its output scored with the program's service",
		() =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* temporaryDirectory;
					yield* Environment.isolated(join(directory, "home"), join(directory, "agent"));
					yield* serverEnvironment(yield* responsesServer([{ kind: "text", text: "Paris" }]));
					expect(yield* scoreCapital(AZURE_MODEL)).toEqual({
						output: { answer: "Paris", correct: true },
						tokens: 15,
						errors: [],
					});
					const failed = yield* scoreCapital({ provider: "azure", id: "no-such-model" });
					expect(failed).toEqual({ failed: "Eval model not found: azure/no-such-model" });
				}),
			),
		60_000,
	);

	it("a documentation comparison: each container's observation as it ends, then the report", () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* temporaryDirectory;
				yield* processEnvironment({ PI_CODING_AGENT_DIR: directory });
				yield* Effect.promise(() => writeFile(join(directory, "auth.json"), '{"fixture":{"type":"api_key"}}'));
				const discovery = join(directory, "discovered.json");
				const report = join(directory, "vitest.json");
				const discovered = [{ name: `${TASK.evalSet} > ${TASK.caseId}`, file: TASK.file }];
				yield* Effect.promise(() => writeFile(discovery, JSON.stringify(discovered)));
				yield* Effect.promise(() => writeFile(report, vitestReport(1)));
				yield* fakeDocker({ discovery, report });
				const text = yield* compare([TASK.file], "fixture", "model", join(directory, "artifacts"));
				expect(text).toContain(TASK.evalSet);
				expect(text).toContain("Pass rate  +0.0 pp (with 100.0%, without 100.0%)");
				expect(yield* TestConsole.logLines).toEqual([
					`${TASK.caseId} | without_docs | scored`,
					`${TASK.caseId} | with_docs | scored`,
				]);
			}),
		));

	it("plans and reports: Pi's lift of a planned comparison", async () => {
		expect(await runTest(lift)).toEqual({ lift: 1, flags: ["treatment-saturated"] });
	});
});
