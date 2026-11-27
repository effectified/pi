// A job's status as its fork's conversation holds it: the submission of a request, and the text of its answer.

import type { ConversationId, EntryRecord } from "@effectified/pi-durable";
import { type Doc, Harness } from "@effectified/pi-durable";
import { Array as Arr, Effect, Match, Option } from "effect";
import { JobStatus } from "./driver.ts";
import type { RequestId } from "./ids.ts";

/**
 * Where the request `requestId` stands in the conversation: its submission's record, and the answer's text once it
 * is done. `Unknown` for a request the conversation holds no submission of. It never waits.
 */
export function jobStatus(
	conversationId: ConversationId,
	requestId: RequestId,
): Effect.Effect<JobStatus, Doc.Failure, Harness.Harness> {
	// A commit that only reads: a submission by its request id is a table read, which Pi gives a transaction only.
	return Harness.commit((tx) =>
		Effect.flatMap(
			tx.submissionByRequest(conversationId, requestId),
			Option.match({
				onNone: () => Effect.succeed(UNKNOWN),
				onSome: (record) =>
					Match.value(record).pipe(
						Match.discriminatorsExhaustive("status")({
							queued: () => Effect.succeed(RUNNING),
							placed: () => Effect.succeed(RUNNING),
							unanswered: ({ reason }) => Effect.succeed(JobStatus.cases.Unanswered.make({ reason })),
							done: ({ answer }) =>
								answer === undefined
									? Effect.succeed(NOT_AN_INPUT)
									: Effect.map(tx.entry(answer), (entry) =>
											JobStatus.cases.Answered.make({
												text: Option.match(entry, { onNone: () => "", onSome: textOf }),
											}),
										),
						}),
					),
			}),
		),
	);
}

const UNKNOWN: JobStatus = JobStatus.cases.Unknown.make({});

const RUNNING: JobStatus = JobStatus.cases.Running.make({});

const NOT_AN_INPUT: JobStatus = JobStatus.cases.Unanswered.make({ reason: "The submission was not an input" });

/** The text a model wrote in an answer entry: its text parts, in order. */
function textOf(entry: EntryRecord): string {
	const parts = Arr.flatMap(entry.model ?? [], (message) => (message.role === "assistant" ? message.content : []));
	return Arr.join(
		Arr.flatMap(parts, (part) => (part.type === "text" ? [part.text] : [])),
		"",
	);
}
