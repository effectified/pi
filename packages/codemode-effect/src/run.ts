// A deterministic run of a script (Pi's `start`): its events and the answers to its calls as Schemas, so a host can
// keep them in a durable log, and the handle whose events are a Stream.

import type { CodemodeResult, CodemodeRunOptions } from "@earendil-works/pi-codemode/portable";
import { type Effect, Schema, type Stream } from "effect";
import type { DeliveryRejected } from "./errors.ts";

/**
 * Pi's run options, without the callbacks (they are the run's `events`) and the abort signal (the scope owns the
 * run). `startedAt` defaults to the `Clock`'s time; the run reports the value it used, which a replay passes again.
 */
export interface Options extends Omit<CodemodeRunOptions, "startedAt" | "signal" | "onStarted" | "onCall" | "onIdle"> {
	readonly startedAt?: number;
}

/**
 * The VM's own number for a call of the script, `1`, `2`, ... in the order the script made its calls: what an answer
 * names (`id`). Branded where Pi reports the call, so a result number is never passed for it.
 */
export const CallId = Schema.Int.pipe(Schema.brand("CallId"));

/** The VM's own number for a call. */
export type CallId = typeof CallId.Type;

/**
 * A call the script made (Pi's `CodemodeHostCall`): its number, whether it called a tool or a global, the name, and
 * what the script passed after a JSON round trip (for a spread global, the argument list).
 */
export const HostCall = Schema.Struct({
	id: CallId,
	target: Schema.Literals(["tool", "global"]),
	name: Schema.String,
	args: Schema.Unknown,
});

/** A call the script made. */
export type HostCall = typeof HostCall.Type;

/** How a call ended (Pi's `CodemodeOutcome`): its value, or a rejection's message and properties. */
export const Outcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
	Schema.Struct({
		ok: Schema.Literal(false),
		message: Schema.String,
		properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	}),
]);

/** How a call ended. */
export type Outcome = typeof Outcome.Type;

/**
 * Something the run reports, in the order Pi reports it. `Started`: the VM started, before the script runs and before
 * any of its calls, and `fingerprint` says what it is (engine versions, prelude, limits). `Call`: the script made a
 * call; answer it with `deliver`, now or later. `Idle`: the VM processed result `seq` (`0`: the script's first run)
 * and waits again, having issued `issued` calls. Choose with `Event.match`.
 */
export const Event = Schema.TaggedUnion({
	Started: { fingerprint: Schema.String },
	Call: { call: HostCall },
	Idle: { seq: Schema.Int, issued: Schema.Int },
});

/** Something the run reports. */
export type Event = typeof Event.Type;

/** The VM started. */
export type Started = typeof Event.cases.Started.Type;

/** The script made a call. */
export type Call = typeof Event.cases.Call.Type;

/** The VM processed a result and waits again. */
export type Idle = typeof Event.cases.Idle.Type;

/**
 * The answer to one call: result number `seq` (1, 2, ... without gaps) for call `id`. `now` is the VM's clock while it
 * processes this result, in ms since the epoch; default: the `Clock`'s time.
 */
export const Answer = Schema.Struct({
	seq: Schema.Int,
	id: CallId,
	outcome: Outcome,
	now: Schema.optionalKey(Schema.Finite),
});

/** The answer to one call. */
export type Answer = typeof Answer.Type;

/** A started run. */
export interface Run {
	/** The VM clock's start, in ms since the epoch: the option given, or the `Clock`'s time when the run started. */
	readonly startedAt: number;
	/**
	 * The run's events, ending when the run has its outcome. One consumer: each event is taken once. They wait in an
	 * unbounded buffer: Pi reports them synchronously and does not wait for the consumer, so a bounded one would lose
	 * calls.
	 */
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
