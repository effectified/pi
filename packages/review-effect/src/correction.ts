// The correction message: what the author model is told when a review sends its run back to work.

import type { Found } from "./verdict.ts";

/** What a correction message is written from. */
export interface Request {
	/** The number of the review that asks, within its run, from 1. */
	readonly pass: number;
	/** The findings that block the answer, in check order. Never empty. */
	readonly blocking: ReadonlyArray<Found>;
	/** The findings that do not block it, in check order. */
	readonly remarks: ReadonlyArray<Found>;
}

/** How a product writes the message: the text Pi appends as a user message of the run. */
export type Writer = (request: Request) => string;

/** The message this package writes: every blocking finding, numbered, then the remarks, then the instruction. */
export const standard: Writer = ({ blocking, remarks }) =>
	[
		"A review of your answer found problems that must be fixed:",
		...blocking.map((finding, index) => `${index + 1}. ${line(finding)}`),
		...(remarks.length === 0 ? [] : ["Other remarks:", ...remarks.map((finding) => `- ${line(finding)}`)]),
		"Correct your answer and give it again in full.",
	].join("\n");

/**
 * The message `writer` gives for `request`; this package's own when the writer throws. A product's writer that
 * breaks must not leave a blocked answer without its correction.
 */
export function write(writer: Writer, request: Request): string {
	try {
		return writer(request);
	} catch {
		return standard(request);
	}
}

function line(finding: Found): string {
	const text = `[${finding.severity}] ${finding.text}`;
	return finding.location === undefined ? text : `${text} (at: ${finding.location})`;
}
