// An execution environment in Effect terms: Pi's `ExecutionEnv` (local, remote over pi-env, or any other) with its
// file operations as Effects, its readers and command output as Streams, and its watcher as a scoped resource.

import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@effectified/pi-chord/context";
import type {
	ExecutionEnv,
	FileError,
	FileInfo,
	FileListing,
	ListFilesOptions,
	Result,
	TextLine,
	WatchTarget,
} from "@effectified/pi-durable/env";
import { Context, Effect, Layer, Schema, type Scope, Stream } from "effect";
import * as Call from "./call.ts";
import { type ExecFailed, FileFailed, fromFileError } from "./errors.ts";
import { type Command, type ExecEvent, type ExecOptions, type ExecResult, exec, execOutput } from "./exec.ts";
import { type BinaryReader, binaryReader, dirEntries, textLines } from "./readers.ts";
import * as Watcher from "./watcher.ts";

/**
 * The file namespace of an environment (Pi's `ExecutionEnv.id`): equal ids see the same files at the same paths,
 * whatever their `cwd`. Every local Node environment shares one; each container or remote host has its own.
 */
export const Id = Schema.String.pipe(Schema.brand("EnvId"));

/** The file namespace of an environment. */
export type Id = typeof Id.Type;

/**
 * An execution environment. Every operation runs under a Chord context that is cancelled when its fiber is
 * interrupted, and the interrupted fiber waits until Pi settled the operation. Paths are relative to `cwd`. Each
 * operation is a span named for it (`Env.readTextFile`), the parent of the spans Pi starts for it.
 */
export interface Env {
	/** Pi's environment, for what takes one as it is, such as a harness (`Harness.layer({ env: env.pi })`). */
	readonly pi: ExecutionEnv;
	/** The file namespace: equal ids see the same files at the same paths. */
	readonly id: Id;
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
	readonly exec: (command: Command, options?: ExecOptions) => Effect.Effect<ExecResult, ExecFailed>;
	/** Runs a command as a Stream of its output that ends with its exit; ending the stream early kills it. */
	readonly execOutput: (command: Command, options?: ExecOptions) => Stream.Stream<ExecEvent, ExecFailed>;
	/** Kills every command the environment still runs: for its owner's shutdown, never for one request. */
	readonly cleanup: Effect.Effect<void>;
}

/** The environment a program runs its commands and file operations in. */
export class Current extends Context.Service<Current, Env>()("@effectified/pi-env/env/Current") {}

/** Pi's environment in Effect terms. It stays the caller's: nothing here cleans it up. */
export const fromPi = Effect.fn("Env.fromPi")((pi: ExecutionEnv) => Effect.sync(() => wrap(pi)));

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
export const owned = Effect.fn("Env.owned")(function* <E, R>(acquire: Effect.Effect<ExecutionEnv, E, R>) {
	return yield* Effect.acquireRelease(acquire, cleanup);
});

/** Pi's environment as an `Env`, each operation an `Effect.fn` with its span. */
function wrap(pi: ExecutionEnv): Env {
	const file = <A>(run: (context: ChordContext) => Promise<Result<A, FileError>>) => Call.result(run, fromFileError);
	const listFiles = pi.listFiles?.bind(pi);
	return {
		pi,
		id: Id.make(pi.id),
		cwd: Effect.sync(() => pi.cwd),
		absolutePath: Effect.fn("Env.absolutePath")((path: string) => file((context) => pi.absolutePath(path, context))),
		joinPath: Effect.fn("Env.joinPath")((parts: ReadonlyArray<string>) =>
			file((context) => pi.joinPath([...parts], context)),
		),
		canonicalPath: Effect.fn("Env.canonicalPath")((path: string) =>
			file((context) => pi.canonicalPath(path, context)),
		),
		exists: Effect.fn("Env.exists")((path: string) => file((context) => pi.exists(path, context))),
		fileInfo: Effect.fn("Env.fileInfo")((path: string) => file((context) => pi.fileInfo(path, context))),
		listDir: Effect.fn("Env.listDir")((path: string) => file((context) => pi.listDir(path, context))),
		// Pi's `listFiles` is optional; its callers expect `not_supported` where an environment has none.
		listFiles: Effect.fn("Env.listFiles")((path: string, options?: ListFilesOptions) =>
			listFiles === undefined
				? Effect.fail(
						FileFailed.make({ code: "not_supported", message: "The environment does not list files", path }),
					)
				: file((context) => listFiles(path, options, context)),
		),
		dirEntries: (path, pageSize) => dirEntries(pi, path, pageSize).pipe(Stream.withSpan("Env.dirEntries")),
		readTextFile: Effect.fn("Env.readTextFile")((path: string) => file((context) => pi.readTextFile(path, context))),
		readBinaryFile: Effect.fn("Env.readBinaryFile")((path: string) =>
			file((context) => pi.readBinaryFile(path, context)),
		),
		readTextLines: Effect.fn("Env.readTextLines")((path: string, options?: { readonly maxLines?: number }) =>
			file((context) => pi.readTextLines(path, options, context)),
		),
		textLines: (path) => textLines(pi, path).pipe(Stream.withSpan("Env.textLines")),
		binaryReader: Effect.fn("Env.binaryReader")((path: string, options?: { readonly noFollow?: boolean }) =>
			binaryReader(pi, path, options),
		),
		writeFile: Effect.fn("Env.writeFile")((path: string, content: string | Uint8Array) =>
			file((context) => pi.writeFile(path, content, context)),
		),
		appendFile: Effect.fn("Env.appendFile")((path: string, content: string | Uint8Array) =>
			file((context) => pi.appendFile(path, content, context)),
		),
		truncateFile: Effect.fn("Env.truncateFile")((path: string, size: number) =>
			file((context) => pi.truncateFile(path, size, context)),
		),
		flushFile: Effect.fn("Env.flushFile")((path: string) => file((context) => pi.flushFile(path, context))),
		renameFile: Effect.fn("Env.renameFile")((source: string, destination: string) =>
			file((context) => pi.renameFile(source, destination, context)),
		),
		createDir: Effect.fn("Env.createDir")((path: string, options?: { readonly recursive?: boolean }) =>
			file((context) => pi.createDir(path, options, context)),
		),
		remove: Effect.fn("Env.remove")(
			(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
				file((context) => pi.remove(path, options, context)),
		),
		createTempDir: Effect.fn("Env.createTempDir")((prefix?: string) =>
			file((context) => pi.createTempDir(prefix, context)),
		),
		createTempFile: Effect.fn("Env.createTempFile")(
			(options?: { readonly prefix?: string; readonly suffix?: string }) =>
				file((context) => pi.createTempFile(options, context)),
		),
		watch: Effect.fn("Env.watch")((targets: ReadonlyArray<WatchTarget>) =>
			Watcher.acquire((onChange) => file((context) => pi.watch(targets, onChange, context))),
		),
		exec: Effect.fn("Env.exec")((command: Command, options?: ExecOptions) => exec(pi, command, options)),
		execOutput: (command, options) => execOutput(pi, command, options).pipe(Stream.withSpan("Env.execOutput")),
		cleanup: cleanup(pi).pipe(Effect.withSpan("Env.cleanup")),
	};
}

/** Kills the commands Pi's environment still runs; the owner's shutdown, under no caller's cancellation. */
function cleanup(pi: ExecutionEnv): Effect.Effect<void> {
	return Effect.promise(() => pi.cleanup(BACKGROUND_CONTEXT));
}
