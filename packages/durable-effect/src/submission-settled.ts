// Pi's built-in `SubmissionSettled` signal as a signal of this package: what a settling submission delivers.

import { SubmissionSettled as PiSubmissionSettled, type SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { Effect, Predicate, Schema } from "effect";
import type * as Signal from "./signal.ts";

const token = Effect.succeed(PiSubmissionSettled);

/**
 * Pi's built-in signal `pi.submission-settled`. A submission made with `notify: { taskId, key }` delivers its settled
 * record, what `Submission.wait` succeeds with, to that task under that key, in the commit that settles it; a
 * submission that settles before the task sleeps on the key wakes the sleep at once. A task or a tool call sleeps on
 * `SubmissionSettled.key(key)` and reads the record with `api.readSignal(SubmissionSettled, key)`.
 *
 * The value is Pi's own record type and is passed through both ways: Pi checks a delivered value against its own schema
 * and answers `invalid` for another shape, so nothing is checked here. `schema` only carries the type.
 */
export const SubmissionSettled: Signal.Signal<Schema.Codec<SettledSubmissionRecord>> = {
	name: PiSubmissionSettled.name,
	version: PiSubmissionSettled.version,
	schema: Schema.declare((value): value is SettledSubmissionRecord => Predicate.isObject(value)),
	key: (key) => ({ signal: { token }, key }),
	token,
	encode: (value) => Effect.succeed(value),
	// Pi's own type of a value Pi delivered and checked: nothing to check again.
	decode: (json) => Effect.succeed(json as SettledSubmissionRecord),
};
