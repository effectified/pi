// pi-coding-agent's session storage in Effect: the tree of a session's entries as a service whose methods are Effects
// under Pi's names, its constructors as Effects and Layers, and the listing of stored sessions.

import {
	type NewSessionOptions,
	SessionManager as PiSessionManager,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Reads, reads, type Writes, writes } from "./lift.ts";

/** The methods of Pi's session manager that only read, as Effects. */
export const READS = [
	"buildContextEntries",
	"buildSessionContext",
	"buildSessionProjection",
	"getBranch",
	"getChildren",
	"getCwd",
	"getEntries",
	"getEntry",
	"getEntryCount",
	"getHeader",
	"getLabel",
	"getLeafEntry",
	"getLeafId",
	"getSessionDir",
	"getSessionFile",
	"getSessionId",
	"getSessionName",
	"getTree",
	"isPersisted",
	"usesDefaultSessionDir",
] as const;

/** The methods of Pi's session manager that append entries, move the leaf or write files, as Effects that can fail. */
export const WRITES = [
	"appendCompaction",
	"appendContextEdit",
	"appendCustomEntry",
	"appendCustomMessageEntry",
	"appendLabelChange",
	"appendMessage",
	"appendModelChange",
	"appendSessionInfo",
	"appendThinkingLevelChange",
	"appendUsage",
	"branch",
	"branchWithSummary",
	"createBranchedSession",
	"newSession",
	"resetLeaf",
	"setSessionFile",
] as const;

/** The methods of Pi's read-only view of a session, the one an extension context gives. */
export const VIEW = [
	"getCwd",
	"getSessionDir",
	"getSessionId",
	"getSessionFile",
	"getLeafId",
	"getLeafEntry",
	"getEntry",
	"getLabel",
	"getBranch",
	"buildContextEntries",
	"buildSessionProjection",
	"getHeader",
	"getEntries",
	"getTree",
	"getSessionName",
] as const satisfies ReadonlyArray<(typeof READS)[number]>;

/** A session's storage: every public method of Pi's `SessionManager` as an Effect, under its name. */
export interface SessionManagerHandle
	extends Reads<PiSessionManager, (typeof READS)[number]>, Writes<PiSessionManager, (typeof WRITES)[number]> {
	/** Pi's manager, for what takes one as it is: `createAgentSession`, a runtime factory. */
	readonly pi: PiSessionManager;
}

/** A read-only view of a session's storage: what an extension may read of it. */
export type SessionView = Reads<PiSessionManager, (typeof VIEW)[number]>;

/** The session storage a session is created with. */
export class SessionManager extends Context.Service<SessionManager, SessionManagerHandle>()(
	"@effectified/pi-coding-agent/session-manager/SessionManager",
) {
	/** `SessionManager` from an Effect that opens one, such as `SessionManager.inMemory()`. */
	static layer<E, R>(open: Effect.Effect<SessionManagerHandle, E, R>): Layer.Layer<SessionManager, E, R> {
		return Layer.effect(SessionManager, open);
	}

	/** A session kept in memory only, never written. `entries` restores an earlier session's. */
	static readonly inMemory = Effect.fn("SessionManager.inMemory")(
		(cwd?: string, options?: NewSessionOptions, entries?: Parameters<typeof PiSessionManager.inMemory>[2]) =>
			opened(() => PiSessionManager.inMemory(cwd, options, entries)),
	);

	/** A new session written to `sessionDir` (default: the agent directory's sessions of `cwd`). */
	static readonly create = Effect.fn("SessionManager.create")(
		(cwd: string, sessionDir?: string, options?: NewSessionOptions) =>
			opened(() => PiSessionManager.create(cwd, sessionDir, options)),
	);

	/** The session stored in the file `path`. */
	static readonly open = Effect.fn("SessionManager.open")((path: string, sessionDir?: string, cwdOverride?: string) =>
		opened(() => PiSessionManager.open(path, sessionDir, cwdOverride)),
	);

	/** The most recent session of `cwd`, or a new one when there is none. */
	static readonly continueRecent = Effect.fn("SessionManager.continueRecent")((cwd: string, sessionDir?: string) =>
		opened(() => PiSessionManager.continueRecent(cwd, sessionDir)),
	);

	/** A new session in `targetCwd` holding a copy of the session in the file `sourcePath`. */
	static readonly forkFrom = Effect.fn("SessionManager.forkFrom")(
		(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions) =>
			opened(() => PiSessionManager.forkFrom(sourcePath, targetCwd, sessionDir, options)),
	);

	/** The file of the session of `cwd` with the id `id`, if one is stored. */
	static readonly findById = Effect.fn("SessionManager.findById")(
		(cwd: string, id: string, sessionDir?: string): Effect.Effect<string | undefined, CodingAgentFailure> =>
			Effect.try({ try: () => PiSessionManager.findById(cwd, id, sessionDir), catch: fromPi }),
	);

	/** The stored sessions of `cwd`, most recent first. Interrupting it stops reading them. */
	static readonly list = Effect.fn("SessionManager.list")(
		(cwd: string, sessionDir?: string): Effect.Effect<SessionInfo[], CodingAgentFailure> =>
			Effect.tryPromise({
				try: (signal) => PiSessionManager.list(cwd, sessionDir, undefined, signal),
				catch: fromPi,
			}),
	);

	/** The stored sessions of every directory, most recent first. Interrupting it stops reading them. */
	static readonly listAll = Effect.fn("SessionManager.listAll")(
		(sessionDir?: string): Effect.Effect<SessionInfo[], CodingAgentFailure> =>
			Effect.tryPromise({ try: (signal) => PiSessionManager.listAll(sessionDir, undefined, signal), catch: fromPi }),
	);

	/** Pi's manager as a handle. It stays the caller's. */
	static fromPi(pi: PiSessionManager): SessionManagerHandle {
		return { pi, ...reads(pi, READS), ...writes(pi, WRITES) };
	}
}

/** The read-only view of Pi's manager (or of the view an extension context holds). */
export function view(pi: Pick<PiSessionManager, (typeof VIEW)[number]>): SessionView {
	return reads(pi, VIEW);
}

/** A manager `open` makes, as a handle; what `open` throws (a file it cannot read) as a failure. */
function opened(open: () => PiSessionManager): Effect.Effect<SessionManagerHandle, CodingAgentFailure> {
	return Effect.map(Effect.try({ try: open, catch: fromPi }), SessionManager.fromPi);
}
