// Machines reached with the system `ssh`: detecting their system, deploying the daemon, and connections to it.

import {
	connectSsh,
	deployDaemon,
	detectPlatform,
	localDaemon,
	type RemotePlatform,
	type SshConnectOptions,
	type SshTarget,
	sshArguments,
	sshConnection,
} from "@earendil-works/pi-env";
import { Effect, Option, type Scope } from "effect";
import * as Call from "../call.ts";
import { type SshError, UnexpectedError } from "../errors.ts";
import * as Connection from "./connection.ts";
import { fromSshRejection } from "./rejection.ts";

/** Pi's options of an SSH connection without the log callback: the connection's `logs` is its Stream. */
export type ConnectOptions = Omit<SshConnectOptions, "onLog">;

/**
 * The arguments for `ssh` up to the host: no prompts, no forwarding, no shared connections, no configured
 * commands, and host keys checked against the target's known-hosts file under its alias (`accept-new` with
 * `strictHostKeys: false`). Fails with `UnexpectedError` on an invalid host, alias, user or port.
 */
export function args(
	target: SshTarget,
	options?: { readonly strictHostKeys?: boolean; readonly knownHostsFile?: string },
): Effect.Effect<ReadonlyArray<string>, UnexpectedError> {
	return Effect.try({
		try: () => sshArguments(target, options?.strictHostKeys, options?.knownHostsFile),
		catch: (cause) => new UnexpectedError({ cause }),
	});
}

/** Which system the target runs, through its login shell, or PowerShell on Windows. */
export function detect(target: SshTarget): Effect.Effect<RemotePlatform, SshError> {
	return Call.unabortable(() => detectPlatform(target), fromSshRejection);
}

/**
 * Makes sure the daemon is on the target, verified by its SHA-256 before it ever runs, and removes daemons of other
 * contents; returns its remote path. `binary` defaults to the one this package ships for the system.
 */
export function deploy(target: SshTarget, remote: RemotePlatform, binary?: string): Effect.Effect<string, SshError> {
	return Call.unabortable(() => deployDaemon(target, remote, binary), fromSshRejection);
}

/**
 * Detects the target's system and deploys the daemon now, then gives a connection that starts it over `ssh`,
 * stopped with the scope. The host key must already be trusted (`HostKey.accept`), or this fails with
 * `HostKeyUnknown`. Interrupting stops waiting for the detection and deployment, which end within their timeouts.
 */
export function connect(
	options: ConnectOptions,
): Effect.Effect<
	{ readonly connection: Connection.Connection; readonly remote: RemotePlatform },
	SshError,
	Scope.Scope
> {
	return Connection.acquire((onLog) => Call.unabortable(() => connectSsh({ ...options, onLog }), fromSshRejection));
}

/**
 * A connection to the target that does nothing until its first request, stopped with the scope. Each start
 * detects the system (the first time), verifies or deploys the daemon, then starts it over `ssh`; a failure fails
 * the requests waiting for it with `RemoteFailed` (code `spawn_error`), and the next request tries again. `remote`
 * is the detected system, once known.
 */
export function lazy(
	options: ConnectOptions,
): Effect.Effect<
	{ readonly connection: Connection.Connection; readonly remote: Effect.Effect<Option.Option<RemotePlatform>> },
	never,
	Scope.Scope
> {
	return Connection.acquire((onLog) =>
		Effect.sync(() => {
			const made = sshConnection({ ...options, onLog });
			return { connection: made.connection, remote: Effect.sync(() => Option.fromUndefinedOr(made.remote())) };
		}),
	);
}

/** The daemon this package ships for this machine, for terminals and file listing without SSH. */
export const local: Effect.Effect<string, UnexpectedError> = Effect.try({
	try: () => localDaemon(),
	catch: (cause) => new UnexpectedError({ cause }),
});
