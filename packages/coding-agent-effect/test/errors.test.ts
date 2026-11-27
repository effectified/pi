import { CredentialSynchronizationError as PiCredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CodingAgentFailure, fromPi } from "../src/errors.ts";

describe("fromPi", () => {
	it("maps Pi's CredentialSynchronizationError to the tagged error with its provider and operation", () => {
		const failure = fromPi(
			new PiCredentialSynchronizationError("faux", "setRuntimeApiKey", undefined, { cause: new Error("disk") }),
		);
		expect(failure).toMatchObject({
			_tag: "CredentialSynchronizationError",
			providerId: "faux",
			operation: "setRuntimeApiKey",
		});
	});

	it("tells the runtime's missing import file by its name, which pi-coding-agent's root does not export", () => {
		const missing = Object.assign(new Error("File not found: /nowhere.jsonl"), {
			name: "SessionImportFileNotFoundError",
		});
		expect(fromPi(missing)).toMatchObject({
			_tag: "SessionImportFileNotFound",
			message: "File not found: /nowhere.jsonl",
		});
	});

	it("keeps any other rejection as a CodingAgentError with Pi's message and the error as its cause", () => {
		const error = new Error("No API key for faux");
		expect(fromPi(error)).toMatchObject({ _tag: "CodingAgentError", message: "No API key for faux", cause: error });
		expect(fromPi("plain")).toMatchObject({ _tag: "CodingAgentError", message: "plain" });
	});
});

describe("CodingAgentFailure", () => {
	it("picks a handler per tag and tests for one", () => {
		const failures = [
			fromPi(new PiCredentialSynchronizationError("faux", "logout", undefined, { cause: new Error("disk") })),
			fromPi(new Error("No API key for faux")),
		];
		const described = failures.map((failure) =>
			CodingAgentFailure.match(failure, {
				CredentialSynchronizationError: (error) => `${error.operation} ${error.providerId}`,
				SessionImportFileNotFound: (error) => error.message,
				CodingAgentError: (error) => error.message,
			}),
		);
		expect(described).toEqual(["logout faux", "No API key for faux"]);
		expect(failures.map(CodingAgentFailure.guards.CodingAgentError)).toEqual([false, true]);
	});
});
