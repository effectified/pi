// A check: one piece of work that reads a finished answer and reports findings. Products add their own.

import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { Effect } from "effect";
import type { Finding } from "./finding.ts";
import type { Party } from "./verdict.ts";

/** The answer a check reads, and the run that led to it. */
export interface Subject {
	readonly conversationId: ConversationId;
	/** The entry of the answer. */
	readonly answerId: EntryId;
	/** The text of the answer. */
	readonly answer: string;
	/** The model that wrote the answer, with the family the policy gives it. */
	readonly author: Party;
	/** The number of this review within its run, from 1: above 1, the answer follows a correction. */
	readonly pass: number;
	/** The model messages of the run, oldest first, from the input that started it to the answer. */
	readonly transcript: ReadonlyArray<Message>;
}

/**
 * A named check. `run` succeeds with what it found, an empty list for nothing. A failure, with an error or a defect,
 * is not a finding: the review is then not complete, and the answer is recorded as not reviewed. `R` is what `run`
 * needs: the registry the review extension is installed in requires it.
 */
export interface Check<R = never> {
	/** Stored with every finding and every failure of the check. */
	readonly name: string;
	readonly run: (subject: Subject) => Effect.Effect<ReadonlyArray<Finding>, unknown, R>;
}

/** Any check, whatever it needs: what a list of checks holds. */
export interface Any extends Check<unknown> {}

/** The services a check, or each check of a union, needs to run. */
export type Services<C> = C extends Check<infer R> ? R : never;

/** A check named `name` that runs `run`. */
export function make<R = never>(
	name: string,
	run: (subject: Subject) => Effect.Effect<ReadonlyArray<Finding>, unknown, R>,
): Check<R> {
	return { name, run };
}
