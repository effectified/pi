// The host keys an application trusts for its SSH targets: scanned, accepted after the owner compared them, forgotten.

import { acceptHostKey, forgetHostKey, type SshTarget, scanHostKey } from "@earendil-works/pi-env";
import type { Effect } from "effect";
import * as Call from "../call.ts";
import type { SshError } from "../errors.ts";
import { fromSshRejection } from "./rejection.ts";

/** What a host presented: its known-hosts lines, and their fingerprints for the owner to compare out of band. */
export interface Scanned {
	readonly lines: ReadonlyArray<string>;
	readonly fingerprints: ReadonlyArray<string>;
}

/**
 * Connects once, through the same route as real connections, to capture the key the host presents. Showing a
 * fingerprint is not authentication: compare it with one obtained out of band before accepting it. Interrupting
 * stops waiting; the `ssh` run ends within its timeout.
 */
export function scan(target: SshTarget): Effect.Effect<Scanned, SshError> {
	return Call.unabortable(() => scanHostKey(target), fromSshRejection);
}

/**
 * Trusts host-key lines from `scan` by adding them to the target's known-hosts file. Only plain lines for the
 * target's alias are accepted. A key that differs from a trusted key of the same type fails with `HostKeyChanged`:
 * `forget` the old keys first.
 */
export function accept(target: SshTarget, lines: ReadonlyArray<string>): Effect.Effect<void, SshError> {
	return Call.unabortable(() => acceptHostKey(target, lines), fromSshRejection);
}

/** Stops trusting every key stored for the target's alias, after the owner confirmed a changed key. */
export function forget(target: SshTarget): Effect.Effect<void, SshError> {
	return Call.unabortable(() => forgetHostKey(target), fromSshRejection);
}
