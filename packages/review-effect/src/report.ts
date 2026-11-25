// A check's report: its findings or its failure, kept in a memo of the review task so each check is asked once.

import type { DurableError } from "@gunta/pi-durable-effect";
import { Cause, Effect, Schema } from "effect";
import type { Check, Subject } from "./check.ts";
import { describe } from "./errors.ts";
import { Finding } from "./finding.ts";
import * as Kept from "./kept.ts";

/** What one check came to: what it found, or the error it failed with instead of answering. */
export const Report = Schema.Union([
	Schema.TaggedStruct("Found", { findings: Schema.Array(Finding) }),
	Schema.TaggedStruct("Failed", { error: Schema.String }),
]);

/** What one check came to. */
export type Report = typeof Report.Type;

/** The memos of the review task: Pi keeps them while the task can run, and the first writer of a name wins. */
export type Memos = Kept.Memos;

/**
 * The report of `check` on `subject`, made once per review task: a report the memo `name` holds is returned as it is,
 * so a phase that runs again after a close or a crash asks nothing twice. A failure is kept like a finding list: a
 * check that failed is not asked again for the same verdict. A check a close interrupted left no memo, and runs again.
 */
export function once<R>(
	memos: Memos,
	name: string,
	check: Check<R>,
	subject: Subject,
): Effect.Effect<Report, DurableError, R> {
	return Kept.once(memos, name, decode, Effect.flatMap(of(check, subject), storable));
}

/**
 * Runs `check` and never fails: a failure or a defect of the check is its `Failed` report, so nothing a check does
 * can end the review task without a verdict. An interruption, Pi aborting the task or closing, stays one.
 */
export function of<R>(check: Check<R>, subject: Subject): Effect.Effect<Report, never, R> {
	return Effect.suspend(() => check.run(subject)).pipe(
		Effect.map((findings): Report => ({ _tag: "Found", findings })),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.succeed<Report>({ _tag: "Failed", error: describe(Cause.squash(cause)) }),
		),
	);
}

const decode = Schema.decodeUnknownEffect(Report);

const encode = Schema.encodeEffect(Report);

/**
 * `report` as a memo and a verdict can hold it: its JSON form, which for this schema has the type of the value.
 * Findings a check returned with a value the schema refuses, such as a `location` that is `undefined`, make its
 * report a failure: what cannot be stored cannot be part of a verdict.
 */
function storable(report: Report): Effect.Effect<Report> {
	return Effect.catch(encode(report), (error) =>
		Effect.succeed<Report>({ _tag: "Failed", error: `The findings cannot be stored: ${error.message}` }),
	);
}
