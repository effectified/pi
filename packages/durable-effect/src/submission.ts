// A submission in Effect: something handed to a conversation (input, a write, a continue) that can be waited for.

import type {
	Submission as PiSubmission,
	SettledSubmissionRecord,
	SubmissionId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Effect } from "effect";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";
import * as Ids from "./id.ts";

/** One durably admitted submission. A plain object of Effects, bound to the harness that returned it. */
export interface Submission {
	readonly id: SubmissionId;
	/** The committed record: queued, placed, done or unanswered. */
	readonly status: Effect.Effect<SubmissionRecord, DurableError>;
	/**
	 * Succeeds once the submission is settled, `done` or `unanswered`. Interrupting it cancels only this wait: the
	 * submission and its run go on.
	 */
	readonly wait: Effect.Effect<SettledSubmissionRecord, DurableError>;
	/** Withdraws the submission while it is queued; says what it found otherwise. */
	readonly abort: Effect.Effect<AbortResult, DurableError>;
}

/** What Pi did with an abort of a submission: `aborted`, or what it found instead (`already_placed`, `settled`). */
export type AbortResult = Awaited<ReturnType<PiSubmission["abort"]>>;

/**
 * The schema of a submission id, for a document, a task state or a wire that keeps one: the number Pi stores, typed
 * with Pi's brand.
 */
export const Id = Ids.submission;

/**
 * Whether a submission in this status is settled: `done` or `unanswered`, as Pi's `SettledSubmissionRecord` says,
 * so it changes no more and its `notify` was delivered. `queued` and `placed` are open. The one place that reads
 * Pi's statuses so: a status Pi adds fails to compile here until it is decided.
 */
export function settled(status: SubmissionRecord["status"]): status is SettledSubmissionRecord["status"] {
	return SETTLED[status];
}

// Typed by both of Pi's types: every status of a record is here, and true exactly when Pi's settled record has it.
const SETTLED = {
	queued: false,
	placed: false,
	done: true,
	unanswered: true,
} as const satisfies Record<SettledSubmissionRecord["status"], true> &
	Record<Exclude<SubmissionRecord["status"], SettledSubmissionRecord["status"]>, false>;

/** The Effect form of a Pi Durable submission. */
export function fromPi(submission: PiSubmission): Submission {
	return {
		id: submission.id,
		status: call((context) => submission.status(context)),
		wait: call((context) => submission.wait(context)),
		abort: call((context) => submission.abort(context)),
	};
}
