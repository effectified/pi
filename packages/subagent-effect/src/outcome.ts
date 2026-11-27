// How a child ended, as the parent's model reads it: the state its settled submission gives, and that state in words.

import type { EntryId, EntryRecord, RunFailureReason, SettledSubmissionRecord } from "@effectified/pi-durable";
import { Array as Arr, Formatter, Match, Option, Predicate, Record, Schema } from "effect";
import * as Child from "./child.ts";
import type * as Copy from "./copy.ts";

/** What the parent's model reads of a child that ended, and whether it is an error result. */
export const Reading = Schema.Struct({ isError: Schema.Boolean, text: Schema.String });

/** What the parent's model reads of a child that ended. */
export type Reading = typeof Reading.Type;

/** The entry of the answer a settled submission was answered with; none for one that was not answered. */
export function answered(settled: SettledSubmissionRecord): Option.Option<EntryId> {
	// A write settles `done` without an answer; a child is given inputs only.
	return settled.status === "done" && settled.type !== "write" ? Option.some(settled.answer) : Option.none();
}

/** The state of a child whose submission ended without an answer: Pi's reason, and what it means for the parent. */
export function unanswered(settled: SettledSubmissionRecord): Child.Failed {
	return failed(settled.reason ?? "unanswered", settled.detail);
}

/**
 * The state of a child that failed for `reason`, one of Pi's for a run without an answer (spec 8.2) or this package's
 * `copied`, with its `detail`: the message says it in words the parent's model can act on.
 */
export function failed(reason: string, detail?: unknown): Child.Failed {
	return Child.State.cases.Failed.make({ reason, message: explain(reason, detail), answer: null });
}

/** The entry whose text `reading` needs: the answer of `Answered`, the last answer of a failure that had one. */
export function answerOf(state: Child.Ended): Option.Option<EntryId> {
	return Match.valueTags(state, {
		Answered: ({ answer }) => Option.some(answer),
		Typed: () => Option.none(),
		Failed: ({ answer }) => Option.fromNullOr(answer),
	});
}

/**
 * `state` as the parent's model reads it: the answer's text, a typed result as JSON text, or why the child failed,
 * with its last answer when it gave one. `answer` is the entry `answerOf` names, when it was found.
 */
export function reading(state: Child.Ended, answer: Option.Option<EntryRecord>): Reading {
	return Match.valueTags(state, {
		Answered: () => Reading.make({ isError: false, text: textOf(answer) }),
		Typed: ({ result }) => Reading.make({ isError: false, text: Formatter.formatJson(result) }),
		Failed: ({ message }) => {
			const last = textOf(answer);
			return Reading.make({
				isError: true,
				text: last === "" ? message : `${message}\nIts last answer was:\n${last}`,
			});
		},
	});
}

/** The text of an assistant entry; empty for none, and for an entry that is no answer. */
export function textOf(entry: Option.Option<EntryRecord>): string {
	const message = Option.getOrUndefined(entry)?.model?.[0];
	if (message?.role !== "assistant") return "";
	return Arr.join(
		Arr.flatMap(message.content, (part) => (part.type === "text" ? [part.text] : [])),
		"",
	);
}

/** `reason` and its detail in words. */
function explain(reason: string, detail: unknown): string {
	const more = detail === undefined ? "" : `: ${Predicate.isString(detail) ? detail : Formatter.formatJson(detail)}`;
	return Option.match(Record.get(EXPLAINED, reason), {
		onNone: () => `The subagent ended without an answer (${reason})${more}.`,
		onSome: (words) => words(more, detail),
	});
}

/** The words for one reason: `more` is its detail as `: DETAIL`, empty without one. */
type Explain = (more: string, detail: unknown) => string;

// Keyed by Pi's reasons for a run without an answer and this package's own: a reason Pi renames fails to compile
// here. A reason not listed, one Pi adds included, reads as `explain`'s sentence for any other reason. Read with
// `Record.get`, which finds own keys only: the reason is a stored word typed `string`, and a lookup must not find an
// inherited property such as `toString`.
const EXPLAINED: Readonly<Record<string, Explain>> = {
	model_error: (more) =>
		`The subagent's model request failed${more}. Its work so far is lost to you: decide whether to try again.`,
	no_model: (more) => `The subagent has no usable model${more}. Starting it again will not help.`,
	turn_limit: (_more, detail) =>
		`The subagent used up its turns (${Predicate.isString(detail) ? detail : "its limit"}) without a final answer. Give it a smaller task.`,
	aborted: () => "The subagent was stopped before it answered.",
	copied: () =>
		"The subagent did not go on in this copy of its storage: its work stayed where it was copied from. Start it again if you still need it.",
} satisfies Partial<Record<RunFailureReason | typeof Copy.REASON, Explain>>;
