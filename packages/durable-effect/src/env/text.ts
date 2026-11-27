// The text of a file's bytes as an environment reads them: Pi's streaming decoders and line scanner over Streams.

import { type LineScan, LineScanner, rangeDecoder, StreamDecoder } from "@earendil-works/pi-durable/env";
import { Effect, Stream } from "effect";
import { UnexpectedError } from "../errors.ts";

/**
 * The text of a whole stream of bytes, chunk by chunk: what decoding all of it at once as UTF-8 gives, a leading
 * byte-order mark dropped (Pi's `StreamDecoder`). A character split across chunks comes with the chunk that ends it.
 */
export function decodeText<E, R>(bytes: Stream.Stream<Uint8Array, E, R>): Stream.Stream<string, E, R> {
	return Stream.suspend(() => {
		const decoder = new StreamDecoder();
		return decoded(bytes, (chunk) => decoder.decode(chunk));
	});
}

/**
 * The text of a range of a file's bytes, chunk by chunk (Pi's `rangeDecoder`): as `decodeText`, but a leading
 * U+FEFF is kept, since a range that does not start the file has no byte-order mark. A caller that starts at the
 * beginning of the file drops a leading mark itself (`startsWithBom`).
 */
export function decodeRange<E, R>(bytes: Stream.Stream<Uint8Array, E, R>): Stream.Stream<string, E, R> {
	return Stream.suspend(() => {
		const decoder = rangeDecoder();
		return decoded(bytes, (chunk) =>
			chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }),
		);
	});
}

/** `bytes` decoded by `decode`, called once more without a chunk at the end; empty pieces left out. */
function decoded<E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>,
	decode: (chunk?: Uint8Array) => string,
): Stream.Stream<string, E, R> {
	return Stream.filter(
		Stream.concat(
			Stream.map(bytes, (chunk) => decode(chunk)),
			Stream.fromEffect(Effect.sync(() => decode())),
		),
		(text) => text !== "",
	);
}

/** Which lines `scanLines` selects: from `startLine` (0-based) to before `endLine`, or to the end without it. */
export interface LineRange {
	readonly startLine: number;
	readonly endLine?: number;
}

/**
 * Where the lines of `range` are in a file whose bytes `bytes` gives in order, in one pass and bounded memory (Pi's
 * `LineScanner`): what an environment's `BinaryReader.scanLines` answers. Fails with `UnexpectedError` for a range
 * Pi refuses: `startLine` not an integer `0` or more, or `endLine` not an integer past it.
 */
export function scanLines<E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>,
	range: LineRange,
): Effect.Effect<LineScan, E | UnexpectedError, R> {
	return Effect.flatMap(
		Effect.try({
			try: () => new LineScanner(range.startLine, range.endLine),
			catch: (cause) => UnexpectedError.make({ cause }),
		}),
		(scanner) =>
			Effect.map(
				Stream.runForEach(bytes, (chunk) => Effect.sync(() => scanner.push(chunk))),
				() => scanner.finish(),
			),
	);
}
