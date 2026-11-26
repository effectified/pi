// The outcome courier: the durable task that delivers a thread's outcome events, so a pending delivery is work of the
// harness itself, which a host holds its process awake for and wakes it up for.

import { Extension, Signal, Task } from "@effectified/pi-durable";
import { Context, Deferred, Effect, Layer, Schema } from "effect";

/** What a courier is created with: the thread whose events it delivers. */
export const Input = Schema.Struct({ thread: Schema.String });

/**
 * Where a courier stands. It has one phase, which runs again after every wake:
 *
 * - `turn`: the number of the step, raised by every step, so no step leaves the state as it was and every sleep has a
 *   signal key of its own (`key`).
 * - `failures`: the delivery attempts that failed in a row, which the retry schedule is asked with.
 */
export const State = Schema.Struct({
	phase: Schema.Literal("deliver"),
	turn: Schema.Number,
	failures: Schema.Number,
});

/** The courier's own type: its phase needs the `Delivery` of the composition. */
export interface Courier extends Task.Task<typeof Input, typeof State, typeof Schema.Null, Delivery> {}

/** A courier as its phase gets it. */
export type Running = Task.Running<typeof Input.Type, typeof State.Type>;

/** What a courier's phase may use beside its task. */
export type Api = Task.Api<typeof Input.Type, typeof State.Type, null>;

/** What the phase of a courier returns. */
export type Step = Task.Step<typeof State.Type, null> | Task.Committed;

/**
 * What a courier's phase does, given on the open harness (`Outcomes.layer`). The registry that installs the courier is
 * built before the harness, and the delivery needs the harness and what is built on it: a courier Pi resumes as the
 * harness opens waits here until the delivery is given. It never fails: a failure would end the task for good.
 */
export class Delivery extends Context.Service<
	Delivery,
	Deferred.Deferred<(task: Running, api: Api) => Effect.Effect<Step>>
>()("@effectified/pi-thread/OutcomeCourier/Delivery") {}

/** The place the delivery is given to: provide it under the registry. */
export const holder: Layer.Layer<Delivery> = Layer.effect(
	Delivery,
	Deferred.make<(task: Running, api: Api) => Effect.Effect<Step>>(),
);

/** Wakes a courier that sleeps because it had nothing to deliver, or until its next attempt. It carries nothing. */
export const Nudge = Signal.make("thread.outcomes.nudge", 1, Schema.Null);

/** The signal key the courier sleeps on after the step `turn`. Pi takes a key for one wait only. */
export function key(turn: number): string {
	return String(turn);
}

/**
 * The courier of one thread, a background task of the thread's conversation. It delivers the thread's events in
 * order, one at a time, and sleeps in between, holding no process: on a signal while nothing is due, until a time
 * when an attempt failed. It ends once the thread's newest submission settled and everything was delivered; a thread
 * that is taken on again gets a new one. A cancel of the thread does not abort it: it delivers `Cancelled`.
 */
export const task: Courier = Task.make({
	name: "thread.outcomes",
	version: 1,
	input: Input,
	state: State,
	result: Schema.Null,
	initial: () => ({ phase: "deliver" as const, turn: 0, failures: 0 }),
	phases: {
		deliver: (running, api) =>
			Delivery.use((delivery) => Effect.flatMap(Deferred.await(delivery), (deliver) => deliver(running, api))),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

/**
 * The extension that installs the courier, named `thread`. No tool and no hook, so its place among the extensions
 * does not matter. It makes the registry require `Delivery`, which `holder` provides.
 */
export const extension = Extension.make({ name: "thread", tasks: [task] });
