// What pi-env rejects with, as this package's tagged errors: the one place that reads pi-env's error classes.

import {
	HostKeyChangedError,
	HostKeyUnknownError,
	isConnectionLost,
	SshError as PiSshError,
	RemoteError,
} from "@earendil-works/pi-env";
import { Effect, Match } from "effect";
import * as Call from "../call.ts";
import { HostKeyChanged, HostKeyUnknown, RemoteFailed, type SshError, SshFailed, UnexpectedError } from "../errors.ts";

/**
 * The tagged error of each error class pi-env exports, keyed by the class's exported name. `test/pi-conformance.ts`
 * holds the keys equal to pi-env's error classes, so a class pi-env adds fails to compile until it has a tag here.
 */
export const BY_CLASS = {
	RemoteError: (error: RemoteError) =>
		RemoteFailed.make({
			code: error.code,
			message: error.message,
			...(error.path === undefined ? {} : { path: error.path }),
			lost: isConnectionLost(error),
		}),
	HostKeyUnknownError: (error: HostKeyUnknownError) => HostKeyUnknown.make({ message: error.message }),
	HostKeyChangedError: (error: HostKeyChangedError) => HostKeyChanged.make({ message: error.message }),
	SshError: (error: PiSshError) =>
		SshFailed.make({ message: error.message, exitCode: error.exitCode, stderr: error.stderr }),
};

/** A rejection of pi-env's SSH and host-key functions as an `SshError`; one without a class is `UnexpectedError`. */
export function fromSshRejection(cause: unknown): SshError {
	return Match.value(cause).pipe(
		Match.when(Match.instanceOf(HostKeyUnknownError), BY_CLASS.HostKeyUnknownError),
		Match.when(Match.instanceOf(HostKeyChangedError), BY_CLASS.HostKeyChangedError),
		Match.when(Match.instanceOf(PiSshError), BY_CLASS.SshError),
		Match.orElse((other) => UnexpectedError.make({ cause: other })),
	);
}

/**
 * Awaits one of pi-env's SSH or host-key functions, which take no AbortSignal: interrupting the fiber stops waiting
 * at once, and the `ssh` run ends within its timeout. Fails with `SshError`.
 */
export function ssh<A>(run: () => Promise<A>): Effect.Effect<A, SshError> {
	return Call.unabortable(run, (cause) => Effect.fail(fromSshRejection(cause)));
}

/**
 * Awaits a pi-env call that talks to the daemon and takes no AbortSignal: interrupting the fiber stops waiting at
 * once. A `RemoteError` fails with `RemoteFailed`; anything else is a defect.
 */
export function remote<A>(run: () => Promise<A>): Effect.Effect<A, RemoteFailed> {
	return Call.unabortable(run, fromRemoteRejection);
}

/**
 * Runs a pi-env call that takes an AbortSignal with the fiber's: interrupting the fiber aborts it and waits until it
 * settled. A `RemoteError` fails with `RemoteFailed`; anything else is a defect.
 */
export function remoteAbortable<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, RemoteFailed> {
	return Call.abortable(run, fromRemoteRejection);
}

/** A `RemoteError` as a failure with `RemoteFailed`, anything else as a defect. */
function fromRemoteRejection(cause: unknown): Effect.Effect<never, RemoteFailed> {
	return cause instanceof RemoteError ? Effect.fail(BY_CLASS.RemoteError(cause)) : Effect.die(cause);
}
