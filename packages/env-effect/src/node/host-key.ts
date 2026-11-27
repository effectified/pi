// The host keys an application trusts for its SSH targets: scanned, accepted after the owner compared them, forgotten.

import { acceptHostKey, forgetHostKey, type SshTarget, scanHostKey } from "@earendil-works/pi-env";
import { Effect, Schema } from "effect";
import type { SshError } from "../errors.ts";
import { ssh } from "./rejection.ts";

/** What a host presented: its known-hosts lines, and their fingerprints for the owner to compare out of band. */
export const Scanned = Schema.Struct({
	lines: Schema.Array(Schema.String),
	fingerprints: Schema.Array(Schema.String),
});

/** What a host presented. */
export type Scanned = typeof Scanned.Type;

/**
 * Connects once, through the same route as real connections, to capture the key the host presents. Showing a
 * fingerprint is not authentication: compare it with one obtained out of band before accepting it. Interrupting
 * stops waiting; the `ssh` run ends within its timeout.
 */
export const scan = Effect.fn("HostKey.scan")((target: SshTarget): Effect.Effect<Scanned, SshError> =>
	ssh(() => scanHostKey(target)),
);

/**
 * Trusts host-key lines from `scan` by adding them to the target's known-hosts file. Only plain lines for the
 * target's alias are accepted. A key that differs from a trusted key of the same type fails with `HostKeyChanged`:
 * `forget` the old keys first.
 */
export const accept = Effect.fn("HostKey.accept")((target: SshTarget, lines: ReadonlyArray<string>) =>
	ssh(() => acceptHostKey(target, lines)),
);

/** Stops trusting every key stored for the target's alias, after the owner confirmed a changed key. */
export const forget = Effect.fn("HostKey.forget")((target: SshTarget) => ssh(() => forgetHostKey(target)));
