import { ExecutionError } from "@earendil-works/pi-durable/env";
import { HostKeyChangedError, HostKeyUnknownError, RemoteError, SshError } from "@earendil-works/pi-env";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { fromSshRejection, remote, remoteAbortable } from "../src/node/rejection.ts";

describe("fromSshRejection", () => {
	it("gives each of pi-env's SSH error classes its tag", () => {
		expect(fromSshRejection(new HostKeyUnknownError("not trusted"))).toMatchObject({
			_tag: "HostKeyUnknown",
			message: "not trusted",
		});
		expect(fromSshRejection(new HostKeyChangedError("changed"))).toMatchObject({
			_tag: "HostKeyChanged",
			message: "changed",
		});
		expect(fromSshRejection(new SshError("failed", 255, "Permission denied"))).toMatchObject({
			_tag: "SshFailed",
			message: "failed",
			exitCode: 255,
			stderr: "Permission denied",
		});
	});

	it("gives an error without a class of its own `UnexpectedError`", () => {
		const cause = new Error("Invalid host");
		expect(fromSshRejection(cause)).toMatchObject({ _tag: "UnexpectedError", cause });
	});
});

describe("remote", () => {
	it("fails with RemoteFailed for a RemoteError, with its code, path and whether the connection was lost", async () => {
		const refused = await runLive(
			Effect.exit(remote(() => Promise.reject(new RemoteError({ code: "ENOENT", message: "missing", path: "/x" })))),
		);
		const lost = await runLive(
			Effect.exit(remote(() => Promise.reject(new RemoteError({ code: "unknown", message: "gone", lost: true })))),
		);
		expect(Exit.isFailure(refused) && refused.cause.reasons[0]).toMatchObject({
			error: { _tag: "RemoteFailed", code: "ENOENT", message: "missing", path: "/x", lost: false },
		});
		expect(Exit.isFailure(lost) && lost.cause.reasons[0]).toMatchObject({ error: { code: "unknown", lost: true } });
	});

	it("dies on anything else: the daemon's calls reject with RemoteError only", async () => {
		const exit = await runLive(
			Effect.exit(remoteAbortable(() => Promise.reject(new ExecutionError("unknown", "x")))),
		);
		expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true);
	});
});
