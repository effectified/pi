// A deterministic run of a script (Pi's `start`): the caller answers every call the script makes, the run's events
// are a Stream, and its clock and start time come from Effect's `Clock`.

import type {
	CodemodeHostCall,
	CodemodeOutcome,
	CodemodeResult,
	CodemodeRunOptions,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable";
import { type Cause, Clock, Effect, Queue, type Scope, Stream } from "effect";
import { DeliveryRejected, messageOf, RunRejected } from "./errors.ts";

/**
 * Pi's run options, without the callbacks (they are the run's `events`) and the abort signal (the scope owns the
 * run). `startedAt` defaults to the `Clock`'s time; the run reports the value it used, which a replay passes again.
 */
export interface Options extends Omit<CodemodeRunOptions, "startedAt" | "signal" | "onStarted" | "onCall" | "onIdle"> {
	readonly startedAt?: number;
}

/** Something the run reports, in the order Pi reports it. */
export type Event = Started | Call | Idle;

/** The VM started, before the script runs and before any of its calls: what it is (engine versions, prelude, limits). */
export interface Started {
	readonly _tag: "Started";
	readonly fingerprint: string;
}

/** The script made a call. Answer it with `deliver`, now or later. */
export interface Call {
	readonly _tag: "Call";
	readonly call: CodemodeHostCall;
}

/** The VM processed result `seq` (`0`: the script's first run) and waits again, having issued `issued` calls. */
export interface Idle {
	readonly _tag: "Idle";
	readonly seq: number;
	readonly issued: number;
}

/** The answer to one call: result number `seq` (1, 2, ... without gaps) for call `id`. */
export interface Answer {
	readonly seq: number;
	readonly id: number;
	readonly outcome: CodemodeOutcome;
	/** The VM's clock while it processes this result, in ms since the epoch. Default: the `Clock`'s time. */
	readonly now?: number;
}

/** A started run. */
export interface Run {
	/** The VM clock's start, in ms since the epoch: the option given, or the `Clock`'s time when the run started. */
	readonly startedAt: number;
	/** The run's events, ending when the run has its outcome. One consumer: each event is taken once. */
	readonly events: Stream.Stream<Event>;
	/** Waits for the run's result. A script that fails is a result with `ok: false`, not a failure. */
	readonly result: Effect.Effect<CodemodeResult>;
	/** Whether the run has its outcome; calls can no longer be answered then. The VM may still be exiting. */
	readonly finished: Effect.Effect<boolean>;
	/**
	 * Answers a call. The VM applies results strictly in `seq` order, whatever order they arrive in. Ignored once the
	 * run is finished. Fails with `DeliveryRejected` when Pi refuses the answer, which leaves the call waiting.
	 */
	readonly deliver: (answer: Answer) => Effect.Effect<void, DeliveryRejected>;
}

/** Starts `code` on Pi's sandbox as a run of the scope: closing the scope aborts it and waits for its result. */
export function start(
	sandbox: CodemodeSandboxBase,
	code: string,
	options: Options,
): Effect.Effect<Run, RunRejected, Scope.Scope> {
	return Effect.gen(function* () {
		const startedAt = options.startedAt ?? (yield* Clock.currentTimeMillis);
		const events = yield* Queue.unbounded<Event, Cause.Done>();
		const controller = new AbortController();
		const run = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					sandbox.start(code, {
						...options,
						startedAt,
						signal: controller.signal,
						onStarted: (fingerprint) => Queue.offerUnsafe(events, { _tag: "Started", fingerprint }),
						onCall: (call) => Queue.offerUnsafe(events, { _tag: "Call", call }),
						onIdle: (seq, issued) => Queue.offerUnsafe(events, { _tag: "Idle", seq, issued }),
					}),
				catch: (cause) => new RunRejected({ message: messageOf(cause) }),
			}),
			(run) =>
				Effect.promise(() => {
					controller.abort();
					return run.result;
				}),
		);
		// Pi reports every event before the result settles, so the stream ends after the last one.
		void run.result.then(() => Queue.endUnsafe(events));
		return {
			startedAt,
			events: Stream.fromQueue(events),
			result: Effect.promise(() => run.result),
			finished: Effect.sync(() => run.finished),
			deliver: (answer) =>
				Effect.flatMap(answer.now === undefined ? Clock.currentTimeMillis : Effect.succeed(answer.now), (now) =>
					Effect.try({
						try: () => run.deliver(answer.seq, now, answer.id, answer.outcome),
						catch: (cause) => new DeliveryRejected({ message: messageOf(cause) }),
					}),
				),
		};
	});
}
