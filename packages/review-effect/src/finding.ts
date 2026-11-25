// Findings: what a check reports about an answer, and which of them block it.

import { Schema } from "effect";

/** How serious a finding is, lowest first: a remark, something that should be fixed, something that must be. */
export const Severity = Schema.Literals(["info", "warn", "block"]);

/** How serious a finding is. */
export type Severity = typeof Severity.Type;

/** One thing a check found in an answer. */
export const Finding = Schema.Struct({
	severity: Severity,
	text: Schema.String,
	/** Where in the answer, in the check's own terms: a quote, a citation, a line. */
	location: Schema.optionalKey(Schema.String),
});

/** One thing a check found in an answer. */
export type Finding = typeof Finding.Type;

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, block: 2 };

/** Whether a finding of `severity` blocks when `from` is the lowest severity that does. */
export function blocks(severity: Severity, from: Severity): boolean {
	return RANK[severity] >= RANK[from];
}
