// The coordinator: the durable task that runs one swarm, from the idle source through fan-out and fan-in to clean-up.

import type { WakeReason } from "@effectified/pi-durable";
import { Agent, Entry, type Signal, Task } from "@effectified/pi-durable";
import { Array as Arr, Effect, Match, Option, Order, Ref, Schedule, Schema, Stream } from "effect";
import * as Cleanup from "./cleanup.ts";
import { type Fork, ForkDriver, type ForkDriverService, type ForkRetryLater } from "./driver.ts";
import { check, MAX_ATTEMPTS, notifyKey, retryDelay, type Site, start } from "./fan-out.ts";
import { ForkSetup } from "./fork-setup.ts";
import { JobKey, SwarmId } from "./ids.ts";
import { Count, cancelled, failed, isLive, isPlanned, isSettled, Job, planned, Settled, Wait } from "./job.ts";
import { Copy, report } from "./ledger.ts";
import * as Outcome from "./outcome.ts";
import type { Work } from "./work.ts";

/**
 * How many jobs may be live at once: an integer, 1 or more, also one beyond the safe integers, as 0.2.0 took and
 * stored it. A cap above the number of jobs runs them all at once. `start` checks a plan's cap with it.
 */
export const Cap = Schema.Finite.check(
	Schema.makeFilter((cap: number) => Number.isInteger(cap), { expected: "an integer" }),
	Schema.isGreaterThanOrEqualTo(1),
);

/** What a coordinator is created with: one swarm as data. Its source is the conversation the task lives in. */
export const Input = Schema.Struct({
	swarmId: SwarmId,
	/** The jobs in the order of the plan, each input as its schema encodes it. */
	jobs: Schema.Array(Schema.Struct({ key: JobKey, input: Schema.Json })),
	/** The entry to fork at; null for the source's newest entry once it is idle. */
	at: Schema.NullOr(Entry.Id),
	cap: Cap,
	onFailure: Schema.Literals(["fail", "collect"]),
	pins: Schema.Array(JobKey),
	/** The agent change of every fork, with tools and extensions by name; null for none. */
	agent: Schema.NullOr(Agent.ByName),
});

/** Where a coordinator stands: one member per phase, each with everything the phase needs to go on. */
export const State = Schema.Union([
	/** Waiting for the source to be idle: no fork exists. */
	Schema.Struct({ phase: Schema.Literal("idle"), polls: Count }),
	/** Fan-out and fan-in: every job with its status, and the entry all forks are made at. */
	Schema.Struct({ phase: Schema.Literal("run"), at: Entry.Id, jobs: Schema.Array(Job) }),
	/** Every job settled: the forks are destroyed. `forks` is null until the driver listed them. */
	Schema.Struct({
		phase: Schema.Literal("cleanup"),
		ending: Schema.Literals(["completed", "failed"]),
		jobs: Schema.Array(Settled),
		forks: Schema.NullOr(Schema.Array(Cleanup.Disposal)),
		attempts: Count,
	}),
]).pipe(Schema.toTaggedUnion("phase"));

/**
 * The coordinator task of one definition: its result is the swarm's result, as stored. Its phases need the driver
 * and the product's fork setup, so a registry with a coordinator requires both.
 */
export interface Coordinator extends Task.Task<
	typeof Input,
	typeof State,
	typeof Outcome.Stored,
	ForkDriver | ForkSetup
> {}

/** What every coordinator's task kind starts with. */
export const TASK_PREFIX = "swarm.coordinator.";

/**
 * The coordinator of the swarms of one definition. It holds no process while it waits: for a busy source and for a
 * "retry later" it sleeps until a time, and for running jobs until the signal their driver named, or until the next
 * time to ask. Every phase may run twice (Pi runs one again after a crash or a close), and does the same then.
 */
export function coordinator(work: Work<never, unknown>): Coordinator {
	return Task.make({
		name: `${TASK_PREFIX}${work.name}`,
		version: 1,
		input: Input,
		state: State,
		result: Outcome.Stored,
		initial: () => ({ phase: "idle" as const, polls: 0 }),
		phases: {
			idle: (task, api) => unlessCopied(api, awaitIdle(task, api)),
			run: (task, api) => unlessCopied(api, fanOut(work, task, api)),
			cleanup: (task, api) => unlessCopied(api, cleanUp(task, api)),
		},
		abort: (task, api) => unlessCopied(api, cancel(task, api)),
	});
}

