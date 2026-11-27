// The correction message: what the author model is told when a review sends its run back to work.

import { Array as Arr, Result, Schema } from "effect";
import { dual } from "effect/Function";
import { Found, Ordinal } from "./verdict.ts";

/** What a correction message is written from. */
export const Request = Schema.Struct({
	/** The number of the review that asks, within its run, from 1. */
	pass: Ordinal,
	/** The findings that block the answer, in check order: at least one. */
	blocking: Schema.NonEmptyArray(Found),
	/** The findings that do not block it, in check order. */
	remarks: Schema.Array(Found),
});

/** What a correction message is written from. */
export type Request = typeof Request.Type;

/** How a product writes the message: the text Pi appends as a user message of the run. */
export type Writer = (request: Request) => string;

/** The message this package writes: every blocking finding, numbered, then the remarks, then the instruction. */
export const standard: Writer = ({ blocking, remarks }) =>
	Arr.join(
		[
			"A review of your answer found problems that must be fixed:",
			...Arr.map(blocking, (finding, index) => `${index + 1}. ${line(finding)}`),
			...(Arr.isReadonlyArrayNonEmpty(remarks)
				? ["Other remarks:", ...Arr.map(remarks, (finding) => `- ${line(finding)}`)]
				: []),
			"Correct your answer and give it again in full.",
		],
		"\n",
	);

/**
 * The message `writer` gives for `request`; this package's own when the writer throws. A product's writer that
 * breaks must not leave a blocked answer without its correction. Data-first, or data-last with the request.
 */
export const write: {
	(request: Request): (writer: Writer) => string;
	(writer: Writer, request: Request): string;
} = dual(2, (writer: Writer, request: Request): string =>
	Result.getOrElse(
		Result.try(() => writer(request)),
		() => standard(request),
	),
);

/** One finding as a line of the message: its severity, its text, and where it is when the check said. */
function line(finding: Found): string {
	const text = `[${finding.severity}] ${finding.text}`;
	return finding.location === undefined ? text : `${text} (at: ${finding.location})`;
}
