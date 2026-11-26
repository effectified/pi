// An execution environment in Effect terms: Pi's `ExecutionEnv` (local, remote over pi-env, or any other) with its
// file operations as Effects, its readers and command output as Streams, and its watcher as a scoped resource.

import {
	type ExecutionEnv,
	err,
	FileError,
	type FileInfo,
	type FileListing,
	type ListFilesOptions,
	type Result,
	type ShellExecResult,
	type TextLine,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@effectified/pi-chord/context";
import { Context, Effect, Layer, type Scope, type Stream } from "effect";
import * as Call from "./call.ts";
import { type ExecFailed, type FileFailed, fromFileError } from "./errors.ts";
import { type Command, type ExecEvent, type ExecOptions, exec, execOutput } from "./exec.ts";
import { type BinaryReader, binaryReader, dirEntries, textLines } from "./readers.ts";
import * as Watcher from "./watcher.ts";

/**
 * An execution environment. Every operation runs under a Chord context that is cancelled when its fiber is
 * interrupted, and the interrupted fiber waits until Pi settled the operation. Paths are relative to `cwd`.
 */
export interface Env {
	/** Pi's environment, for what takes one as it is, such as a harness (`Harness.layer({ env: env.pi })`). */
	readonly pi: ExecutionEnv;
	/** The file namespace: equal ids see the same files at the same paths. */
	readonly id: string;
	/** The working directory, as Pi holds it now. */
	readonly cwd: Effect.Effect<string>;
	readonly absolutePath: (path: string) => Effect.Effect<string, FileFailed>;
	readonly joinPath: (parts: ReadonlyArray<string>) => Effect.Effect<string, FileFailed>;
	readonly canonicalPath: (path: string) => Effect.Effect<string, FileFailed>;
	readonly exists: (path: string) => Effect.Effect<boolean, FileFailed>;
	readonly fileInfo: (path: string) => Effect.Effect<FileInfo, FileFailed>;
	readonly listDir: (path: string) => Effect.Effect<FileInfo[], FileFailed>;
	/**
	 * The files, directories and links below a directory, bounded by `options`. Fails with `not_supported` when the
	 * environment cannot list (an older daemon, or an environment without `listFiles`): walk with `dirEntries` then.
	 */
	readonly listFiles: (path: string, options?: ListFilesOptions) => Effect.Effect<FileListing, FileFailed>;
	/** A directory's entries as a Stream, read `pageSize` at a time. */
	readonly dirEntries: (path: string, pageSize: number) => Stream.Stream<FileInfo, FileFailed>;
	readonly readTextFile: (path: string) => Effect.Effect<string, FileFailed>;
	readonly readBinaryFile: (path: string) => Effect.Effect<Uint8Array, FileFailed>;
	readonly readTextLines: (
		path: string,
		options?: { readonly maxLines?: number },
	) => Effect.Effect<string[], FileFailed>;
	/** A text file's lines as a Stream, read as it is pulled. */
	readonly textLines: (path: string) => Stream.Stream<TextLine, FileFailed>;
	/** A file opened for positional reads, closed with the scope. */
	readonly binaryReader: (
		path: string,
		options?: { readonly noFollow?: boolean },
	) => Effect.Effect<BinaryReader, FileFailed, Scope.Scope>;
	readonly writeFile: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileFailed>;
	readonly appendFile: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileFailed>;
	/** Truncates or extends a file to exactly `size` bytes. */
	readonly truncateFile: (path: string, size: number) => Effect.Effect<void, FileFailed>;
	/** Flushes a file's contents and the metadata needed to read them back. */
	readonly flushFile: (path: string) => Effect.Effect<void, FileFailed>;
	readonly renameFile: (sourcePath: string, destinationPath: string) => Effect.Effect<void, FileFailed>;
	readonly createDir: (path: string, options?: { readonly recursive?: boolean }) => Effect.Effect<void, FileFailed>;
	readonly remove: (
		path: string,
		options?: { readonly recursive?: boolean; readonly force?: boolean },
	) => Effect.Effect<void, FileFailed>;
	/** A new temporary directory; it stays until removed. */
	readonly createTempDir: (prefix?: string) => Effect.Effect<string, FileFailed>;
	/** A new temporary file; it stays until removed. */
	readonly createTempFile: (options?: {
		readonly prefix?: string;
		readonly suffix?: string;
	}) => Effect.Effect<string, FileFailed>;
	/** Watches files and directories until the scope closes; see `Watcher`. */
	readonly watch: (targets: ReadonlyArray<WatchTarget>) => Effect.Effect<Watcher.Watcher, FileFailed, Scope.Scope>;
	/** Runs a command to its exit; interrupting the fiber kills it. */
	readonly exec: (command: Command, options?: ExecOptions) => Effect.Effect<ShellExecResult, ExecFailed>;
	/** Runs a command as a Stream of its output that ends with its exit; ending the stream early kills it. */
	readonly execOutput: (command: Command, options?: ExecOptions) => Stream.Stream<ExecEvent, ExecFailed>;
	/** Kills every command the environment still runs: for its owner's shutdown, never for one request. */
	readonly cleanup: Effect.Effect<void>;
}

/** The environment a program runs its commands and file operations in. */
export class Current extends Context.Service<Current, Env>()("@effectified/pi-env/Env/Current") {}

/** Pi's environment in Effect terms. It stays the caller's: nothing here cleans it up. */
export function fromPi(pi: ExecutionEnv): Effect.Effect<Env> {
	return Effect.sync(() => wrap(pi));
}

/**
 * `Current` from a scoped Effect that gives Pi's environment and owns it: the Layer cleans it up (kills its
 * commands) when it is released.
 */
export function layer<E, R>(
	acquire: Effect.Effect<ExecutionEnv, E, R>,
): Layer.Layer<Current, E, Exclude<R, Scope.Scope>> {
	return Layer.effect(Current, Effect.map(owned(acquire), wrap));
}

/** Pi's environment from `acquire`, cleaned up (its commands killed) when the scope closes. */
export function owned<E, R>(
	acquire: Effect.Effect<ExecutionEnv, E, R>,
): Effect.Effect<ExecutionEnv, E, R | Scope.Scope> {
	return Effect.acquireRelease(acquire, cleanup);
}

/** Pi's environment as an `Env`. */
function wrap(pi: ExecutionEnv): Env {
	const file = <A>(run: (context: ChordContext) => Promise<Result<A, FileError>>) => Call.result(run, fromFileError);
	return {
		pi,
		id: pi.id,
		cwd: Effect.sync(() => pi.cwd),
		absolutePath: (path) => file((context) => pi.absolutePath(path, context)),
		joinPath: (parts) => file((context) => pi.joinPath([...parts], context)),
		canonicalPath: (path) => file((context) => pi.canonicalPath(path, context)),
		exists: (path) => file((context) => pi.exists(path, context)),
		fileInfo: (path) => file((context) => pi.fileInfo(path, context)),
		listDir: (path) => file((context) => pi.listDir(path, context)),
		listFiles: (path, options) => file((context) => listFiles(pi, path, options, context)),
		dirEntries: (path, pageSize) => dirEntries(pi, path, pageSize),
		readTextFile: (path) => file((context) => pi.readTextFile(path, context)),
		readBinaryFile: (path) => file((context) => pi.readBinaryFile(path, context)),
		readTextLines: (path, options) => file((context) => pi.readTextLines(path, options, context)),
		textLines: (path) => textLines(pi, path),
		binaryReader: (path, options) => binaryReader(pi, path, options),
		writeFile: (path, content) => file((context) => pi.writeFile(path, content, context)),
		appendFile: (path, content) => file((context) => pi.appendFile(path, content, context)),
		truncateFile: (path, size) => file((context) => pi.truncateFile(path, size, context)),
		flushFile: (path) => file((context) => pi.flushFile(path, context)),
		renameFile: (source, destination) => file((context) => pi.renameFile(source, destination, context)),
		createDir: (path, options) => file((context) => pi.createDir(path, options, context)),
		remove: (path, options) => file((context) => pi.remove(path, options, context)),
		createTempDir: (prefix) => file((context) => pi.createTempDir(prefix, context)),
		createTempFile: (options) => file((context) => pi.createTempFile(options, context)),
		watch: (targets) => Watcher.acquire((onChange) => file((context) => pi.watch(targets, onChange, context))),
		exec: (command, options) => exec(pi, command, options),
		execOutput: (command, options) => execOutput(pi, command, options),
		cleanup: cleanup(pi),
	};
}

/** Kills the commands Pi's environment still runs; the owner's shutdown, under no caller's cancellation. */
function cleanup(pi: ExecutionEnv): Effect.Effect<void> {
	return Effect.promise(() => pi.cleanup(BACKGROUND_CONTEXT));
}

/** Pi's optional `listFiles`, or `not_supported` where the environment has none, as Pi's callers expect it. */
function listFiles(
	pi: ExecutionEnv,
	path: string,
	options: ListFilesOptions | undefined,
	context: ChordContext,
): Promise<Result<FileListing, FileError>> {
	if (pi.listFiles === undefined) {
		return Promise.resolve(err(new FileError("not_supported", "The environment does not list files", path)));
	}
	return pi.listFiles(path, options, context);
}
