// A stand-in for the system `ssh`, so pi-env's SSH code runs for real without a network or a remote machine: it runs
// the remote command on this machine with a home directory of the test's, or answers as `ssh` does when it fails.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "@earendil-works/pi-env";

/** Two host keys of the same type, for accepting one and seeing the other refused as a changed key. */
export const HOST_KEYS = [
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHdE8j947fK/Iy4ecQ63cI81gGN4XEYgqYzJ1VxoGRfs",
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOCNeVNEvyU9V+CzR/ZOx1FCWW+wbnK7F1lqnD1Cjnag",
] as const;

/**
 * How the stand-in answers: `run` runs the command after `--` and the host, as `ssh` does on the remote machine;
 * `scan` records the first host key in the known-hosts file `ssh` was given and fails authentication, as a host whose
 * key `accept-new` records does; the others fail as `ssh` fails for an unknown key, a changed key, or a refused login.
 */
export type Mode = "run" | "scan" | "unknown-key" | "changed-key" | "refused";

/** Writes the stand-in into `directory` and returns a target that uses it, with `home` as the remote home. */
export function fakeSsh(directory: string, home: string, mode: Mode): SshTarget {
	const program = join(directory, `ssh-${mode}`);
	writeFileSync(program, `#!/bin/sh\n${SCRIPTS[mode](home)}`);
	chmodSync(program, 0o755);
	return {
		host: "test-host",
		hostKeyAlias: "pi-env-test",
		knownHostsFile: join(directory, "known_hosts"),
		ssh: program,
	};
}

const SCRIPTS: Record<Mode, (home: string) => string> = {
	// `ssh` joins the words after the host into one command for the remote shell.
	run: (home) => `while [ "$1" != "--" ]; do shift; done\nshift 2\nHOME='${home}' exec sh -c "$*"\n`,
	scan: () =>
		[
			// The file of `-o UserKnownHostsFile="<path>"`, without its quotes.
			'for arg; do case "$arg" in UserKnownHostsFile=*) known="$arg";; esac; done',
			`file=$(printf %s "$known" | sed 's/^UserKnownHostsFile="//; s/"$//')`,
			`echo "pi-env-test ${HOST_KEYS[0]}" >> "$file"`,
			'echo "Permission denied (publickey)." >&2',
			"exit 255",
			"",
		].join("\n"),
	"unknown-key": () => 'echo "Host key verification failed." >&2\nexit 255\n',
	"changed-key": () => 'echo "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@" >&2\nexit 255\n',
	refused: () => 'echo "Permission denied (publickey)." >&2\nexit 255\n',
};