type In = typeof Input.Type;
type St = typeof State.Type;
type Api = Task.Api<In, St, Outcome.Stored>;
type At<P extends St["phase"]> = Task.Running<In, Extract<St, { readonly phase: P }>>;
type Step = Task.Step<St, Outcome.Stored> | Task.Committed;

/**
 * A coordinator that was copied with its storage ends at once and asks the driver nothing: its swarm, and its forks,
 * belong to the storage it was copied from (`onStorageFork`).
 */
function unlessCopied<S extends Step, E, R>(api: Api, phase: Effect.Effect<S, E, R>) {
	return Effect.flatMap(api.snapshot(Copy), (copy): Effect.Effect<S | Task.End<never>, E, R> =>
		Option.isSome(copy) && api.taskId <= copy.value.through ? Effect.succeed(Task.aborted<never>("copied")) : phase,
	);
}

// How long a phase holds its process for a source that is about to be idle, before it sleeps instead.
const IDLE_GRACE_MILLIS = 250;
// The sleep between two looks at a busy source: it doubles from the base up to the maximum.
const IDLE_POLL_BASE_MILLIS = 250;
const IDLE_POLL_MAX_MILLIS = 30_000;

/**
 * Waits for the source to be idle, then fixes the entry every fork is made at. Idle is Pi's: no live work of the
 * conversation that is not background, which the coordinator itself is. A busy source is looked at again after a
 * sleep, for as long as it is busy: only a cancel ends that.
 */
const awaitIdle = Effect.fn("Swarm.awaitIdle")(function* (task: At<"idle">, api: Api) {
	const { input, state } = task;
	// The task lives in its source, so the handle is there: without one there is nothing to wait for.
	const source = yield* api.conversation(task.conversationId);
	const idle = yield* Effect.timeoutOption(
		Option.match(source, { onNone: () => Effect.void, onSome: (handle) => handle.waitForIdle }),
		IDLE_GRACE_MILLIS,
	);
	if (Option.isNone(idle)) {
		const pause = Math.min(IDLE_POLL_BASE_MILLIS * 2 ** state.polls, IDLE_POLL_MAX_MILLIS);
		const now = yield* api.now;
		return Task.sleepUntil(now + pause, { phase: "idle" as const, polls: state.polls + 1 });
	}
	const at =
		input.at === null
			? yield* Stream.runHead(api.entries({ order: "descending", pageSize: 1 }))
			: yield* api.entry(input.at);
	if (Option.isSome(at)) {
		return Task.next({ phase: "run" as const, at: at.value.id, jobs: Arr.map(input.jobs, () => planned) });
	}
	// Pi forks at a visible entry: without one there is nothing to fork, now or later.
	const why = input.at === null ? "The source conversation is empty" : `Entry ${input.at} is not visible from it`;
	const before = Arr.map(input.jobs, () => planned);
	const jobs = Arr.map(before, () => failed(null, "gone", why));
	const outcome = Outcome.of(input.swarmId, "failed", keysOf(input), jobs, []);
	return yield* api.commit((tx) =>
		Effect.as(report(tx, input.swarmId, keysOf(input), before, jobs), Task.fail({ message: why }, outcome)),
	);
});

/**
 * One step of fan-out and fan-in: reads the running jobs that are due, starts jobs while fewer than the cap are
 * live, and stores all of it in one commit, with the sleep until the next job has something to say. At most `cap`
 * jobs are live, so at most `cap` calls of the driver run at once.
 */
