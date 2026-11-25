// The host operations of a swarm: start it, read its status, cancel it, read its result, and release a kept fork.

import type { TaskId } from "@earendil-works/pi-durable";
import { type Doc, type DurableError, Harness, type SchemaDecodeError } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";
import { Input, State } from "./coordinator.ts";
import { type Destroyed, ForkDriver, type ForkRetryLater, type Place } from "./driver.ts";
import { InvalidPlan, type InvalidValue, SwarmFaulted, SwarmIdTaken, SwarmNotFound } from "./errors.ts";
import { type Status as JobStatus, planned, type Reason } from "./job.ts";
import { Jobs, type Progress, progressOf, Swarms } from "./ledger.ts";
import { type Outcome, typed } from "./outcome.ts";
import { named, type Plan, type Swarm } from "./swarm.ts";

/** What `start` answers: the swarm's coordinator task, and whether this call created it. */
export interface Started {
	readonly swarmId: string;
	readonly taskId: TaskId;
	/** False when a swarm of this id existed already: nothing was stored, and its own plan stands. */
	readonly created: boolean;
}

/**
 * Starts a swarm: one commit stores the coordinator task, its job statuses and the swarm id's claim on it, and the
 * Effect succeeds once that commit is stored. Idempotent by `plan.id`: a second start of the same id creates
 * nothing and answers the first one's task, whatever the second plan says.
 */
export function start<I>(
	swarm: Swarm<I, unknown>,
	plan: Plan<I>,
): Effect.Effect<
	Started,
	InvalidPlan | InvalidValue | SwarmIdTaken | DurableError | SchemaDecodeError,
	Harness.Harness
> {
	return Effect.gen(function* () {
		yield* Option.match(flawOf(plan), {
			onNone: () => Effect.void,
			onSome: (reason) => Effect.fail(new InvalidPlan({ swarmId: plan.id, reason })),
		});
		const jobs = yield* Effect.forEach(plan.jobs, (job) =>
			Effect.map(swarm.work.encodeInput(job.input), (input) => ({ key: job.key, input })),
		);
		const input: typeof Input.Type = {
			swarmId: plan.id,
			jobs,
			at: plan.at ?? null,
			cap: plan.cap,
			onFailure: plan.onFailure,
			pins: plan.pins ?? [],
			agent: plan.agent === undefined ? null : named(plan.agent),
		};
		return yield* Harness.commit((tx) =>
			Effect.gen(function* () {
				// Pi's rule for a commit: the table read comes before the first table write, which is the task.
				const source = yield* tx.conversation(plan.source);
				const held = yield* tx.doc(Swarms, plan.id, null);
				const claim = yield* held.get;
				if (claim.taskId !== null) {
					if (claim.name !== swarm.name) return yield* new SwarmIdTaken({ swarmId: plan.id, heldBy: claim.name });
					// Pi brands ids in the type system only: a stored task id is the number.
					return { swarmId: plan.id, taskId: claim.taskId as TaskId, created: false };
				}
				if (Option.isNone(source)) {
					return yield* new InvalidPlan({ swarmId: plan.id, reason: `No conversation ${plan.source}` });
				}
				// Background: the coordinator does not make its own source busy, and a stop of the source leaves it.
				const taskId = yield* tx.createTask(swarm.task, input, {
					ownership: { kind: "conversation" },
					conversationId: plan.source,
					background: true,
				});
				yield* held.set({ name: swarm.name, taskId, released: {} });
				const statuses = yield* tx.doc(Jobs, plan.id, null);
				yield* statuses.set(Object.fromEntries(plan.jobs.map((job) => [job.key, progressOf(planned)])));
				return { swarmId: plan.id, taskId, created: true };
			}),
		);
	});
}

/** What is wrong with a plan, if anything. Checked here because the types cannot say it. */
function flawOf(plan: Plan<unknown>): Option.Option<string> {
	const keys = plan.jobs.map((job) => job.key);
	if (plan.id === "") return Option.some("The swarm id is empty");
	if (!Number.isInteger(plan.cap) || plan.cap < 1)
		return Option.some(`The cap ${plan.cap} is not an integer of 1 or more`);
	if (keys.includes("")) return Option.some("A job key is empty");
	if (new Set(keys).size !== keys.length) return Option.some("Two jobs have the same key");
	const stray = (plan.pins ?? []).find((pin) => !keys.includes(pin));
	return stray === undefined ? Option.none() : Option.some(`The pin ${stray} names no job`);
}

/** One job as `status` reports it. */
export interface JobReport {
	readonly key: string;
	readonly status: JobStatus;
	/** Why it failed, for a failed job. */
	readonly reason: Option.Option<Reason>;
	/**
	 * Where it runs or ran, once its fork accepted its first request and when its driver says so: the conversation in
	 * the fork's harness storage, and the actor for a fork that is one.
	 */
	readonly ran: Option.Option<Place>;
}

/** What `status` answers: whether the coordinator still runs, where it stands, and the jobs it planned. */
export interface Status {
	readonly swarmId: string;
	/** The definition's name. */
	readonly name: string;
	readonly taskId: TaskId;
	/** True until the coordinator task has ended: also while it sleeps, and while no process runs it. */
	readonly running: boolean;
	/** `idle`: waiting for the source; `run`: fan-out and fan-in; `cleanup`: destroying forks; `ended`. */
	readonly phase: "idle" | "run" | "cleanup" | "ended";
	/** Every job of the plan, in its order, with the status the coordinator last stored. */
	readonly jobs: ReadonlyArray<JobReport>;
}

