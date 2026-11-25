import type { EntryId, EntryRecord, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { answer } from "@gunta/pi-durable-effect/testing";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Outcome from "../src/outcome.ts";

const id = 7 as EntryId;
/** A stored answer entry with `text`. */
const entry = (text: string) =>
	Option.some({ id, kind: "pi.assistant", model: [answer(text)] } as unknown as EntryRecord);
/** A settled input of a child, as Pi's `SubmissionSettled` carries it. */
const settled = (rest: object) => ({ type: "input", ...rest }) as unknown as SettledSubmissionRecord;

describe("Outcome.answered and Outcome.unanswered", () => {
	it("gives the answer's entry of a submission that was answered, and none otherwise", () => {
		expect(Outcome.answered(settled({ status: "done", answer: id }))).toEqual(Option.some(id));
		expect(Outcome.answered(settled({ status: "unanswered", reason: "aborted" }))).toEqual(Option.none());
		expect(Outcome.answered(settled({ type: "write", status: "done" }))).toEqual(Option.none());
	});

	it("says each of Pi's reasons in words the parent's model can act on", () => {
		const message = (reason: string, detail?: unknown) =>
			Outcome.unanswered(settled({ status: "unanswered", reason, ...(detail === undefined ? {} : { detail }) }));
		expect(message("model_error", "overloaded")).toEqual({
			_tag: "Failed",
			reason: "model_error",
			message:
				"The subagent's model request failed: overloaded. Its work so far is lost to you: decide whether to try again.",
			answer: null,
		});
		expect(message("no_model").message).toBe("The subagent has no usable model. Starting it again will not help.");
		expect(message("turn_limit", "3 turns").message).toBe(
			"The subagent used up its turns (3 turns) without a final answer. Give it a smaller task.",
		);
		expect(message("aborted").message).toBe("The subagent was stopped before it answered.");
		expect(message("restart_limit", { phase: "request" }).message).toBe(
			'The subagent ended without an answer (restart_limit): {"phase":"request"}.',
		);
		expect(message("reset").message).toBe("The subagent ended without an answer (reset).");
	});
});

describe("Outcome.reading", () => {
	it("reads an answer as its text, a typed result as JSON text, and a failure as its message with the last answer", () => {
		expect(Outcome.reading({ _tag: "Answered", answer: id }, entry("Forty-two."))).toEqual({
			isError: false,
			text: "Forty-two.",
		});
		expect(Outcome.reading({ _tag: "Typed", answer: id, result: { n: 42 } }, Option.none())).toEqual({
			isError: false,
			text: '{"n":42}',
		});
		const failed = { _tag: "Failed", reason: "invalid_result", message: "It does not match." } as const;
		expect(Outcome.reading({ ...failed, answer: id }, entry("forty-two"))).toEqual({
			isError: true,
			text: "It does not match.\nIts last answer was:\nforty-two",
		});
		expect(Outcome.reading({ ...failed, answer: null }, Option.none())).toEqual({
			isError: true,
			text: "It does not match.",
		});
	});

	it("makes the state of a failure from Pi's reason alone", () => {
		expect(Outcome.failed("aborted")).toEqual({
			_tag: "Failed",
			reason: "aborted",
			message: "The subagent was stopped before it answered.",
			answer: null,
		});
	});

	it("names the entry whose text a state needs", () => {
		expect(Outcome.answerOf({ _tag: "Answered", answer: id })).toEqual(Option.some(id));
		expect(Outcome.answerOf({ _tag: "Typed", answer: id, result: null })).toEqual(Option.none());
		expect(Outcome.answerOf({ _tag: "Failed", reason: "aborted", message: "", answer: null })).toEqual(Option.none());
	});

	it("reads no text from an entry that is no answer", () => {
		expect(Outcome.textOf(Option.none())).toBe("");
		expect(
			Outcome.textOf(Option.some({ id, kind: "pi.user", model: [{ role: "user", content: "hi" }] } as never)),
		).toBe("");
	});
});
