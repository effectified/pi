// Pi's file readers in Effect terms: lines and directory entries as Streams, a binary reader as a scoped resource.

import type {
	ExecutionEnv,
	FileError,
	FileInfo,
	LineScan,
	BinaryReader as PiBinaryReader,
	Result,
	TextLine,
} from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@effectified/pi-chord/context";
import { Effect, Option, type Scope, Stream } from "effect";
import * as Call from "./call.ts";
import { type FileFailed, fromFileError } from "./errors.ts";

/** Positional reads from one opened regular file, which stays the same file even if its path is renamed. */
export interface BinaryReader {
	/** Metadata of the opened file, not of whatever its path names now. */
	readonly info: Effect.Effect<FileInfo, FileFailed>;
	/** Up to `length` bytes at `offset`; fewer only at the end of the file. */
	readonly read: (offset: number, length: number) => Effect.Effect<Uint8Array, FileFailed>;
	/** Where lines `[startLine, endLine)` are, in one pass over the file (Pi's `BinaryReader.scanLines`). */
	readonly scanLines: (options: Parameters<PiBinaryReader["scanLines"]>[0]) => Effect.Effect<LineScan, FileFailed>;
}

/**
 * Opens `path` for positional reads, closed when the scope closes. A directory fails with `is_directory`; with
 * `noFollow`, a symbolic link as the last path component fails with `invalid`.
 */
export function binaryReader(
	env: ExecutionEnv,
	path: string,
	options?: { readonly noFollow?: boolean },
): Effect.Effect<BinaryReader, FileFailed, Scope.Scope> {
	return Effect.map(
		opened((context) => env.openBinaryReader(path, options, context)),
		(reader) => ({
			info: Call.result((context) => reader.info(context), fromFileError),
			read: (offset, length) => Call.result((context) => reader.read(offset, length, context), fromFileError),
			scanLines: (scan) => Call.result((context) => reader.scanLines(scan, context), fromFileError),
		}),
	);
}

/**
 * The lines of a text file, read one at a time as the stream is pulled; each says whether a newline ended it. The
 * reader opens when the stream runs and closes when it ends.
 */
export function textLines(env: ExecutionEnv, path: string): Stream.Stream<TextLine, FileFailed> {
	return Stream.unwrap(
		Effect.map(
			opened((context) => env.openTextLineReader(path, context)),
			(reader) =>
				Stream.paginate(undefined, () =>
					Effect.map(
						Call.result((context) => reader.readLine(context), fromFileError),
						(line): readonly [ReadonlyArray<TextLine>, Option.Option<void>] =>
							line === undefined ? [[], Option.none()] : [[line], Option.some(undefined)],
					),
				),
		),
	);
}

/**
 * The entries of one directory in the order the file system returns them, read `pageSize` at a time as the stream
 * is pulled. Entries that disappear before their metadata is read are skipped, as Pi skips them.
 */
export function dirEntries(env: ExecutionEnv, path: string, pageSize: number): Stream.Stream<FileInfo, FileFailed> {
	return Stream.unwrap(
		Effect.map(
			opened((context) => env.openDirReader(path, context)),
			(reader) =>
				Stream.paginate(undefined, () =>
					Effect.map(
						Call.result((context) => reader.next(pageSize, context), fromFileError),
						(page) => [page.entries, page.done ? Option.none() : Option.some(undefined)] as const,
					),
				),
		),
	);
}

/** A reader `open` gives, closed when the scope closes. */
function opened<R extends { close(context: ChordContext): Promise<void> }>(
	open: (context: ChordContext) => Promise<Result<R, FileError>>,
): Effect.Effect<R, FileFailed, Scope.Scope> {
	return Effect.acquireRelease(Call.result(open, fromFileError), (reader) =>
		Effect.promise(() => reader.close(BACKGROUND_CONTEXT)),
	);
}
