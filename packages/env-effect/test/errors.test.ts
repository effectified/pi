import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
	EXECUTION_ERROR_CODES,
	ExecFailed,
	FILE_ERROR_CODES,
	FileFailed,
	fromExecutionError,
	fromFileError,
	UnexpectedError,
} from "../src/errors.ts";

describe("fromFileError", () => {
	it("keeps the code, message, path and cause of Pi's FileError", () => {
		const cause = new Error("EACCES");
		const failed = fromFileError(new FileError("permission_denied", "no access", "/etc/shadow", cause));
		expect(failed).toBeInstanceOf(FileFailed);
		expect(failed).toMatchObject({
			_tag: "FileFailed",
			code: "permission_denied",
			message: "no access",
			path: "/etc/shadow",
			cause,
		});
	});

	it("leaves out the path and cause Pi did not give", () => {
		const failed = fromFileError(new FileError("not_supported", "cannot list"));
		expect("path" in failed).toBe(false);
		expect("cause" in failed).toBe(false);
	});

	it("accepts every code of Pi's FileError", () => {
		for (const code of FILE_ERROR_CODES) expect(fromFileError(new FileError(code, code)).code).toBe(code);
	});
});

describe("fromExecutionError", () => {
	it("keeps the code, message and spill file of Pi's ExecutionError", () => {
		const error = new ExecutionError("timeout", "timeout:1");
		error.spillPath = "/tmp/spill";
		const failed = fromExecutionError(error);
		expect(failed).toBeInstanceOf(ExecFailed);
		expect(failed).toMatchObject({
			_tag: "ExecFailed",
			code: "timeout",
			message: "timeout:1",
			spillPath: "/tmp/spill",
		});
	});

	it("accepts every code of Pi's ExecutionError", () => {
		for (const code of EXECUTION_ERROR_CODES)
			expect(fromExecutionError(new ExecutionError(code, code)).code).toBe(code);
	});
});

describe("UnexpectedError", () => {
	it("shows its cause's message", () => {
		expect(new UnexpectedError({ cause: new Error("Invalid host") }).message).toBe("Invalid host");
		expect(new UnexpectedError({ cause: "plain" }).message).toBe("plain");
	});
});
