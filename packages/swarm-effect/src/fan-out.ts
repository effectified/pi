// Fan-out: one job moved forward through the driver, with every answer of the driver folded into the job's state.

import type { Agent, ConversationId, EntryId, TaskId } from "@effectified/pi-durable";
import { Effect, type Option, Result, type Schema } from "effect";
import {
	type Fork,
	type ForkDriverService,
	ForkFailure,
	type ForkRetryLater,
	JobStatus,
	Notice,
	type Place,
} from "./driver.ts";
import type { InvalidValue } from "./errors.ts";
import type { ForkSetupService } from "./fork-setup.ts";
import { type ForkId, type JobKey, RequestId, type SwarmId } from "./ids.ts";
import { failed, type Job, type Planned, Running, type Starting, Wait } from "./job.ts";
import type { Work } from "./work.ts";

/**
 * Where a job is moved: its swarm, its coordinator, the primed source, the driver, the product's fork setup, and the
 * harness clock now.
 */
export interface Site {
	readonly work: Pick<Work<never, unknown>, "corrections" | "promptOf" | "read" | "correctionOf">;
	readonly driver: ForkDriverService;
	readonly setup: ForkSetupService;
	readonly swarmId: SwarmId;
	readonly coordinatorTaskId: TaskId;
	readonly sourceConversationId: ConversationId;
	readonly at: EntryId;
	readonly agent: Option.Option<Agent.ByName>;
	readonly now: number;
}

/** One job of the plan: its place in it, its key, and its input as stored. */
export interface PlanJob {
	readonly index: number;
	readonly key: JobKey;
	readonly input: Schema.Json;
}

/** The signal key the coordinator sleeps on for one request of one job: unique in the coordinator's task. */
export function notifyKey(index: number, correction: number): string {
	return `${index}.${correction}`;
}

/**
 * Starts a job, or tries again: its fork, found or made, then the job in it. Both calls are idempotent by key, so a
 * phase that runs again makes no second fork and asks no second time.
 */
export const start = Effect.fn("Swarm.startJob")(function* (
	site: Site,
	planned: PlanJob,
	job: typeof Planned.Type | typeof Starting.Type,
): Effect.fn.Return<Job> {
	const before: Tries = job.status === "starting" ? job : { attempts: 0, busy: 0 };
	const known = job.status === "starting" ? job.fork : null;
	const prompt = yield* Effect.result(site.work.promptOf(planned.input, { swarmId: site.swarmId, key: planned.key }));
	if (Result.isFailure(prompt)) return failed(known, "invalid-input", prompt.failure.issues);
	const fork = yield* Effect.result(
		known === null
			? site.driver.fork({
					swarmId: site.swarmId,
					jobKey: planned.key,
					coordinatorTaskId: site.coordinatorTaskId,
					sourceConversationId: site.sourceConversationId,
					at: site.at,
					agent: site.agent,
					setup: site.setup,
				})
			: Effect.succeed(forkOf(site, planned.key, known)),
	);
	if (Result.isFailure(fork)) return refused(site, fork.failure, known, before);
	const made = fork.success;
	const accepted = yield* Effect.result(request(site, planned, made, 0, prompt.success));
	return Result.match(accepted, {
		onFailure: (error) => refused(site, error, made.forkId, before),
		onSuccess: (notice) => running(site, made.forkId, 0, notice, null),
	});
});

/**
 * Reads a running job whose signal came or whose time is up: it stays running, succeeds with a decoded result, is
 * asked for a correction, or fails.
 */
export const check = Effect.fn("Swarm.readJob")(function* (
	site: Site,
	planned: PlanJob,
	job: typeof Running.Type,
): Effect.fn.Return<Job> {
	const fork = forkOf(site, planned.key, job.fork);
	const status = yield* Effect.result(site.driver.job(fork, requestIdOf(site, planned.key, job.correction)));
	if (Result.isFailure(status)) return unread(site, status.failure, job);
	return yield* JobStatus.match(status.success, {
		// Its signal is used up, or its time came: from here on the driver is asked.
		Running: (): Effect.Effect<Job> => Effect.succeed({ ...job, attempts: 0, wait: again(site, job.wait) }),
		Unknown: () =>
			Effect.succeed(failed(job.fork, "gone", "The fork holds no job under the request it accepted", job.ran)),
		Unanswered: ({ reason }) => Effect.succeed(failed(job.fork, "unanswered", reason, job.ran)),
		Answered: ({ text }) =>
			Effect.matchEffect(site.work.read(text), {
				onSuccess: (value): Effect.Effect<Job> =>
					Effect.succeed({ status: "succeeded", fork: job.fork, value, ran: job.ran }),
				onFailure: (invalid) => correct(site, planned, job, fork, invalid),
			}),
	});
});

/** The fork of a job, as the driver takes it. */
function forkOf(site: Site, key: JobKey, forkId: ForkId): Fork {
	return { swarmId: site.swarmId, jobKey: key, forkId };
}

