// The coding-agent harness: one Pi coding-agent session in a new home, agent directory and workspace, run as an
// Effect, its output computed by an Effect of the caller.

import {
	createPiCodingAgentHarness,
	createPiDocumentationEvalHarness,
	type PiCodingAgentHarnessOptions,
	type PiCodingAgentHarnessWithOutput,
	type PiCodingAgentInput,
} from "@earendil-works/pi-evals/src/harness.ts";
import { Cause, type Context, Effect, Exit } from "effect";
import { getHarnessRunFromError, type Harness, type HarnessRun, type JsonValue } from "vitest-evals/harness";
import { InvalidSetting, messageOf, RunFailed } from "./errors.ts";

/**
 * What a harness runs, as Pi's harness takes it: the model (else `PI_PROVIDER` and `PI_MODEL`), the tools, the files
 * of the workspace, a pure transform of the system prompt, and whether the prompt must hold Pi's documentation.
 * Pi's `customTools` are left out: their `execute` is a promise callback, and their Effect form belongs to the
 * coding-agent facade.
 */
export type Options = Omit<PiCodingAgentHarnessOptions, "customTools">;

/** What an output gets: the agent's last answer, its session, the system prompt sent and the agent directory. */
export type OutputArgs = Parameters<PiCodingAgentHarnessWithOutput<JsonValue>["output"]>[0];

/** The output of a run, computed from it: a scorer's input, with the caller's services. */
export type Output<TOutput extends JsonValue, E, R> = (args: OutputArgs) => Effect.Effect<TOutput, E, R>;

/** `Options` with the output of a run: the run's output is what it returns, not the agent's answer. */
export interface OptionsWithOutput<TOutput extends JsonValue, E, R> extends Options {
	readonly output: Output<TOutput, E, R>;
}

/** The options of a documentation harness: Pi sets its name, its prompt transform and its documentation check. */
export type DocumentationOptions = Omit<
	NonNullable<Parameters<typeof createPiDocumentationEvalHarness>[0]>,
	"customTools" | "output"
>;

/** `DocumentationOptions` with the output of a run. */
export interface DocumentationOptionsWithOutput<TOutput extends JsonValue, E, R> extends DocumentationOptions {
	readonly output: Output<TOutput, E, R>;
}

/**
 * A harness: its name in reports, and a run of one input (a prompt, or prompts and reloads in order) as an Effect.
 * Interrupting a run aborts the agent's session and waits until Pi removed the run's directories and restored the
 * process environment.
 */
export interface EvalHarness<TOutput extends JsonValue, E = never> {
	readonly name: string;
	readonly run: (input: PiCodingAgentInput) => Effect.Effect<HarnessRun<TOutput>, RunFailed | E>;
}

/**
 * A harness of Pi's coding agent. Each run gets a new home, agent directory, workspace and session, the credential of
 * its provider from the host's `auth.json` or the provider's environment, and records its transcript, usage, timings
 * and session file. With `output`, a run's output is that Effect's value, computed with the services of the Effect
 * that made the harness; its failure is the run's.
 */
export function make<TOutput extends JsonValue, E, R>(
	options: OptionsWithOutput<TOutput, E, R>,
): Effect.Effect<EvalHarness<TOutput, E>, never, R>;
export function make(options?: Options): Effect.Effect<EvalHarness<string>>;
export function make<TOutput extends JsonValue, E, R>(
	options: Options & { readonly output?: Output<TOutput, E, R> } = {},
): Effect.Effect<EvalHarness<TOutput, E>, never, R> {
	const { output, ...piOptions } = options;
	return Effect.map(Effect.context<R>(), (context) =>
		harness(
			(piOutput) =>
				Effect.sync(() =>
					piOutput === undefined
						? createPiCodingAgentHarness(piOptions)
						: createPiCodingAgentHarness({ ...piOptions, output: piOutput }),
				),
			createPiCodingAgentHarness(piOptions).name,
			output,
			context,
		),
	);
}

/**
 * A harness of the documentation comparison, for a run inside its container: named by its variant
 * (`PI_EVAL_VARIANT`), with the documentation tools unless `tools` says otherwise, and the system prompt without
 * Pi's documentation for `without_docs`. Fails with `InvalidSetting` outside the container sandbox
 * (`PI_EVAL_CONTAINER`, `PI_EVAL_SANDBOX_UID` and `PI_EVAL_SANDBOX_GID`) or with an unknown variant; a run reads
 * them again and fails the same way when they changed.
 */