const fanOut = Effect.fn("Swarm.fanOut")(function* (work: Work<never, unknown>, task: At<"run">, api: Api) {
	const { input, state } = task;
	const site: Site = {
		work,
		driver: yield* ForkDriver,
		setup: yield* ForkSetup,
		swarmId: input.swarmId,
		coordinatorTaskId: task.id,
		sourceConversationId: task.conversationId,
		at: state.at,
		agent: Option.fromNullOr(input.agent),
		now: yield* api.now,
	};
	const woken = Option.match(task.wake, { onNone: () => NOT_WOKEN, onSome: wokenFor });
	const read = yield* Effect.forEach(
		Arr.zip(input.jobs, state.jobs),
		([given, job], index) =>
			job.status === "running" && isDue(job.wait, notifyKey(index, job.correction), woken, site.now)
				? check(site, { index, ...given }, job)
				: Effect.succeed(job),
		{ concurrency: input.cap },
	);
	const failFast = input.onFailure === "fail";
	const moved = failFast && Arr.some(read, isFailed) ? read : yield* startUnderCap(site, input, read);
	const jobs = failFast && Arr.some(moved, isFailed) ? yield* stop(site, input, moved) : moved;
	const next = Arr.every(jobs, isSettled)
		? Task.next({
				phase: "cleanup" as const,
				ending: failFast && Arr.some(jobs, isFailed) ? ("failed" as const) : ("completed" as const),
				jobs,
				forks: null,
				attempts: 0,
			})
		: hasRoom(input, jobs)
			? // A job that failed as it started left its place free: the next step fills it.
				Task.next({ ...state, jobs })
			: Task.sleep({ state: { ...state, jobs }, ...sleepOf(jobs) });
	return yield* api.commit((tx) => Effect.as(report(tx, input.swarmId, keysOf(input), state.jobs, jobs), next));
});

/** What woke the task: one signal key, or the deadline of a sleep, which uses up every key the sleep listed. */
interface Woken {
	readonly key: Option.Option<string>;
	readonly expired: boolean;
}

const NOT_WOKEN: Woken = { key: Option.none(), expired: false };

/** What one of Pi's wake reasons says to the jobs. A reason Pi adds fails to compile here until it is decided. */
const wokenFor: (reason: WakeReason) => Woken = Match.type<WakeReason>().pipe(
	Match.discriminatorsExhaustive("reason")({
		signal: ({ key }): Woken => ({ key: Option.some(key), expired: false }),
		expired: (): Woken => ({ key: Option.none(), expired: true }),
		// The time of a sleep names no job: a polled job and a retry compare their own time with now. The coordinator
		// waits on no task.
		time: () => NOT_WOKEN,
		tasks: () => NOT_WOKEN,
	}),
);

/**
 * Whether a running job, waiting as `wait` under the notify key `key`, is to be read now: its signal came or can come
 * no more, or its time to ask is up.
 */
function isDue(wait: Wait, key: string, woken: Woken, now: number): boolean {
	return Wait.match(wait, {
		Signal: () => woken.expired || Option.contains(woken.key, key),
		Poll: ({ at }) => at <= now,
	});
}

const isFailed = Job.isAnyOf(["failed"]);

/** Whether a planned job could start now: fewer jobs than the cap are live. */
function hasRoom(input: In, jobs: ReadonlyArray<Job>): boolean {
	return Arr.some(jobs, isPlanned) && Arr.filter(jobs, isLive).length < input.cap;
}

/** Starts planned jobs while fewer than the cap are live, and asks again for those whose "retry later" is up. */
function startUnderCap(site: Site, input: In, jobs: ReadonlyArray<Job>): Effect.Effect<Array<Job>> {
	const free = input.cap - Arr.filter(jobs, isLive).length;
	const [, moves] = Arr.mapAccum(
		Arr.zip(input.jobs, jobs),
		free,
		(room, [given, job], index): readonly [number, Effect.Effect<Job>] => {
			if (job.status === "starting" && job.retryAt <= site.now) return [room, start(site, { index, ...given }, job)];
			if (job.status !== "planned" || room <= 0) return [room, Effect.succeed(job)];
			return [room - 1, start(site, { index, ...given }, job)];
		},
	);
	return Effect.all(moves, { concurrency: input.cap });
}

/** A job failed and the plan says `fail`: the live forks are cancelled, and every open job is settled as cancelled. */
function stop(site: Site, input: In, jobs: ReadonlyArray<Job>): Effect.Effect<Array<Settled>> {
	return Effect.as(
		cancelLive(site.driver, liveForks(site.swarmId, keysOf(input), jobs)),
		Arr.map(jobs, (job) => cancelled(job, "Another job of the swarm failed")),
	);
}

