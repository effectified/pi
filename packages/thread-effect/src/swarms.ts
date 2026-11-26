// The swarm service: run a swarm from a thread, cancel it, probe it with its job keys, read what each job spent, and
// destroy a kept fork.

import { type Doc, type DurableError, Harness, type SchemaDecodeError } from "@effectified/pi-durable";
import { Recorder } from "@effectified/pi-recorder";
import * as Swarm from "@effectified/pi-swarm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { ThreadNotFound } from "./errors.ts";
import * as ForkSetup from "./fork-setup.ts";
import * as Forks from "./forks.ts";
import * as Thread from "./thread.ts";

/**
 * One swarm as a product plans it: `Swarm.Plan`, with the primed thread by its key, and with what each of its forks
 * may do and spend. Of `agent`, the change applied to every fork, the tools are narrowed by the allowance and by the
 * thread's grant, and the review is taken out of the selection of extensions by the fork setup.
 */
export interface Plan<I> extends Omit<Swarm.Plan<I>, "source"> {
	/** The key of the primed thread: every job runs in a fork of its conversation. */
	readonly thread: string;
	/** The tools a fork may call at most, and the micro units it may settle of the harness's lease. */
	readonly fork: ForkSetup.Allowance;
}

/** What `probe` answers: whether the coordinator still runs, and the keys of the jobs it planned, in plan order. */
export interface Probe {
	readonly alive: boolean;
	readonly jobKeys: ReadonlyArray<string>;
}

/** What one job of a swarm settled of the lease. */
export interface JobSpend {
	readonly key: string;
	/**
	 * What the budget settled for the job's fork, in micro units: its requests, corrections included. None for a job
	 * whose fork accepted no request yet, and for a fork whose storage cannot be read now (`Forks.Accounts`).
	 */
	readonly settledMicros: Option.Option<bigint>;
}

/** The operations on swarms and their forks, in the shape of a product's ports to its swarm runtime. */
export interface Service {
	/**
	 * Starts a swarm on the primed thread and succeeds once its coordinator is stored. Idempotent by `plan.id`:
	 * `created` is false for a swarm that existed, and the first plan and its allowance stand. Each fork is granted,
	 * capped and left out of the review in the commit that creates it (see `ForkSetup.layer`). The swarm's id is kept
	 * with its thread, so the thread's money includes its forks.
	 */
	readonly run: <I>(
		swarm: Swarm.Swarm<I, unknown>,
		plan: Plan<I>,
	) => Effect.Effect<
		Swarm.Started,
		ThreadNotFound | Swarm.InvalidPlan | Swarm.InvalidValue | Swarm.SwarmIdTaken | DurableError | SchemaDecodeError
	>;
	/** Cancels a swarm: `cancelling` once the abort is durably marked, `ended` for one that had ended. Idempotent. */
	readonly cancel: (swarmId: string) => Effect.Effect<"cancelling" | "ended", Swarm.SwarmNotFound | Doc.Failure>;
	/** The probe of a swarm, from committed reads only: it starts nothing and works right after a reopen. */
	readonly probe: (swarmId: string) => Effect.Effect<Probe, Swarm.SwarmNotFound | Swarm.SwarmFaulted | Doc.Failure>;
	/**
	 * What each job of the swarm settled so far, in plan order: while it runs and after it ended. The same money is
	 * part of the `settledMicros` of the thread the swarm ran on, wherever the forks live.
	 */
	readonly spent: (
		swarmId: string,
	) => Effect.Effect<ReadonlyArray<JobSpend>, Swarm.SwarmNotFound | Swarm.SwarmFaulted | Doc.Failure>;
	/**
	 * The swarm's typed result, once its coordinator ended: it waits until then, and returns once the records of
	 * everything its forks committed in this harness storage are in the sink.
	 */
	readonly result: <A>(
		swarm: Swarm.Swarm<never, A>,
		swarmId: string,
	) => Effect.Effect<
		Swarm.Outcome<A>,
		Swarm.SwarmNotFound | Swarm.SwarmFaulted | Swarm.InvalidValue | Recorder.Failure
	>;
	/**
	 * The swarm's result as its coordinator stored it, with every job's value in its JSON form (`Swarm.typed` decodes
	 * it); none while the swarm runs. It never waits: what a host that cannot hold a call open asks.
	 */
	readonly stored: (
		swarmId: string,
	) => Effect.Effect<Option.Option<Swarm.Stored>, Swarm.SwarmNotFound | Swarm.SwarmFaulted | Recorder.Failure>;
	/**
	 * Destroys the fork of one job, a pinned one included, and answers what it wrote as its driver measures it: for
	 * a fork that is a conversation of this storage, the bytes of the UTF-8 JSON of the entries it appended after
	 * its fork point (nothing is freed: Pi cannot delete a conversation); for one that is an actor, the growth of
	 * its database over its source's. None for a fork that was gone or never made.
	 */
	readonly destroyFork: (
		swarmId: string,
		jobKey: string,
	) => Effect.Effect<
		{ readonly bytesWritten: Option.Option<number> },
		Swarm.SwarmNotFound | Swarm.ForkRetryLater | Doc.Failure
	>;
}

