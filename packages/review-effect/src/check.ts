// A check: one piece of work that reads a finished answer and reports findings. Products add their own.

import type { Message } from "@effectified/pi-ai";
import type { ConversationId, EntryId } from "@effectified/pi-durable";
import { type Effect, Schema } from "effect";
import type { Finding } from "./finding.ts";
import type { Party } from "./verdict.ts";

/**
 * The name of a check: stored with every finding and every failure of a verdict, and part of the name of the memo that
 * keeps the check's report. A product names its checks with plain strings: `make` brands them, and decoding a verdict
 * brands a stored one.
 */
export const Name = Schema.String.pipe(Schema.brand("@effectified/pi-review/CheckName"));

/** The name of a check. */
export type Name = typeof Name.Type;

/**
 * The answer a check reads, and the run that led to it. An interface, not a Schema: it holds Pi's own messages, as Pi
 * types them, and is never stored or sent.
 */
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
 * A named check. `run` succeeds with what it found, an empty list for nothing. A failure, with an error `E` or a
 * defect, is not a finding: the review is then not complete, and the answer is recorded as not reviewed. `R` is what
 * `run` needs: the registry the review extension is installed in requires it.
 */
export interface Check<R = never, E = unknown> {
	/** Stored with every finding and every failure of the check. */
	readonly name: Name;
	readonly run: (subject: Subject) => Effect.Effect<ReadonlyArray<Finding>, E, R>;
}

/** Any check, whatever it needs and fails with: what a list of checks holds. */
export interface Any extends Check<unknown, unknown> {}

/** The services a check, or each check of a union, needs to run. */
export type Services<C> = C extends Check<infer R, unknown> ? R : never;

/** A check named `name` that runs `run`: the name branded, `run` as it is given. */
export function make<R = never, E = never>(
	name: string,
	run: (subject: Subject) => Effect.Effect<ReadonlyArray<Finding>, E, R>,
): Check<R, E> {
	return { name: Name.make(name), run };
}
