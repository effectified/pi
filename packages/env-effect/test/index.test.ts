import type * as PiEnv from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";
import * as Node from "../src/node.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/**
 * What this package does with every value pi-env exports. pi-env starts programs with Node's child processes, so
 * its values are in `@effectified/pi-env/node`; the root holds the environment in Effect terms and the errors.
 */
const COVERAGE = {
	Connection: replaced("Connection.make: a connection scoped to its daemon; Connection.acquire for pi-env's own"),
	isConnectionLost: replaced("RemoteFailed.lost"),
	nodePlatform: offered,
	RemoteError: replaced("RemoteFailed"),
	LocalExecutionEnv: replaced("Local.make and Local.layer: an Env whose commands die with its scope"),
	openProcess: replaced("Process.open: a scoped process, its stdout and stderr as Streams"),
	RemoteProcess: replaced("Process.Process"),
	RemoteExecutionEnv: replaced("Remote.make and Remote.layer: an Env whose commands die with its scope"),
	acceptHostKey: replaced("HostKey.accept"),
	connectSsh: replaced("Ssh.connect: a scoped connection"),
	deployDaemon: replaced("Ssh.deploy"),
	detectPlatform: replaced("Ssh.detect"),
	forgetHostKey: replaced("HostKey.forget"),
	HostKeyChangedError: replaced("HostKeyChanged"),
	HostKeyUnknownError: replaced("HostKeyUnknown"),
	localDaemon: replaced("Ssh.local: an Effect that fails with UnexpectedError on a system without a daemon"),
	packagedDaemon: offered,
	scanHostKey: replaced("HostKey.scan"),
	sshArguments: replaced("Ssh.args: an Effect that fails with UnexpectedError on an invalid target"),
	sshConnection: replaced("Ssh.lazy: a scoped connection that connects on its first request"),
	SshError: replaced("SshFailed"),
	openTerminal: replaced("Terminal.open: a scoped terminal, its output as a Stream"),
	RemoteTerminal: replaced("Terminal.Terminal"),
	RemoteWatcher: replaced("RemoteWatch.open: a scoped watcher, its changes as a Stream"),
} satisfies Record<keyof typeof PiEnv, Coverage>;

describe("the coverage of pi-env", () => {
	it("offers every value it records as offered, so the record stays true", () => {
		const ours = new Set([...Object.keys(Package), ...Object.keys(Node)]);
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !ours.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});

	it("leaves nothing open", () => {
		expect(Object.values(COVERAGE).filter((coverage) => coverage.kind === "open")).toEqual([]);
	});
});

describe("the exports", () => {
	it("are the environment, the command results and the errors at the root, which imports no value of pi-env", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"EXECUTION_ERROR_CODES",
			"Env",
			"EnvError",
			"ExecEvent",
			"ExecFailed",
			"ExecResult",
			"FILE_ERROR_CODES",
			"FileFailed",
			"HostKeyChanged",
			"HostKeyUnknown",
			"RemoteFailed",
			"SshError",
			"SshFailed",
			"UnexpectedError",
		]);
	});
});
