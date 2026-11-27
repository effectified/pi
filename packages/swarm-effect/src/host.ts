// The host operations of a swarm: start it, read its status, cancel it, read its result, and release a kept fork.

import { Agent, type Doc, type DurableError, Harness, type SchemaDecodeError, Task } from "@effectified/pi-durable";
import { Array as Arr, Effect, Match, Option, Record, Schema, String as Str } from "effect";
import { Cap, Input, State } from "./coordinator.ts";
import { type Destroyed, ForkDriver, type ForkRetryLater, Place } from "./driver.ts";
import { InvalidPlan, type InvalidValue, SwarmFaulted, SwarmIdTaken, SwarmNotFound } from "./errors.ts";
import { JobKey, SwarmId } from "./ids.ts";
import { Status as JobState, planned, Reason } from "./job.ts";
import { Jobs, progressOf, Swarms } from "./ledger.ts";
import { type Outcome, type Stored, typed } from "./outcome.ts";
import type { Plan, Swarm } from "./swarm.ts";

/** What `start` answers: the swarm's coordinator task, and whether this call created it. */
export const Started = Schema.Struct({
	swarmId: SwarmId,
	taskId: Task.Id,
	/** False when a swarm of this id existed already: nothing was stored, and its own plan stands. */
	created: Schema.Boolean,
});

/** What `start` answers. */
export type Started = typeof Started.Type;

/**
 * Starts a swarm: one commit stores the coordinator task, its job statuses and the swarm id's claim on it, and the
 * Effect succeeds once that commit is stored. Idempotent by `plan.id`: a second start of the same id creates
 * nothing and answers the first one's task, whatever the second plan says.
 */
export const start: <I>(
	swarm: Swarm<I, unknown>,
	plan: Plan<I>,
) => Effect.Effect<
	Started,
	InvalidPlan | InvalidValue | SwarmIdTaken | DurableError | SchemaDecodeError,
	Harness.Harness
> = Effect.fn("Swarm.start")(function* <I>(swarm: Swarm<I, unknown>, plan: Plan<I>) {
	const flaw = flawOf(plan);
	if (Option.isSome(flaw)) return yield* InvalidPlan.make({ swarmId: plan.id, reason: flaw.value });
	// One job after the other: encoding is work on the CPU, which more fibers would not speed up.
	const jobs = yield* Effect.forEach(
		plan.jobs,
		(job) => Effect.map(swarm.work.encodeInput(job.input), (input) => ({ key: job.key, input })),
		{ concurrency: 1 },
	);
	const agent = plan.agent === undefined ? null : yield* forkAgent(plan.id, plan.agent);
	const input: typeof Input.Type = {
		swarmId: plan.id,
		jobs,
		at: plan.at ?? null,
		cap: plan.cap,
		onFailure: plan.onFailure,
		pins: plan.pins ?? [],
		agent,
	};
	return yield* Harness.commit((tx) =>
		Effect.gen(function* () {
			// Pi's rule for a commit: the table read comes before the first table write, which is the task.
			const source = yield* tx.conversation(plan.source);
			const held = yield* tx.doc(Swarms, plan.id, null);
			const claim = yield* held.get;
			if (claim.taskId !== null) {
				if (claim.name !== swarm.name) return yield* SwarmIdTaken.make({ swarmId: plan.id, heldBy: claim.name });
				return { swarmId: plan.id, taskId: claim.taskId, created: false };
			}
			if (Option.isNone(source)) {
				return yield* InvalidPlan.make({ swarmId: plan.id, reason: `No conversation ${plan.source}` });
			}
			// Background: the coordinator does not make its own source busy, and a stop of the source leaves it.
			const taskId = yield* tx.createTask(swarm.task, input, {
				ownership: { kind: "conversation" },
				conversationId: plan.source,
				background: true,
			});
			yield* held.set({ name: swarm.name, taskId, released: {} });
			const statuses = yield* tx.doc(Jobs, plan.id, null);
			yield* statuses.set(Record.fromEntries(Arr.map(plan.jobs, (job) => [job.key, progressOf(planned)] as const)));
			return { swarmId: plan.id, taskId, created: true };
		}),
	);
});

