// A submission in Effect: something handed to a conversation (input, a write, a continue) that can be waited for.

import type {
	Submission as PiSubmission,
	SettledSubmissionRecord,
	SubmissionId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import { type Effect, Schema } from "effect";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";

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
	readonly abort: Effect.Effect<"aborted" | "already_placed" | "settled", DurableError>;
}

/**
 * The schema of a submission id, for a document or a task state that keeps one. Pi brands ids in the type system
 * only, which a schema cannot express: at run time a submission id is the number stored.
 */
export const Id = Schema.Number as unknown as Schema.Codec<SubmissionId, number>;

/** The Effect form of a Pi Durable submission. */
export function fromPi(submission: PiSubmission): Submission {
	return {
		id: submission.id,
		status: call((context) => submission.status(context)),
		wait: call((context) => submission.wait(context)),
		abort: call((context) => submission.abort(context)),
	};
}
