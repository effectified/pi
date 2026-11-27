# @effectified/pi-evals

Pi's evals ([`@earendil-works/pi-evals`](../evals)) in Effect terms, for `effect` 4.1: the harness that runs Pi's
coding agent for an eval, and the documentation comparison that runs each case with and without Pi's documentation.

- A harness run is an `Effect`; its output, the input of your scorers, is an `Effect` with your services.
- Interrupting a run aborts the agent's request and waits until Pi cleaned up.
- A comparison's container runs come as a `Stream` of observations; plans and reports are Pi's own types.
- Pi's failures are one closed union of tagged errors.

It adds no behaviour of its own: what pi-evals does is what happens. Built for pi-evals 1.6.1. Suites, cases and
judges (`describeEval`, `StructuredOutputJudge`) are [vitest-evals](https://github.com/getsentry/vitest-evals)'s, not
pi-evals', and are not wrapped here.

## Install

pi-evals is private to Pi's workspace and not published, so this package is not published either: it
works inside a checkout of [effectified/pi](https://github.com/effectified/pi), where npm links both.

```sh
npm install --ignore-scripts   # in the checkout; then import @effectified/pi-evals from a workspace package
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Quick start

A harness runs Pi's coding agent once per input, in a new home, agent directory and workspace. The model comes from
`model`, or from `PI_PROVIDER` and `PI_MODEL`; its credential from `~/.pi/agent/auth.json` or the provider's
environment. Without `output`, a run's output is the agent's answer.

```ts
import { Context, Effect } from "effect";
import { Harness, type PiCodingAgentModelSelection } from "@effectified/pi-evals";

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
```

A failure of `output` is the run's failure, with its own type. `Harness.makeDocumentation` is the harness of a
documentation comparison's container: it fails with `InvalidSetting` anywhere else.

## A documentation comparison

The comparison builds an image with Pi's documentation and one without, lists the cases of the eval files in both,
plans `(case, variant, run)` tasks, and runs each in a new container. `Docker.observe` streams the observation of each
task as its container ends; `Report.summarize` is a Sink of them that gives Pi's report. What to keep of them, and
where, is yours.

```ts
import { Console, Effect, Stream } from "effect";
import { createDockerContext, Docker, formatEvalComparisonReport, Plan, Report } from "@effectified/pi-evals";

const compare = (files: ReadonlyArray<string>, provider: string, model: string, artifacts: string) =>
	Effect.gen(function* () {
		const authPath = yield* Docker.requireAuthFile(provider); // InvalidSetting without a credential
		const images = yield* Docker.buildImages; // DockerFailed when a build fails
		const context = createDockerContext(images, artifacts, authPath, provider, model, 1);
		// Pi's runner also checks that both variants list the same cases; one is read here.
		const listed = yield* Docker.discoverCases(context, "without_docs", files, []);
		const tasks = yield* Plan.createTaskPlan(yield* Plan.readDiscoveredCases(listed), `${provider}/${model}`, 1);
		const report = yield* Docker.observe(context, tasks).pipe(
			Stream.tap((observation) =>
				Console.log(`${observation.caseId} | ${observation.variant} | ${observation.outcome}`),
			),
			Stream.run(Report.summarize("protocol", tasks)),
		);
		return formatEvalComparisonReport(report);
	});
```

`Plan.readDiscoveredCases` reads the discovery file with Effect's `FileSystem` and decodes it with Schema: provide
one, such as `NodeFileSystem.layer` of `@effect/platform-node`. Pi runs `docker` synchronously: interrupting the fiber
takes effect when the running container has ended.

`Report.EvalObservation` is Pi's observation as a Schema, to keep observations in a file and read them back:
`Schema.fromJsonString(Report.EvalObservation)` encodes one as a line of JSON and decodes it.

## Plans and reports

Plans, observations and reports are Pi's types, and the functions of observations and reports are Pi's own.

```ts
import { Effect } from "effect";
import { type EvalObservation, Plan, summarizeEvalObservations } from "@effectified/pi-evals";

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
```

## Not wrapped

- `customTools` of a harness: their `execute` is a promise callback, and their Effect form belongs to a facade of
  pi-coding-agent.
- `transformSystemPrompt` stays a pure function of the prompt: Pi calls it synchronously inside the request.
- pi-evals' comparison runner (`src/cli.ts`) is a script that runs when it is imported; `Docker.observe` is its loop.
- Timings of a run come from Pi's `performance.now()`, not from `Clock`.
- The process environment is global: a run sets `HOME` and `PI_CODING_AGENT_DIR` for its duration, so two runs at once
  in one process see each other's. On Bun, `os.homedir()` does not follow `HOME`; Pi's agent directory still moves,
  since Pi sets `PI_CODING_AGENT_DIR` too.

## License

MIT
