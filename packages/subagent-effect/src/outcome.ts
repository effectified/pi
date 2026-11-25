// How a child ended, as the parent's model reads it: the state its settled submission gives, and that state in words.

import type { EntryId, EntryRecord, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { Option } from "effect";
import type * as Child from "./child.ts";

/** What the parent's model reads of a child that ended, and whether it is an error result. */
export interface Reading {
	readonly isError: boolean;
	readonly text: string;
}

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
	return { _tag: "Failed", reason, message: explain(reason, detail), answer: null };
}

/** The entry whose text `reading` needs: the answer of `Answered`, the last answer of a failure that had one. */
export function answerOf(state: Child.Ended): Option.Option<EntryId> {
	switch (state._tag) {
		case "Answered":
			return Option.some(state.answer);
		case "Typed":
			return Option.none();
		case "Failed":
			return Option.fromNullOr(state.answer);
	}
}

/**
 * `state` as the parent's model reads it: the answer's text, a typed result as JSON text, or why the child failed,
 * with its last answer when it gave one. `answer` is the entry `answerOf` names, when it was found.
 */
export function reading(state: Child.Ended, answer: Option.Option<EntryRecord>): Reading {
	switch (state._tag) {
		case "Answered":
			return { isError: false, text: textOf(answer) };
		case "Typed":
			return { isError: false, text: JSON.stringify(state.result) };
		case "Failed": {
			const last = textOf(answer);
			return {
				isError: true,
				text: last === "" ? state.message : `${state.message}\nIts last answer was:\n${last}`,
			};
		}
	}
}

/** The text of an assistant entry; empty for none, and for an entry that is no answer. */
export function textOf(entry: Option.Option<EntryRecord>): string {
	const message = Option.getOrUndefined(entry)?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** `reason` and its detail in words. */
function explain(reason: string, detail: unknown): string {
	const more = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
	switch (reason) {
		case "model_error":
			return `The subagent's model request failed${more}. Its work so far is lost to you: decide whether to try again.`;
		case "no_model":
			return `The subagent has no usable model${more}. Starting it again will not help.`;
		case "turn_limit":
			return `The subagent used up its turns (${typeof detail === "string" ? detail : "its limit"}) without a final answer. Give it a smaller task.`;
		case "aborted":
			return "The subagent was stopped before it answered.";
		case "copied":
			return "The subagent did not go on in this copy of its storage: its work stayed where it was copied from. Start it again if you still need it.";
		default:
			return `The subagent ended without an answer (${reason})${more}.`;
	}
}
