// Task steps: what a task commits for itself (its next state, a sleep, a wait, or its outcome), as a tagged union.

import type { JsonObject, NextTaskState, TaskOutcome, TaskOutcomeError } from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { JsonValue } from "@effectified/pi-chord/json";
import type { SchemaConversionError, SchemaDecodeError } from "@effectified/pi-schema";
import { Effect } from "effect";
import * as Signal from "./signal.ts";

/** The state a task commits for itself: Pi's `NextTaskState`, with the state and the result as decoded values. */
export type Step<S, A> = Next<S> | Sleep<S> | Wait<S> | End<A>;

/** The state of `status` Pi takes from a task that commits for itself. */
type PiNext<Status extends NextTaskState<unknown, unknown>["status"]> = Extract<
	NextTaskState<unknown, unknown>,
	{ readonly status: Status }
>;

/** The task goes on at `state`: a new phase, or progress within the same one. */
export interface Next<S> {
	readonly _tag: "Next";
	readonly state: S;
}

/**
 * The task sleeps, holding no process, until one of `signals` holds a value or the harness clock reaches `until`,
 * whichever comes first; then it resumes at `state`, its `wake` saying why.
 */
export interface Sleep<S> {
	readonly _tag: "Sleep";
	readonly state: S;
	/** Epoch milliseconds on the harness clock (`api.now`). */
	readonly until?: PiNext<"sleeping">["until"];
	readonly signals?: ReadonlyArray<Signal.Key>;
}

/** The task waits, holding no process, until the tasks in `on` have ended, as `policy` says; then resumes at `state`. */
export interface Wait<S> {
	readonly _tag: "Wait";
	readonly state: S;
	readonly on: PiNext<"waiting">["on"];
	/** `allSettled`: all of them; `failFast`: also aborts the others once one fails; `any`: the first one. */
	readonly policy: PiNext<"waiting">["policy"];
}

/** The task ends with `outcome`. Pi holds it as `completing` while work the task owns is still live. */
export interface End<A> {
	readonly _tag: "End";
	readonly outcome: Outcome<A>;
}

/** An outcome a task decides itself, Pi's `TaskOutcome` of that status; `faulted` and `orphaned` are the scheduler's. */
export type Outcome<A> = Extract<TaskOutcome<A>, { readonly status: "completed" | "failed" | "aborted" }>;

/** What a commit body returns to leave the task's state as it is: only its other writes are stored. */
export interface Unchanged {
	readonly _tag: "Unchanged";
}

/** What `api.commit` succeeds with, and a phase returns when it committed its step itself. */
export interface Committed {
	readonly _tag: "Committed";
}

/** Goes on at `state`. A phase must change the state or end the task: Pi faults one that returns without progress. */
export function next<S>(state: S): Next<S> {
	return { _tag: "Next", state };
}

/**
 * Sleeps until a signal or a time, then resumes at `state`. Pi rejects a sleep with neither, and a key that already
 * served a wait. There is no sleep inside a phase: what comes after the wait belongs in the phase `state` names.
 */
export function sleep<S>(options: StrictOmit<Sleep<S>, "_tag">): Sleep<S> {
	return { _tag: "Sleep", ...options };
}

/** Sleeps until the harness clock reaches `until`, then resumes at `state`: Pi's `sleepUntil`. */
export function sleepUntil<S>(until: number, state: S): Sleep<S> {
	return { _tag: "Sleep", state, until };
}

/**
 * Waits for tasks, then resumes at `state`. `on` may name tasks the waiting task does not own, with `allSettled` or
 * `any`. Pi rejects a missing task and a wait that closes a cycle.
 */
export function wait<S>(options: StrictOmit<Wait<S>, "_tag">): Wait<S> {
	return { _tag: "Wait", ...options };
}

/** Ends the task `completed` with `result`. */
export function complete<A>(result: A): End<A> {
	return { _tag: "End", outcome: { status: "completed", result } };
}

/** Ends the task `failed`: an expected failure the task decided, which aborts the work it owns. */
export function fail<A = never>(error: TaskOutcomeError, result?: A): End<A> {
	return { _tag: "End", outcome: { status: "failed", error, ...(result === undefined ? {} : { result }) } };
}

/** Ends the task `aborted`: what an abort handler decides. */
export function aborted<A = never>(reason?: string, result?: A): End<A> {
	return {
		_tag: "End",
		outcome: {
			status: "aborted",
			...(reason === undefined ? {} : { reason }),
			...(result === undefined ? {} : { result }),
		},
	};
}

/** Leaves the task's state as it is. */
export const unchanged: Unchanged = { _tag: "Unchanged" };

/** The step is committed already. */
export const committed: Committed = { _tag: "Committed" };

/** A stored checkpoint: a JSON object whose `phase` names the phase that runs next. */
export type Checkpoint = JsonObject & { phase: string };

/** How a task's state and result become the JSON Pi stores. */
export interface Encoders<S, A> {
	readonly state: (state: S) => Effect.Effect<Checkpoint, SchemaDecodeError>;
	readonly result: (result: A) => Effect.Effect<JsonValue, SchemaDecodeError>;
}

/** The state Pi's `runtime.commit` callback returns for `step`: nothing for `Unchanged`. */
export function toPi<S, A>(
	step: Step<S, A> | Unchanged,
	encoders: Encoders<S, A>,
): Effect.Effect<NextTaskState<Checkpoint, JsonValue> | undefined, SchemaDecodeError | SchemaConversionError> {
	switch (step._tag) {
		case "Unchanged":
			return Effect.succeed(undefined);
		case "Next":
			return Effect.map(encoders.state(step.state), (checkpoint) => ({ status: "running", checkpoint }));
		case "Sleep":
			return Effect.all([encoders.state(step.state), Effect.forEach(step.signals ?? [], Signal.toPiKey)]).pipe(
				Effect.map(([checkpoint, signals]) => ({
					status: "sleeping",
					checkpoint,
					...(step.until === undefined ? {} : { until: step.until }),
					...(step.signals === undefined ? {} : { signals }),
				})),
			);
		case "Wait":
			return Effect.map(encoders.state(step.state), (checkpoint) => ({
				status: "waiting",
				checkpoint,
				on: step.on,
				policy: step.policy,
			}));
		case "End":
			return Effect.map(outcomeToPi(step.outcome, encoders.result), (outcome) => ({ status: "terminal", outcome }));
	}
}

/** `outcome` with its result as stored JSON. */
function outcomeToPi<A>(
	outcome: Outcome<A>,
	encode: (result: A) => Effect.Effect<JsonValue, SchemaDecodeError>,
): Effect.Effect<Outcome<JsonValue>, SchemaDecodeError> {
	if (outcome.status === "completed") {
		return Effect.map(encode(outcome.result), (result) => ({ status: "completed", result }));
	}
	const { result, ...rest } = outcome;
	return result === undefined
		? Effect.succeed(rest)
		: Effect.map(encode(result), (stored) => ({ ...rest, result: stored }));
}