export function makeDocumentation<TOutput extends JsonValue, E, R>(
	options: DocumentationOptionsWithOutput<TOutput, E, R>,
): Effect.Effect<EvalHarness<TOutput, E | InvalidSetting>, InvalidSetting, R>;
export function makeDocumentation(
	options?: DocumentationOptions,
): Effect.Effect<EvalHarness<string, InvalidSetting>, InvalidSetting>;
export function makeDocumentation<TOutput extends JsonValue, E, R>(
	options: DocumentationOptions & { readonly output?: Output<TOutput, E, R> } = {},
): Effect.Effect<EvalHarness<TOutput, E | InvalidSetting>, InvalidSetting, R> {
	const { output, ...piOptions } = options;
	const create = (piOutput: PiOutput | undefined): Effect.Effect<PiHarness, InvalidSetting> =>
		Effect.try({
			try: () =>
				piOutput === undefined
					? createPiDocumentationEvalHarness(piOptions)
					: createPiDocumentationEvalHarness({ ...piOptions, output: piOutput }),
			catch: (cause) => new InvalidSetting({ message: messageOf(cause) }),
		});
	return Effect.flatMap(create(undefined), (first) =>
		Effect.map(Effect.context<R>(), (context) => harness(create, first.name, output, context)),
	);
}

/** Pi's harness: a vitest-evals adapter whose run is a promise. */
type PiHarness = Harness<PiCodingAgentInput, JsonValue>;

/** The output callback Pi's harness awaits. */
type PiOutput = PiCodingAgentHarnessWithOutput<JsonValue>["output"];

/**
 * The harness of `create`: each run creates Pi's harness with an output that runs `output` with `context`, under the
 * run's abort signal, and keeps its failure so the run fails with it rather than with Pi's rejection.
 */
function harness<TOutput extends JsonValue, E, R, CreateError>(
	create: (output: PiOutput | undefined) => Effect.Effect<PiHarness, CreateError>,
	name: string,
	output: Output<TOutput, E, R> | undefined,
	context: Context.Context<R>,
): EvalHarness<TOutput, E | CreateError> {
	const runExit = Effect.runPromiseExitWith(context);
	const run = (input: PiCodingAgentInput) =>
		Effect.suspend(() => {
			const state: { signal?: AbortSignal; failure?: Cause.Cause<E> } = {};
			const piOutput: PiOutput | undefined =
				output &&
				((args) =>
					runExit(output(args), { signal: state.signal }).then((exit) => {
						if (Exit.isSuccess(exit)) return exit.value;
						state.failure = exit.cause;
						// A new error: vitest-evals attaches its run to what Pi rejects with, which must not be the caller's.
						return Promise.reject(new Error(Cause.pretty(exit.cause)));
					}));
			return Effect.flatMap(create(piOutput), (piHarness) =>
				abortable<HarnessRun<TOutput>, RunFailed | E>(
					(signal) => {
						state.signal = signal;
						const artifacts: Record<string, JsonValue> = {};
						const setArtifact = (key: string, value: JsonValue): void => {
							artifacts[key] = value;
						};
						// With an output, Pi's overload makes the run's output that output's value: `TOutput`; without one
						// it is the agent's answer, and `make` without an output is typed `string`.
						return piHarness.run(input, { signal, artifacts, setArtifact }) as Promise<HarnessRun<TOutput>>;
					},
					(cause) => (state.failure === undefined ? runFailed(cause) : Effect.failCause(state.failure)),
				),
			);
		});
	return { name, run };
}

function runFailed(cause: unknown): Effect.Effect<never, RunFailed> {
	const run = getHarnessRunFromError(cause);
	// vitest-evals attaches a run to every rejection of a harness it made; one without is not Pi's harness failing.
	if (run === undefined) return Effect.die(cause);
	return Effect.fail(new RunFailed({ message: messageOf(cause), run, cause }));
}

/**
 * Runs a Pi call that takes an AbortSignal with the fiber's: interrupting the fiber aborts the call and waits until
 * Pi settled it, so its cleanup is done when the interruption completes. A rejection becomes `onRejection` of it.
 */
function abortable<A, E>(
	run: (signal: AbortSignal) => Promise<A>,
	onRejection: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		// A promise executor turns a synchronous throw of `run` into a rejection too.
		const done = new Promise<A>((resolve) => resolve(run(signal))).then(
			(value) => resume(Effect.succeed(value)),
			(cause: unknown) => resume(onRejection(cause)),
		);
		return Effect.promise(() => done);
	});
}