/** What a step sleeps on: the signals of the jobs that wait for one, and the earliest time a job is asked again. */
function sleepOf(jobs: ReadonlyArray<Job>): { readonly signals?: Array<Signal.Key>; readonly until?: number } {
	const signals = Arr.flatMap(jobs, (job, index) =>
		job.status === "running" && job.wait._tag === "Signal"
			? [signalKey(job.wait.signal, notifyKey(index, job.correction))]
			: [],
	);
	const times = Arr.flatMap(jobs, (job) =>
		Job.match(job, {
			starting: ({ retryAt }) => [retryAt],
			running: ({ wait }) => (wait._tag === "Poll" ? [wait.at] : []),
			planned: () => [],
			succeeded: () => [],
			failed: () => [],
		}),
	);
	return {
		...(Arr.isArrayNonEmpty(signals) ? { signals } : {}),
		...(Arr.isArrayNonEmpty(times) ? { until: Arr.min(times, Order.Number) } : {}),
	};
}

/**
 * The key of one wait for the signal named `signal`. A sleep stores the name and the key, which is all Pi's key is,
 * so a signal the driver names needs no definition here.
 */
function signalKey(signal: string, key: string): Signal.Key {
	const token = { name: signal, version: 1, key: (wait: string) => ({ signal, key: wait }) };
	return { signal: { token: Effect.succeed(token) }, key };
}

/**
 * Destroys the forks no pin keeps, then ends the task with the swarm's result. The driver's list is what is cleaned
 * up, so a fork whose creation the coordinator never saw return is destroyed too. A "retry later" is a sleep; when
 * the attempts run out, the forks still pending are left, and the result says so.
 */
const cleanUp = Effect.fn("Swarm.cleanUpPhase")(function* (task: At<"cleanup">, api: Api) {
	const { input, state } = task;
	const driver = yield* ForkDriver;
	const now = yield* api.now;
	const exhausted = state.attempts + 1 >= MAX_ATTEMPTS;
	// Every fork still pending said "retry later": the next pass waits for the longest of their delays, whichever call
	// answered first, so it asks none of them early.
	const later = (errors: Arr.NonEmptyReadonlyArray<ForkRetryLater>, forks: ReadonlyArray<Cleanup.Disposal> | null) =>
		Task.sleepUntil(
			now +
				Arr.max(
					Arr.map(errors, (error) => retryDelay(error, state.attempts)),
					Order.Number,
				),
			{
				...state,
				forks,
				attempts: state.attempts + 1,
			},
		);
	const end = (disposals: ReadonlyArray<Cleanup.Disposal>): Step => {
		const outcome = Outcome.of(input.swarmId, state.ending, keysOf(input), state.jobs, Cleanup.fates(disposals));
		return state.ending === "completed"
			? Task.complete(outcome)
			: Task.fail({ message: `A job of swarm ${input.swarmId} failed` }, outcome);
	};
	const destroy = (disposals: ReadonlyArray<Cleanup.Disposal>) =>
		Effect.map(Cleanup.pass(driver, input.swarmId, disposals, input.cap), (passed): Step =>
			Arr.isReadonlyArrayNonEmpty(passed.retries) && !exhausted
				? later(passed.retries, passed.disposals)
				: end(passed.disposals),
		);
	if (state.forks !== null) return yield* destroy(state.forks);
	return yield* Effect.matchEffect(driver.list(input.swarmId), {
		onSuccess: (forks) => destroy(Cleanup.plan(forks, input.pins)),
		onFailure: (error) =>
			exhausted
				? destroy(Cleanup.plan(Cleanup.named(input.swarmId, keysOf(input), state.jobs), input.pins))
				: Effect.succeed(later([error], null)),
	});
});

// What a cancel does in its one invocation, where Pi allows no sleep: a few tries in a row, a doubling pause between.
const CANCEL_TRIES = 4;
const CANCEL_PAUSE_MILLIS = 100;

