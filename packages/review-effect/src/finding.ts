// Findings: what a check reports about an answer, and which of them block it.

import { Order, Schema } from "effect";
import { dual } from "effect/Function";

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

/** Severities lowest first: what `blocks` compares by. */
const BY_RANK: Order.Order<Severity> = Order.mapInput(Order.Number, (severity) => RANK[severity]);

/**
 * Whether a finding of `severity` blocks when `from` is the lowest severity that does. Data-first, or data-last with
 * `from`: `Arr.filter(findings, (finding) => blocks(finding.severity, from))`.
 */
export const blocks: {
	(from: Severity): (severity: Severity) => boolean;
	(severity: Severity, from: Severity): boolean;
} = dual(2, (severity: Severity, from: Severity): boolean => Order.isGreaterThanOrEqualTo(BY_RANK)(severity, from));