// Waits are in milliseconds on the harness clock. A "retry later" without a hint of its own doubles from the base.
const RETRY_BASE_MILLIS = 200;
const RETRY_MAX_MILLIS = 30_000;
// How often a job is asked for once its signal is used up and it still runs.
const POLL_MILLIS = 1000;
// The wait between two looks at a source that is busy when a fork is asked for: as for the idle source before the
// first fork, it doubles from the base up to the maximum, without an end.
const BUSY_BASE_MILLIS = 250;
const BUSY_MAX_MILLIS = 30_000;

/** "Retry later" answers in a row after which a job fails as `driver-unavailable`, and a cleanup gives up. */
export const MAX_ATTEMPTS = 10;

/** How long to wait after the `attempts`th "retry later" in a row: the driver's own hint, else a doubling delay. */
export function retryDelay(error: ForkRetryLater, attempts: number): number {
	return error.afterMillis ?? Math.min(RETRY_BASE_MILLIS * 2 ** attempts, RETRY_MAX_MILLIS);
}

/** The id of one request of one job in its fork: the job itself (`correction` 0), or a correction of its answer. */
function requestIdOf(site: Site, key: JobKey, correction: number): RequestId {
	return RequestId.make(`${site.swarmId}/${key}/${correction}`);
}

/** Hands the fork one request of the job. */
function request(
	site: Site,
	planned: PlanJob,
	fork: Fork,
	correction: number,
	prompt: string,
): Effect.Effect<Notice, ForkFailure> {
	return site.driver.run({
		fork,
		requestId: requestIdOf(site, planned.key, correction),
		prompt,
		notify: { taskId: site.coordinatorTaskId, key: notifyKey(planned.index, correction) },
	});
}

/** A job whose request the fork accepted; it runs where the driver says now, else where it was known to run. */
function running(site: Site, fork: ForkId, correction: number, notice: Notice, ran: Place | null): typeof Running.Type {
	const wait = Notice.match(notice, {
		Signal: ({ signal }) => Wait.cases.Signal.make({ signal }),
		Poll: ({ afterMillis }) => Wait.cases.Poll.make({ at: site.now + afterMillis, everyMillis: afterMillis }),
	});
	return Running.make({ status: "running", fork, correction, wait, attempts: 0, ran: notice.place ?? ran });
}

/** How a job that still runs is asked next: at its driver's own pace, or at the default one after a used-up signal. */
function again(site: Site, wait: Wait): Wait {
	const everyMillis = paceOf(wait);
	return Wait.cases.Poll.make({ at: site.now + everyMillis, everyMillis });
}

function paceOf(wait: Wait): number {
	return Wait.match(wait, { Poll: ({ everyMillis }) => everyMillis, Signal: () => POLL_MILLIS });
}

/** How often in a row a job that has not started was answered "retry later", by what the answers said. */
type Tries = Pick<typeof Starting.Type, "attempts" | "busy">;

/**
 * A job that could not start: asked again later, or failed for good. A source that is busy is waited out, as before
 * the first fork: the answer is not counted, so the job never fails over it, and only a cancel ends the wait.
 */
function refused(site: Site, error: ForkFailure, fork: ForkId | null, before: Tries): Job {
	return ForkFailure.match(error, {
		ForkGone: (gone) => failed(fork, gone.what === "depth" ? "too-deep" : "gone", gone.message),
		ForkRetryLater: (later): Job => {
			if (later.sourceBusy === true) {
				const pause = later.afterMillis ?? Math.min(BUSY_BASE_MILLIS * 2 ** before.busy, BUSY_MAX_MILLIS);
				return {
					status: "starting",
					fork,
					attempts: before.attempts,
					busy: before.busy + 1,
					retryAt: site.now + pause,
				};
			}
			if (before.attempts + 1 >= MAX_ATTEMPTS) return failed(fork, "driver-unavailable", later.message);
			const retryAt = site.now + retryDelay(later, before.attempts);
			return { status: "starting", fork, attempts: before.attempts + 1, busy: 0, retryAt };
		},
	});
}

/** A running job the driver could not read: asked again later, or failed for good. */
function unread(site: Site, error: ForkFailure, job: typeof Running.Type): Job {
	return ForkFailure.match(error, {
		ForkGone: (gone) => failed(job.fork, "gone", gone.message, job.ran),
		ForkRetryLater: (later): Job => {
			if (job.attempts + 1 >= MAX_ATTEMPTS) return failed(job.fork, "driver-unavailable", later.message, job.ran);
			const at = site.now + retryDelay(later, job.attempts);
			return {
				...job,
				attempts: job.attempts + 1,
				wait: Wait.cases.Poll.make({ at, everyMillis: paceOf(job.wait) }),
			};
		},
	});
}

/**
 * Sends the answer back to its fork with what was wrong, when corrections are left. A "retry later" leaves the job at
 * the request it read: the next check reads the same answer and asks again.
 */
function correct(
	site: Site,
	planned: PlanJob,
	job: typeof Running.Type,
	fork: Fork,
	invalid: InvalidValue,
): Effect.Effect<Job> {
	if (job.correction >= site.work.corrections) {
		return Effect.succeed(failed(job.fork, "invalid-result", invalid.issues, job.ran));
	}
	return Effect.match(request(site, planned, fork, job.correction + 1, site.work.correctionOf(invalid)), {
		onFailure: (error) => unread(site, error, job),
		onSuccess: (notice) => running(site, job.fork, job.correction + 1, notice, job.ran),
	});
}
