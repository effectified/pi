import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "@earendil-works/pi-env";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as HostKey from "../src/node/host-key.ts";
import * as Remote from "../src/node/remote.ts";
import * as Ssh from "../src/node/ssh.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

describe("Ssh.args", () => {
	it("gives pi-env's ssh arguments: strict host keys against the target's file, under its alias", async () => {
		const args = await runLive(
			Ssh.args({ host: "box", hostKeyAlias: "pi-env-box", knownHostsFile: "/k", port: 2222 }),
		);
		expect(args).toContain("StrictHostKeyChecking=yes");
		expect(args).toContain('UserKnownHostsFile="/k"');
		expect(args).toContain("HostKeyAlias=pi-env-box");
		expect(args.slice(-2)).toEqual(["--", "box"]);
	});

	it("accepts new keys into another file for a scan", async () => {
		const args = await runLive(
			Ssh.args(
				{ host: "box", hostKeyAlias: "a", knownHostsFile: "/k" },
				{ strictHostKeys: false, knownHostsFile: "/s" },
			),
		);
		expect(args).toContain("StrictHostKeyChecking=accept-new");
		expect(args).toContain('UserKnownHostsFile="/s"');
	});

	it("fails with UnexpectedError on a host that would be read as an option", async () => {
		const exit = await runLive(
			Effect.exit(Ssh.args({ host: "-oProxyCommand=x", hostKeyAlias: "a", knownHostsFile: "/k" })),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { _tag: "UnexpectedError" } });
	});
});

describe.skipIf(process.platform === "win32")("Ssh.detect, through a stand-in for ssh", () => {
	it("detects this machine's system through the login shell", async () => {
		const remote = await runLive(
			Effect.flatMap(tempDir, (directory) => Ssh.detect(fakeSsh(directory, directory, "run"))),
		);
		expect(remote).toMatchObject({ platform: process.platform, arch: process.arch, warnings: [] });
	});

	it("fails with the tag of ssh's failure: an unknown key, a changed key, a refused login", async () => {
		const tags = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.forEach(["unknown-key", "changed-key", "refused"] as const, (mode) =>
					Effect.map(Effect.flip(Ssh.detect(fakeSsh(directory, directory, mode))), (error) => error._tag),
				),
			),
		);
		expect(tags).toEqual(["HostKeyUnknown", "HostKeyChanged", "SshFailed"]);
	});
});

describe.skipIf(daemon === undefined || process.platform === "win32")(
	`Ssh.deploy, Ssh.connect and Ssh.lazy, through a stand-in for ssh (${daemon ?? NO_DAEMON})`,
	() => {
		it("deploys the daemon into the remote home under its hash, and connects to it", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const home = join(directory, "home");
					mkdirSync(home);
					const target = fakeSsh(directory, home, "run");
					const remote = yield* Ssh.detect(target);
					const deployed = yield* Ssh.deploy(target, remote, daemon);
					// The second deployment finds the same file and uploads nothing.
					const again = yield* Ssh.deploy(target, remote, daemon);
					const { connection } = yield* Ssh.connect({ ...target, binary: daemon });
					const env = yield* Remote.make({ connection, id: "pi-env:fake", cwd: directory });
					const result = yield* env.exec("echo $HOME");
					const info = yield* connection.info;
					return { deployed, again, home, result, infoHome: info.home };
				}),
			);
			expect(seen.deployed.startsWith(join(seen.home, ".pi/mobile/tools/pi-env-"))).toBe(true);
			expect(seen.again).toBe(seen.deployed);
			expect(seen.result.exitCode).toBe(0);
			expect(seen.infoHome).toBe(seen.home);
		});

		it("connects lazily: the system is known after the first request", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const home = join(directory, "home");
					mkdirSync(home);
					const { connection, remote } = yield* Ssh.lazy({ ...fakeSsh(directory, home, "run"), binary: daemon });
					const before = yield* remote;
					yield* connection.info;
					return { before, after: yield* remote };
				}),
			);
			expect(seen.before).toEqual(Option.none());
			expect(seen.after).toMatchObject({ _tag: "Some", value: { platform: process.platform } });
		});

		it("fails a lazy connection's requests with `spawn_error` when the host key is not trusted", async () => {
			const exit = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const { connection } = yield* Ssh.lazy({
						...fakeSsh(directory, directory, "unknown-key"),
						binary: daemon,
					});
					return yield* Effect.exit(connection.info);
				}),
			);
			expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
				error: { _tag: "RemoteFailed", code: "spawn_error", lost: true },
			});
		});
	},
);

/**
 * A real SSH server, only when one is configured as for upstream's `ssh-external` test: `PI_ENV_SSH_HOST`, and
 * optionally `PI_ENV_SSH_USER`, `PI_ENV_SSH_PORT`, `PI_ENV_SSH_KEY` and `PI_ENV_SSH_PROGRAM`. Never by default.
 */
const host = process.env.PI_ENV_SSH_HOST;

describe.skipIf(host === undefined || daemon === undefined)("a real SSH server (PI_ENV_SSH_HOST)", () => {
	it("scans and accepts its key, deploys the daemon, and runs a command there", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const target: SshTarget = {
					host: host!,
					...(process.env.PI_ENV_SSH_USER === undefined ? {} : { user: process.env.PI_ENV_SSH_USER }),
					...(process.env.PI_ENV_SSH_PORT === undefined ? {} : { port: Number(process.env.PI_ENV_SSH_PORT) }),
					...(process.env.PI_ENV_SSH_KEY === undefined ? {} : { identityFile: process.env.PI_ENV_SSH_KEY }),
					...(process.env.PI_ENV_SSH_PROGRAM === undefined ? {} : { ssh: process.env.PI_ENV_SSH_PROGRAM }),
					knownHostsFile: join(directory, "known_hosts"),
					hostKeyAlias: "pi-env-effect-external",
				};
				yield* HostKey.accept(target, (yield* HostKey.scan(target)).lines);
				const { connection, remote } = yield* Ssh.connect({ ...target, binary: daemon });
				const env = yield* Remote.make({ connection, id: "pi-env:external", cwd: remote.home });
				return yield* env.exec("echo ok");
			}),
		);
		expect(result.exitCode).toBe(0);
	});
});

describe.skipIf(process.platform === "win32")("Ssh.connect, interrupted", () => {
	it("stops waiting for a detection that does not answer", async () => {
		const exit = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const target = fakeSsh(directory, directory, "run");
				// A login shell that never answers the probe.
				const hanging = { ...target, ssh: join(directory, "ssh-hanging") };
				writeFileSync(hanging.ssh, "#!/bin/sh\nexec sleep 30\n");
				chmodSync(hanging.ssh, 0o755);
				const fiber = yield* Effect.forkChild(Effect.scoped(Ssh.connect(hanging)), { startImmediately: true });
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});