/** The swarm operations of the composed harness. */
export class Swarms extends Context.Service<Swarms, Service>()("@effectified/pi-thread/Swarms") {}

/** What the operations run on: the open harness, the fork driver and its accounts, and the recorder's pump. */
type Composed = Harness.Harness | Swarm.ForkDriver | Forks.Accounts | Recorder.Recorder;

/** The swarm operations on the harness, the fork driver, its accounts and the recorder of the context. */
export const layer: Layer.Layer<Swarms, never, Composed> = Layer.effect(
	Swarms,
	Effect.map(Effect.context<Composed>(), (composed) => {
		const here = <A, E>(effect: Effect.Effect<A, E, Composed>): Effect.Effect<A, E> =>
			Effect.provide(effect, composed);
		return {
			run: (swarm, { thread, fork, ...plan }) =>
				here(
					Effect.gen(function* () {
						const source = yield* Thread.find(thread);
						// Before the swarm exists: its first fork finds the allowance, the thread's money counts its
						// forks from the first one, and a start that is cut off after this commit is completed by the
						// next call.
						yield* Harness.commit((tx) =>
							Effect.andThen(Thread.noteSwarmIn(tx, thread, plan.id), ForkSetup.allowIn(tx, plan.id, fork)),
						);
						return yield* Swarm.start(swarm, { ...plan, source });
					}),
				),
			cancel: (swarmId) => here(Swarm.cancel(swarmId)),
			probe: (swarmId) =>
				here(
					Effect.map(Swarm.status(swarmId), (status) => ({
						alive: status.running,
						jobKeys: status.jobs.map((job) => job.key),
					})),
				),
			spent: (swarmId) =>
				here(
					Effect.gen(function* () {
						const accounts = yield* Forks.Accounts;
						const status = yield* Swarm.status(swarmId);
						return yield* Effect.forEach(status.jobs, (job) =>
							Effect.map(accounts.spent(swarmId, job), (settledMicros) => ({ key: job.key, settledMicros })),
						);
					}),
				),
			result: (swarm, swarmId) => here(Effect.tap(Swarm.result(swarm, swarmId), () => Recorder.flushAll)),
			stored: (swarmId) => here(Effect.tap(storedOf(swarmId), () => Recorder.flushAll)),
			destroyFork: (swarmId, jobKey) => here(Swarm.destroyFork(swarmId, jobKey)),
		};
	}),
);

/**
 * `Service.stored`: the result of the coordinator's task as it is stored, read without waiting for the task. A swarm
 * that completed, failed or was cancelled has one; a task Pi ended without one faulted, as `Swarm.result` says.
 */
function storedOf(
	swarmId: string,
): Effect.Effect<Option.Option<Swarm.Stored>, Swarm.SwarmNotFound | Swarm.SwarmFaulted | Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const status = yield* Swarm.status(swarmId);
		if (status.running) return Option.none();
		const task = yield* Harness.getTask(status.taskId);
		const outcome = Option.getOrUndefined(task)?.state.outcome;
		const faulted = (reason: string) => new Swarm.SwarmFaulted({ swarmId, reason });
		if (outcome === undefined) return yield* faulted("The coordinator's task has no outcome");
		switch (outcome.status) {
			case "completed":
			case "failed":
			case "aborted": {
				if (outcome.result === undefined) {
					return yield* faulted(
						outcome.status === "failed" ? outcome.error.message : (outcome.reason ?? "aborted"),
					);
				}
				// Stored input: the task's result as Pi kept it, which is JSON of the swarm's own schema.
				return Option.some(yield* Effect.mapError(decodeStored(outcome.result), (error) => faulted(error.message)));
			}
			case "faulted":
				return yield* faulted(outcome.error.message);
			case "orphaned":
				return yield* faulted(outcome.reason);
		}
	});
}

const decodeStored = Schema.decodeUnknownEffect(Swarm.Stored);
