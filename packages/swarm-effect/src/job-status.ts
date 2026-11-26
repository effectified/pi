// A job's status as its fork's conversation holds it: the submission of a request, and the text of its answer.

import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { type Doc, Harness } from "@effectified/pi-durable";
import { Effect, Option } from "effect";
import type { JobStatus } from "./driver.ts";

/**
 * Where the request `requestId` stands in the conversation: its submission's record, and the answer's text once it
 * is done. `Unknown` for a request the conversation holds no submission of. It never waits.
 */
export function jobStatus(
	conversationId: ConversationId,
	requestId: string,
): Effect.Effect<JobStatus, Doc.Failure, Harness.Harness> {
	// A commit that only reads: a submission by its request id is a table read, which Pi gives a transaction only.
	return Harness.commit((tx) =>
		Effect.gen(function* () {
			const submission = yield* tx.submissionByRequest(conversationId, requestId);
			if (Option.isNone(submission)) return { _tag: "Unknown" };
			const record = submission.value;
			switch (record.status) {
				case "queued":
				case "placed":
					return { _tag: "Running" };
				case "unanswered":
					return { _tag: "Unanswered", reason: record.reason };
				case "done": {
					const answer = Option.fromUndefinedOr(record.answer);
					if (Option.isNone(answer)) return { _tag: "Unanswered", reason: "The submission was not an input" };
					const entry = yield* tx.entry(answer.value);
					return { _tag: "Answered", text: Option.match(entry, { onNone: () => "", onSome: textOf }) };
				}
			}
		}),
	);
}

/** The text a model wrote in an answer entry: its text parts, in order. */
function textOf(entry: EntryRecord): string {
	return (entry.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("");
}
