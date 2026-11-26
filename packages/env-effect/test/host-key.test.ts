import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import * as HostKey from "../src/node/host-key.ts";
import { fakeSsh, HOST_KEYS } from "./fake-ssh.ts";
import { tempDir } from "./fixtures.ts";

/** Whether `ssh-keygen`, which `scan` runs for the fingerprints, is installed. */
const keygen = (() => {
	try {
		execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
		return true;
	} catch (error) {
		// It prints its usage and exits 1 when it exists.
		return (error as { status?: number }).status === 1;
	}
})();

describe("HostKey.accept and HostKey.forget", () => {
	it("trusts the lines of the target's alias in its known-hosts file, and forgets them", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const target = fakeSsh(directory, directory, "run");
				yield* HostKey.accept(target, [`pi-env-test ${HOST_KEYS[0]}`]);
				// Accepting a key already trusted adds nothing.
				yield* HostKey.accept(target, [`pi-env-test ${HOST_KEYS[0]}`]);
				const accepted = readFileSync(target.knownHostsFile, "utf8");
				yield* HostKey.forget(target);
				return { accepted, forgotten: readFileSync(target.knownHostsFile, "utf8") };
			}),
		);
		expect(seen).toEqual({ accepted: `pi-env-test ${HOST_KEYS[0]}\n`, forgotten: "" });
	});

	it("refuses a different key of a trusted type with HostKeyChanged", async () => {
		const exit = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const target = fakeSsh(directory, directory, "run");
				writeFileSync(target.knownHostsFile, `pi-env-test ${HOST_KEYS[0]}\n`);
				return yield* Effect.exit(HostKey.accept(target, [`pi-env-test ${HOST_KEYS[1]}`]));
			}),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { _tag: "HostKeyChanged" } });
	});

	it("refuses a line for another alias with UnexpectedError", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.exit(HostKey.accept(fakeSsh(directory, directory, "run"), [`other ${HOST_KEYS[0]}`])),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { _tag: "UnexpectedError" } });
	});
});

describe.skipIf(process.platform === "win32" || !keygen)("HostKey.scan, through a stand-in for ssh", () => {
	it("captures the key the host presents, with its fingerprint, even when the login is refused", async () => {
		const scanned = await runLive(
			Effect.flatMap(tempDir, (directory) => HostKey.scan(fakeSsh(directory, directory, "scan"))),
		);
		expect(scanned.lines).toEqual([`pi-env-test ${HOST_KEYS[0]}`]);
		expect(scanned.fingerprints[0]).toMatch(/SHA256:.* \(ED25519\)$/);
	});
});