/**
 * The agent change of the forks as it is stored, every tool and extension by its name. Fails with `InvalidPlan` for a
 * change Pi's `configure` would refuse in every fork, such as `maxTurns: 0`.
 */
function forkAgent(swarmId: SwarmId, change: Agent.Change): Effect.Effect<Agent.ByName, InvalidPlan> {
	return Effect.mapError(decodeByName(Agent.byName(change)), (error) =>
		InvalidPlan.make({ swarmId, reason: `The agent change of the forks: ${error.message}` }),
	);
}

const decodeByName = Schema.decodeUnknownEffect(Agent.ByName);

/** What is wrong with a plan, if anything. Checked here because the types cannot say it. */
function flawOf(plan: Plan<unknown>): Option.Option<string> {
	const keys = Arr.map(plan.jobs, (job) => job.key);
	if (Str.isEmpty(plan.id)) return Option.some("The swarm id is empty");
	if (!isCap(plan.cap)) return Option.some(`The cap ${plan.cap} is not an integer of 1 or more`);
	if (Arr.some(keys, Str.isEmpty)) return Option.some("A job key is empty");
	if (new Set(keys).size !== keys.length) return Option.some("Two jobs have the same key");
	const stray = Arr.findFirst(plan.pins ?? [], (pin) => !Arr.contains(keys, pin));
	return Option.map(stray, (pin) => `The pin ${pin} names no job`);
}

// The coordinator's own schema of the cap: a cap a plan passes with is one its task stores.
const isCap = Schema.is(Cap);

/** One job as `status` reports it. */
export const JobReport = Schema.Struct({
	key: JobKey,
	status: JobState,
	/** Why it failed, for a failed job. */
	reason: Schema.Option(Reason),
	/**
	 * Where it runs or ran, once its fork accepted its first request and when its driver says so: the conversation in
	 * the fork's harness storage, and the actor for a fork that is one.
	 */
	ran: Schema.Option(Place),
});

/** One job as `status` reports it. */
export type JobReport = typeof JobReport.Type;

/** What `status` answers: whether the coordinator still runs, where it stands, and the jobs it planned. */
export const Status = Schema.Struct({
	swarmId: SwarmId,
	/** The definition's name. */
	name: Schema.String,
	taskId: Task.Id,
	/** True until the coordinator task has ended: also while it sleeps, and while no process runs it. */
	running: Schema.Boolean,
	/** `idle`: waiting for the source; `run`: fan-out and fan-in; `cleanup`: destroying forks; `ended`. */
	phase: Schema.Literals([...State.discriminants, "ended"]),
	/** Every job of the plan, in its order, with the status the coordinator last stored. */
	jobs: Schema.Array(JobReport),
});

/** What `status` answers. */
export type Status = typeof Status.Type;

/**
 * The probe of a swarm: committed reads only, so it starts nothing and works in a harness that was just reopened,
 * before the coordinator ran again. It fails with `SwarmNotFound` for an id nothing was started under, and with
 * `SwarmFaulted` when the coordinator's stored input or state is not this version's.
 */
export const status = Effect.fn("Swarm.status")(function* (
	swarmId: SwarmId,
): Effect.fn.Return<Status, SwarmNotFound | SwarmFaulted | Doc.Failure, Harness.Harness> {
	const { name, taskId } = yield* claimOf(swarmId);
	const found = yield* Harness.getTask(taskId);
	const record = yield* Effect.fromOption(found, () => SwarmNotFound.make({ swarmId }));
	const unreadable = (error: Schema.SchemaError) => SwarmFaulted.make({ swarmId, reason: error.message });
	const input = yield* Effect.mapError(decodeInput(record.input), unreadable);
	const stored = yield* Harness.snapshot(Jobs, swarmId);
	const statuses = Option.getOrElse(stored, () => ({}));
	const state = record.state;
	const live = state.status !== "terminal" && state.status !== "completing";
	const phase = live ? (yield* Effect.mapError(decodeState(state.checkpoint), unreadable)).phase : "ended";
	return {
		swarmId,
		name,
		taskId,
		running: state.status !== "terminal",
		phase,
		jobs: Arr.map(input.jobs, ({ key }) => {
			const progress = Option.getOrElse(Record.get(statuses, key), () => progressOf(planned));
			return {
				key,
				status: progress.status,
				reason: Option.fromNullOr(progress.reason),
				ran: Option.fromNullOr(progress.ran),
			};
		}),
	};
});