/**
 * Pi's abort of the task, which is how a swarm is cancelled: the live forks are cancelled, every open job is settled
 * as cancelled, the forks no pin keeps are destroyed, and the task ends `aborted` with the swarm's result. Pi allows
 * an abort handler no sleep, so a driver that says "retry later" is asked a few times in a row, and a fork that
 * still cannot be destroyed is left, as the result says.
 */
const cancel = Effect.fn("Swarm.cancelPhase")(function* (task: Task.Running<In, St>, api: Api) {
	const { input, state } = task;
	const driver = yield* ForkDriver;
	const keys = keysOf(input);
	const before: ReadonlyArray<Job> = State.match(state, {
		idle: () => Arr.map(input.jobs, () => planned),
		run: ({ jobs }) => jobs,
		cleanup: ({ jobs }) => jobs,
	});
	yield* cancelLive(driver, liveForks(input.swarmId, keys, before));
	const jobs = Arr.map(before, (job) => cancelled(job, "The swarm was cancelled"));
	const listed = state.phase === "cleanup" ? Option.fromNullOr(state.forks) : Option.none();
	const disposals = yield* Option.match(listed, {
		onSome: (forks) => Effect.succeed(forks),
		onNone: () =>
			Effect.map(
				Effect.orElseSucceed(patiently(driver.list(input.swarmId)), () =>
					Cleanup.named(input.swarmId, keys, before),
				),
				(forks) => Cleanup.plan(forks, input.pins),
			),
	});
	const destroyed = yield* destroyInARow(driver, input.swarmId, disposals, input.cap);
	const outcome = Outcome.of(input.swarmId, "cancelled", keys, jobs, Cleanup.fates(destroyed));
	return yield* api.commit((tx) =>
		Effect.as(report(tx, input.swarmId, keys, before, jobs), Task.aborted("cancelled", outcome)),
	);
});

/**
 * Passes over the forks of a cancelled swarm until none is pending: at most `CANCEL_TRIES` passes, the pause between
 * two doubling from `CANCEL_PAUSE_MILLIS`. Each pass starts from what the one before left, `cap` forks at a time.
 */
export function destroyInARow(
	driver: ForkDriverService,
	swarmId: SwarmId,
	disposals: ReadonlyArray<Cleanup.Disposal>,
	cap: number,
): Effect.Effect<ReadonlyArray<Cleanup.Disposal>> {
	return Effect.flatMap(Ref.make(disposals), (left) =>
		Ref.get(left).pipe(
			Effect.flatMap((remaining) => Cleanup.pass(driver, swarmId, remaining, cap)),
			Effect.tap((passed) => Ref.set(left, passed.disposals)),
			Effect.repeat({
				schedule: Schedule.exponential(CANCEL_PAUSE_MILLIS),
				times: CANCEL_TRIES - 1,
				while: (passed) => Arr.isReadonlyArrayNonEmpty(passed.retries),
			}),
			Effect.map((passed) => passed.disposals),
		),
	);
}

/** The forks of the jobs that have not settled, as far as their forks are known. */
function liveForks(swarmId: SwarmId, keys: ReadonlyArray<JobKey>, jobs: ReadonlyArray<Job>): Array<Fork> {
	return Arr.flatMap(Arr.zip(keys, jobs), ([jobKey, job]) =>
		isLive(job) && job.fork !== null ? [{ swarmId, jobKey, forkId: job.fork }] : [],
	);
}

/**
 * Stops the work of these forks, all at once: they are the live ones, so at most the cap. One the driver cannot reach
 * now is left to clean-up, which destroys it.
 */
function cancelLive(driver: ForkDriverService, forks: ReadonlyArray<Fork>): Effect.Effect<void> {
	return Effect.forEach(forks, (fork) => Effect.ignore(patiently(driver.cancel(fork))), {
		concurrency: "unbounded",
		discard: true,
	});
}

/** `call`, made again a few times in a row while the driver says "retry later". */
function patiently<A>(call: Effect.Effect<A, ForkRetryLater>): Effect.Effect<A, ForkRetryLater> {
	return Effect.retry(call, { times: CANCEL_TRIES - 1, schedule: Schedule.exponential(CANCEL_PAUSE_MILLIS) });
}

function keysOf(input: In): Array<JobKey> {
	return Arr.map(input.jobs, (job) => job.key);
}
