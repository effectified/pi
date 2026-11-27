import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
	EnvError,
	EXECUTION_ERROR_CODES,
	ExecFailed,
	FILE_ERROR_CODES,
	FileFailed,
	fromExecutionError,
	fromFileError,
	RemoteFailed,
	SshError,
	SshFailed,
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

describe("EnvError and SshError", () => {
	it("pick a handler per tag and test for one", () => {
		const failures: ReadonlyArray<EnvError> = [
			fromFileError(new FileError("not_found", "missing")),
			RemoteFailed.make({ code: "ENOENT", message: "missing", lost: false }),
			SshFailed.make({ message: "failed", exitCode: 255, stderr: "" }),
		];
		const tags = failures.map((failure) =>
			EnvError.match(failure, {
				FileFailed: (error) => `file ${error.code}`,
				ExecFailed: (error) => `exec ${error.code}`,
				RemoteFailed: (error) => `remote ${error.code}`,
				HostKeyUnknown: () => "unknown key",
				HostKeyChanged: () => "changed key",
				SshFailed: (error) => `ssh ${error.exitCode}`,
				UnexpectedError: (error) => error.message,
			}),
		);
		expect(tags).toEqual(["file not_found", "remote ENOENT", "ssh 255"]);
		expect(failures.map(SshError.guards.SshFailed)).toEqual([false, false, true]);
	});

	it("hold an exit code of `ssh` to an integer, or null when it did not exit", () => {
		expect(SshFailed.make({ message: "killed", exitCode: null, stderr: "" }).exitCode).toBeNull();
		expect(() => SshFailed.make({ message: "?", exitCode: 1.5, stderr: "" })).toThrow();
	});
});

describe("UnexpectedError", () => {
	it("shows its cause's message", () => {
		expect(new UnexpectedError({ cause: new Error("Invalid host") }).message).toBe("Invalid host");
		expect(new UnexpectedError({ cause: "plain" }).message).toBe("plain");
	});
});