const decodeInput = Schema.decodeUnknownEffect(Input);

const decodeState = Schema.decodeUnknownEffect(State);

/**
 * Cancels a swarm, with Pi's abort of its coordinator task: nothing new starts, the live forks are cancelled, the
 * forks no pin keeps are destroyed, and the task ends with the results it had collected. The Effect succeeds once
 * the abort is durably marked, with `cancelling`, or with `ended` for a swarm that had ended already; `result` waits
 * for the end. Idempotent.
 */
export const cancel = Effect.fn("Swarm.cancel")(function* (
	swarmId: SwarmId,
): Effect.fn.Return<"cancelling" | "ended", SwarmNotFound | Doc.Failure, Harness.Harness> {
	const { taskId } = yield* claimOf(swarmId);
	const marked = yield* Harness.abortTask(taskId);
	return marked === "terminal" ? "ended" : "cancelling";
});

/**
 * The swarm's result, once its coordinator ended: it waits until then. Per job, in the order of the plan, the typed
 * value or the failure; and what became of every fork. A cancelled or failed swarm has a result too. It fails with
 * `SwarmFaulted` when the task ended without one.
 */
export const result: <A>(
	swarm: Swarm<never, A>,
	swarmId: SwarmId,
) => Effect.Effect<Outcome<A>, SwarmNotFound | SwarmFaulted | InvalidValue | Doc.Failure, Harness.Harness> = Effect.fn(
	"Swarm.result",
)(function* <A>(swarm: Swarm<never, A>, swarmId: SwarmId) {
	const { taskId } = yield* claimOf(swarmId);
	const settled = yield* Harness.waitForTaskOf(swarm.task, taskId);
	const faulted = (reason: string) => Effect.fail(SwarmFaulted.make({ swarmId, reason }));
	// A failed or a cancelled swarm ends its task with a result too; only a task Pi ended by itself has none.
	const kept = (stored: Stored | undefined, reason: string) =>
		stored === undefined ? faulted(reason) : typed(swarm.work, stored);
	return yield* Match.value(settled.state.outcome).pipe(
		Match.discriminatorsExhaustive("status")({
			completed: (outcome) => typed(swarm.work, outcome.result),
			failed: (outcome) => kept(outcome.result, outcome.error.message),
			aborted: (outcome) => kept(outcome.result, outcome.reason ?? "aborted"),
			faulted: (outcome) => faulted(outcome.error.message),
			orphaned: (outcome) => faulted(outcome.reason),
		}),
	);
});

/**
 * Destroys the fork of one job through the driver: what a janitor does with a pinned fork it no longer needs.
 * Idempotent: the bytes a first call learnt are stored and answered again, and a fork that is not there any more is
 * destroyed already.
 */
export const destroyFork = Effect.fn("Swarm.destroyFork")(function* (
	swarmId: SwarmId,
	jobKey: JobKey,
): Effect.fn.Return<Destroyed, SwarmNotFound | ForkRetryLater | Doc.Failure, Harness.Harness | ForkDriver> {
	const { released } = yield* claimOf(swarmId);
	const known = Record.get(released, jobKey);
	if (Option.isSome(known)) return { bytesWritten: Option.fromNullOr(known.value) };
	const driver = yield* ForkDriver;
	const forks = yield* driver.list(swarmId);
	const fork = Arr.findFirst(forks, (listed) => listed.jobKey === jobKey);
	if (Option.isNone(fork)) return { bytesWritten: Option.none() };
	const destroyed = yield* driver.destroy(fork.value);
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

/** The swarm id's claim: its definition, its coordinator task, and what was released. */
function claimOf(swarmId: SwarmId) {
	return Effect.flatMap(Harness.snapshot(Swarms, swarmId), (found) =>
		Effect.fromOption(
			Option.flatMap(found, (claim) =>
				claim.taskId === null ? Option.none() : Option.some({ ...claim, taskId: claim.taskId }),
			),
			() => SwarmNotFound.make({ swarmId }),
		),
	);
}
