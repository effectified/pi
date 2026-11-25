// The whole module, walked at run time for its error classes: allowed in a test, refused in `src/`.
import * as PiDurable from "@earendil-works/pi-durable";
import {
	type ConversationId,
	ConversationBusy as PiConversationBusy,
	ConversationIdle as PiConversationIdle,
	ReadAfterWrite as PiReadAfterWrite,
	ReadOnlySession as PiReadOnlySession,
	SessionFailed as PiSessionFailed,
	StorageRequestError as PiStorageRequestError,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { fromRejection } from "../src/errors.ts";
import {
	Cancelled,
	ConversationBusy,
	ConversationIdle,
	ReadAfterWrite,
	ReadOnlySession,
	SessionFailed,
	StorageRequestError,
	UnexpectedError,
} from "../src/index.ts";

const conversationId = 7 as ConversationId;

describe("fromRejection", () => {
	it("gives each Pi Durable error class its tagged error, with Pi's message", () => {
		const diskFull = new Error("disk full");
		const cases = [
			[new PiConversationBusy(conversationId), ConversationBusy, { _tag: "ConversationBusy", conversationId: 7 }],
			[new PiConversationIdle(conversationId), ConversationIdle, { _tag: "ConversationIdle", conversationId: 7 }],
			[new PiReadAfterWrite("Tx.task()"), ReadAfterWrite, { _tag: "ReadAfterWrite" }],
			[new PiReadOnlySession("commit"), ReadOnlySession, { _tag: "ReadOnlySession" }],
			[new PiSessionFailed(diskFull), SessionFailed, { _tag: "SessionFailed", cause: diskFull }],
			[new PiStorageRequestError("Unknown conversation 9"), StorageRequestError, { _tag: "StorageRequestError" }],
		] as const;
		for (const [rejection, errorClass, fields] of cases) {
			const error = fromRejection(rejection);
			expect(error).toBeInstanceOf(errorClass);
			expect(error).toMatchObject({ ...fields, message: rejection.message });
		}
	});

	it("gives every error class Pi Durable exports a tag of its own, named as the class", () => {
		// The run-time half of `ErrorClassesTagged` in pi-conformance.ts: what Pi exports now, not what it was typed as.
		const classes = Object.entries(PiDurable).flatMap(([name, value]) =>
			typeof value === "function" && value.prototype instanceof Error ? [[name, value] as const] : [],
		);
		expect(classes.length).toBeGreaterThan(0);
		for (const [name, piClass] of classes) {
			// Every Pi error class takes one argument today; a class that refuses this one fails here, loudly too.
			const rejection: unknown = Reflect.construct(piClass, [1]);
			expect(fromRejection(rejection)._tag, name).toBe(name);
		}
	});

	it("gives a cancelled Chord context Cancelled, with the abort reason", () => {
		const reason = new DOMException("The operation was aborted", "AbortError");
		const error = fromRejection(reason);
		expect(error).toBeInstanceOf(Cancelled);
		expect(error).toMatchObject({ _tag: "Cancelled", cause: reason });
	});

	it("keeps the cause of an error it has no tag for", () => {
		const cause = new RangeError("maxTurns must be an integer 1 or more");
		const error = fromRejection(cause);
		expect(error).toBeInstanceOf(UnexpectedError);
		expect(error).toMatchObject({ _tag: "UnexpectedError", cause, message: cause.message });
		expect(fromRejection("not an error")).toMatchObject({ _tag: "UnexpectedError", cause: "not an error" });
	});
});
