import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { fromPiModelRef } from "@effectified/pi-ai";
import { describe, expect, it } from "vitest";
import { describe as describeError } from "../src/errors.ts";
import {
	NoAnswerUnderReview,
	NotDeferred,
	NotHeld,
	ReviewerRequestFailed,
	UndecodableReview,
	VerificationFailed,
} from "../src/index.ts";

describe("the errors of the package", () => {
	it("are tagged, and say what happened", () => {
		const reviewer = fromPiModelRef({ provider: "reviewer-lab", modelId: "judge" });
		// Pi brands its ids in the type system only: at run time they are the numbers stored.
		const conversationId = 3 as ConversationId;
		const errors = [
			ReviewerRequestFailed.make({ ...reviewer, reason: "overloaded" }),
			UndecodableReview.make({ ...reviewer, reason: "not JSON" }),
			VerificationFailed.make({ reason: "the index is down", cause: new Error("503") }),
			NoAnswerUnderReview.make({ conversationId, taskId: 9 as TaskId }),
			NotHeld.make({ conversationId, state: "Reviewed" }),
			NotDeferred.make({ conversationId, state: "Held" }),
		];
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			["ReviewerRequestFailed", "The reviewer reviewer-lab/judge did not answer: overloaded"],
			["UndecodableReview", "The answer of the reviewer reviewer-lab/judge is not a list of findings: not JSON"],
			["VerificationFailed", "The citation could not be verified: the index is down"],
			["NoAnswerUnderReview", "Review task 9 found no answer under review in conversation 3"],
			["NotHeld", "Conversation 3 is not held: its review state is Reviewed"],
			["NotDeferred", "The review of conversation 3 is not deferred: its review state is Held"],
		]);
	});
});

describe("describe", () => {
	it("gives an error's message, and anything else as a string", () => {
		expect(describeError(new Error("down"))).toBe("down");
		expect(describeError("down")).toBe("down");
		expect(describeError(503)).toBe("503");
	});
});