/**
 * The probe of a swarm: committed reads only, so it starts nothing and works in a harness that was just reopened,
 * before the coordinator ran again. It fails with `SwarmNotFound` for an id nothing was started under, and with
 * `SwarmFaulted` when the coordinator's stored input or state is not this version's.
 */
export function status(
	swarmId: string,
): Effect.Effect<Status, SwarmNotFound | SwarmFaulted | Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const { name, taskId } = yield* claimOf(swarmId);
		const record = yield* Effect.flatMap(Harness.getTask(taskId), notFound(swarmId));
		const unreadable = (error: Schema.SchemaError) => new SwarmFaulted({ swarmId, reason: error.message });
		const input = yield* Effect.mapError(decodeInput(record.input), unreadable);
		const statuses = Option.getOrElse(
			yield* Harness.snapshot(Jobs, swarmId),
			(): Readonly<Record<string, Progress>> => ({}),
		);
		const state = record.state;
		const live = state.status !== "terminal" && state.status !== "completing";
		return {
			swarmId,
			name,
			taskId,
			running: state.status !== "terminal",
			phase: live ? (yield* Effect.mapError(decodeState(state.checkpoint), unreadable)).phase : "ended",
			jobs: input.jobs.map(({ key }) => {
				const progress = Object.hasOwn(statuses, key) ? statuses[key] : progressOf(planned);
				return {
					key,
					status: progress.status,
					reason: Option.fromNullOr(progress.reason),
					ran: Option.fromNullOr(progress.ran),
				};
			}),
		};
	});
}

const decodeInput = Schema.decodeUnknownEffect(Input);

const decodeState = Schema.decodeUnknownEffect(State);

/**
 * Cancels a swarm, with Pi's abort of its coordinator task: nothing new starts, the live forks are cancelled, the
 * forks no pin keeps are destroyed, and the task ends with the results it had collected. The Effect succeeds once
 * the abort is durably marked, with `cancelling`, or with `ended` for a swarm that had ended already; `result` waits
 * for the end. Idempotent.
 */
export function cancel(
	swarmId: string,
): Effect.Effect<"cancelling" | "ended", SwarmNotFound | Doc.Failure, Harness.Harness> {
	return Effect.flatMap(claimOf(swarmId), ({ taskId }) =>
		Effect.map(Harness.abortTask(taskId), (marked) => (marked === "terminal" ? "ended" : "cancelling")),
	);
}

/**
 * The swarm's result, once its coordinator ended: it waits until then. Per job, in the order of the plan, the typed
 * value or the failure; and what became of every fork. A cancelled or failed swarm has a result too. It fails with
 * `SwarmFaulted` when the task ended without one.
 */
export function result<A>(
	swarm: Swarm<never, A>,
	swarmId: string,
): Effect.Effect<Outcome<A>, SwarmNotFound | SwarmFaulted | InvalidValue | Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const { taskId } = yield* claimOf(swarmId);
		const outcome = (yield* Harness.waitForTaskOf(swarm.task, taskId)).state.outcome;
		switch (outcome.status) {
			case "completed":
				return yield* typed(swarm.work, outcome.result);
			case "failed":
			case "aborted": {
				const reason = outcome.status === "failed" ? outcome.error.message : (outcome.reason ?? "aborted");
				return yield* Option.match(Option.fromUndefinedOr(outcome.result), {
					onNone: () => Effect.fail(new SwarmFaulted({ swarmId, reason })),
					onSome: (stored) => typed(swarm.work, stored),
				});
			}
			case "faulted":
				return yield* new SwarmFaulted({ swarmId, reason: outcome.error.message });
			case "orphaned":
				return yield* new SwarmFaulted({ swarmId, reason: outcome.reason });
		}
	});
}

/**
 * Destroys the fork of one job through the driver: what a janitor does with a pinned fork it no longer needs.
 * Idempotent: the bytes a first call learnt are stored and answered again, and a fork that is not there any more is
 * destroyed already.
 */
export function destroyFork(
	swarmId: string,
	jobKey: string,
): Effect.Effect<Destroyed, SwarmNotFound | ForkRetryLater | Doc.Failure, Harness.Harness | ForkDriver> {
	return Effect.gen(function* () {
		const { released } = yield* claimOf(swarmId);
		if (Object.hasOwn(released, jobKey)) return { bytesWritten: Option.fromNullOr(released[jobKey]) };
		const driver = yield* ForkDriver;
		const fork = (yield* driver.list(swarmId)).find((listed) => listed.jobKey === jobKey);
		if (fork === undefined) return { bytesWritten: Option.none() };
		const destroyed = yield* driver.destroy(fork);
		yield* Harness.commit((tx) =>
			Effect.flatMap(tx.doc(Swarms, swarmId, null), (held) =>
				held.update((claim) => ({
					...claim,
					released: { ...claim.released, [jobKey]: Option.getOrNull(destroyed.bytesWritten) },
				})),
			),
		);
		return destroyed;
	});
}

/** The swarm id's claim: its definition, its coordinator task, and what was released. */
function claimOf(swarmId: string) {
	return Effect.flatMap(Harness.snapshot(Swarms, swarmId), (found) =>
		Option.match(found, {
			onNone: () => Effect.fail(new SwarmNotFound({ swarmId })),
			onSome: (claim) =>
				claim.taskId === null
					? Effect.fail(new SwarmNotFound({ swarmId }))
					: // Pi brands ids in the type system only: a stored task id is the number.
						Effect.succeed({ ...claim, taskId: claim.taskId as TaskId }),
		}),
	);
}

function notFound(swarmId: string) {
	return <A>(found: Option.Option<A>): Effect.Effect<A, SwarmNotFound> =>
		Option.match(found, { onNone: () => Effect.fail(new SwarmNotFound({ swarmId })), onSome: Effect.succeed });
}
