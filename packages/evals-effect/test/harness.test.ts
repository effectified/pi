import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Context, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Environment, Harness, InvalidSetting, PI_SESSION_SNAPSHOT_ARTIFACT, RunFailed } from "../src/index.ts";
import { processEnvironment, temporaryDirectory } from "./fixtures.ts";
import { AZURE_MODEL, type Reply, responsesServer, serverEnvironment } from "./responses-server.ts";

/** A harness run starts a coding-agent session: loading its resources takes seconds, not milliseconds. */
const RUN_TIMEOUT = 60_000;

/**
 * A scope in which Pi's `azure` provider answers from a loopback server with `replies`, and the host's agent
 * directory (where the harness reads `auth.json`) is an empty temporary one, never the developer's.
 */
function againstServer(replies: readonly [Reply, ...Reply[]]) {
	return Effect.gen(function* () {
		const directory = yield* temporaryDirectory;
		yield* Environment.isolated(join(directory, "home"), join(directory, "agent"));
		const server = yield* responsesServer(replies);
		yield* serverEnvironment(server);
		return server;
	});
}

class Expected extends Context.Service<Expected, { readonly city: string }>()("test/Expected") {}

class WrongAnswer extends Schema.TaggedError<WrongAnswer>()("WrongAnswer", { answer: Schema.String }) {}

describe("make", () => {
	it(
		"runs Pi's coding agent and records its run: the answer, usage, artifacts and no errors",
		() =>
			runLive(
				Effect.gen(function* () {
					yield* againstServer([{ kind: "text", text: "Paris" }]);
					const harness = yield* Harness.make({ model: AZURE_MODEL, noTools: "all" });
					const run = yield* harness.run("What's the capital of France? Respond with only the city name.");
					expect(harness.name).toBe("pi-coding-agent");
					expect(run.output).toBe("Paris");
					expect(run.errors).toEqual([]);
					expect(run.usage).toMatchObject({ provider: "azure", model: AZURE_MODEL.id, totalTokens: 15 });
					expect(typeof run.artifacts?.runId).toBe("string");
					expect(run.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT]).toContain('"type":"session"');
				}),
			),
		RUN_TIMEOUT,
	);

	it(
		"computes the output with an Effect that has the services of the Effect that made the harness",
		() =>
			runLive(
				Effect.gen(function* () {
					yield* againstServer([{ kind: "text", text: "Paris" }]);
					const harness = yield* Harness.make({
						name: "capitals",
						model: AZURE_MODEL,
						noTools: "all",
						output: ({ response }) =>
							Expected.use(({ city }) => Effect.succeed({ answer: response, correct: response === city })),
					}).pipe(Effect.provideService(Expected, { city: "Paris" }));
					const run = yield* harness.run("What's the capital of France?");
					expect(harness.name).toBe("capitals");
					expect(run.output).toEqual({ answer: "Paris", correct: true });
				}),
			),
		RUN_TIMEOUT,
	);

	it(
		"fails the run with the output's own failure, not Pi's rejection",
		() =>
			runLive(
				Effect.gen(function* () {
					yield* againstServer([{ kind: "text", text: "Lyon" }]);
					const harness = yield* Harness.make({
						model: AZURE_MODEL,
						noTools: "all",
						output: ({ response }) =>
							response === "Paris"
								? Effect.succeed(response)
								: Effect.fail(new WrongAnswer({ answer: response })),
					});
					const failure = yield* Effect.flip(harness.run("What's the capital of France?"));
					expect(failure).toEqual(new WrongAnswer({ answer: "Lyon" }));
				}),
			),
		RUN_TIMEOUT,
	);

	it(
		"fails with RunFailed, Pi's message and the failed run when the model is not in the catalog",
		() =>
			runLive(
				Effect.gen(function* () {
					yield* againstServer([{ kind: "text", text: "unused" }]);
					const harness = yield* Harness.make({ model: { provider: "azure", id: "no-such-model" } });
					const failure = yield* Effect.flip(harness.run("Hello"));
					expect(failure).toBeInstanceOf(RunFailed);
					expect(failure.message).toBe("Eval model not found: azure/no-such-model");
					expect(failure.run.errors.length).toBeGreaterThan(0);
				}),
			),
		RUN_TIMEOUT,
	);

	it(
		"aborts the agent's request when the fiber is interrupted, and waits until Pi restored the environment",
		() =>
			runLive(
				Effect.gen(function* () {
					const server = yield* againstServer([{ kind: "hold" }]);
					const home = process.env.HOME;
					const harness = yield* Harness.make({ model: AZURE_MODEL, noTools: "all" });
					const fiber = yield* Effect.forkChild(harness.run("Hello"), { startImmediately: true });
					yield* Deferred.await(server.held);
					expect(process.env.HOME).not.toBe(home);
					yield* Fiber.interrupt(fiber);
					expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
					expect(process.env.HOME).toBe(home);
					yield* Deferred.await(server.closed);
				}),
			),
		RUN_TIMEOUT,
	);

	// A real model is a paid request over the network: it runs only when named, as `<provider>/<model>` with that
	// provider's credential in `~/.pi/agent/auth.json` or its environment.
	const realModel = process.env.EVALS_EFFECT_REAL_MODEL;
	it.skipIf(realModel === undefined)(
		"runs a real model (EVALS_EFFECT_REAL_MODEL)",
		() =>
			runLive(
				Effect.gen(function* () {
					const [provider = "", ...id] = (realModel ?? "").split("/");
					const harness = yield* Harness.make({ model: { provider, id: id.join("/") }, noTools: "all" });
					const run = yield* harness.run("What's the capital of France? Respond with only the city name.");
					expect(run.output.trim()).toBe("Paris");
				}),
			),
		RUN_TIMEOUT,
	);
});

describe("makeDocumentation", () => {
	it("fails with InvalidSetting outside the documentation container", () =>
		runLive(
			Effect.gen(function* () {
				yield* processEnvironment({ PI_EVAL_CONTAINER: undefined });
				const failure = yield* Effect.flip(Harness.makeDocumentation());
				expect(failure).toBeInstanceOf(InvalidSetting);
				expect(failure.message).toBe("Documentation evals must run in the isolated container sandbox.");
			}),
		));

	// Inside the comparison's container only: it runs as root, with the sandbox identity and the variant set.
	it.skipIf(process.env.PI_EVAL_CONTAINER !== "1")("is named by its variant inside the documentation container", () =>
		runLive(
			Effect.gen(function* () {
				const harness = yield* Harness.makeDocumentation();
				expect(harness.name).toBe(process.env.PI_EVAL_VARIANT);
			}),
		),
	);
});
