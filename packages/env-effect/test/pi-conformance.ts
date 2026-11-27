// What env-effect restates of pi-env and of the environment interface by hand, and which of Pi's members it leaves
// out, checked against Pi's own types. Type-only: nothing here runs. A failure names what moved upstream.

import type {
	ExecutionEnv,
	ExecutionErrorCode,
	FileErrorCode,
	BinaryReader as PiBinaryReader,
	ShellExecResult,
	ShellOutputInfo,
} from "@earendil-works/pi-durable/env";
import type * as PiEnv from "@earendil-works/pi-env";
import type {
	Connection as PiConnection,
	Reply as PiReply,
	RemoteProcess,
	RemoteTerminal,
	RequestOptions,
	scanHostKey,
} from "@earendil-works/pi-env";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { Env } from "../src/env.ts";
import type { EXECUTION_ERROR_CODES, FILE_ERROR_CODES } from "../src/errors.ts";
import type { ExecEvent, ExecResult } from "../src/exec.ts";
import type { Connection, Reply, RequestInput } from "../src/node/connection.ts";
import type { Scanned } from "../src/node/host-key.ts";
import type { Process } from "../src/node/process.ts";
import type { BY_CLASS } from "../src/node/rejection.ts";
import type { Terminal } from "../src/node/terminal.ts";
import type { BinaryReader } from "../src/readers.ts";

/** `FileFailed.code` takes exactly the codes of Pi's `FileError`. */
export type FileCodes = Assert<Conform<(typeof FILE_ERROR_CODES)[number], FileErrorCode>>;

/** `ExecFailed.code` takes exactly the codes of Pi's `ExecutionError`. */
export type ExecutionCodes = Assert<Conform<(typeof EXECUTION_ERROR_CODES)[number], ExecutionErrorCode>>;

/** The error classes pi-env exports are exactly those `BY_CLASS` gives a tag of their own. */
export type ErrorClassesTagged = Assert<Conform<keyof typeof BY_CLASS, keyof PiErrorClasses>>;

/** The exports of pi-env whose instances are `Error`s. */
type PiErrorClasses = {
	[K in keyof typeof PiEnv as (typeof PiEnv)[K] extends abstract new (...args: never[]) => Error ? K : never]: true;
};

/**
 * `Env` has every member of Pi's environment interface, but the three readers it opens as resources instead:
 * `textLines`, `binaryReader` and `dirEntries`.
 */
export type EnvCovers = Assert<Covers<ExecutionEnv, Env, "openTextLineReader" | "openBinaryReader" | "openDirReader">>;

/** A binary reader has every member of Pi's, but `close`, which its scope does. */
export type BinaryReaderCovers = Assert<Covers<PiBinaryReader, BinaryReader, "close">>;

/** A connection has every public member of Pi's, but `close`, which its scope does. */
export type ConnectionCovers = Assert<Covers<PiConnection, Connection, "close">>;

/**
 * A request takes Pi's options as `RequestInput`, but the three it handles itself: the signal (interruption), and
 * `onStart` and `onEvent` (`requestEvents`).
 */
export type RequestOptionsSplit = Assert<
	Conform<keyof RequestInput | "signal" | "onStart" | "onEvent", keyof RequestOptions>
>;

/** A process has every public member of Pi's, but `close`, which its scope does. */
export type ProcessCovers = Assert<Covers<RemoteProcess, Process, "close">>;

/** A terminal has every public member of Pi's, but `close`, which its scope does. */
export type TerminalCovers = Assert<Covers<RemoteTerminal, Terminal, "close">>;

/** `ExecResult` is Pi's `ShellExecResult`. */
export type ExecResultConforms = Assert<Conform<ExecResult, ShellExecResult>>;

/** An output chunk of `ExecEvent` is the text Pi's `onOutput` gets with its `ShellOutputInfo`. */
export type ExecOutputConforms = Assert<
	Conform<Omit<Extract<ExecEvent, { readonly kind: "output" }>, "kind">, { text: string } & ShellOutputInfo>
>;

/** `Reply` is Pi's `Reply`, its session branded: a `SessionId` is the number Pi gives. */
export type ReplyConforms = Assert<Conform<Omit<Reply, "session">, Omit<PiReply, "session">>>;
export type ReplySession = Assert<Reply["session"] extends PiReply["session"] ? true : false>;

/** `HostKey.scan` gives what Pi's `scanHostKey` resolves with. */
export type ScannedConforms = Assert<Conform<Scanned, Awaited<ReturnType<typeof scanHostKey>>>>;
