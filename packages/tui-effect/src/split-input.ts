// Raw terminal input split into whole sequences by pi-tui's `StdinBuffer`, as a Stream.

import { StdinBuffer, type StdinBufferOptions } from "@earendil-works/pi-tui";
import { Array as Arr, Effect, Queue, Schema, Stream } from "effect";

/**
 * One whole input sequence: a key, a mouse report or a terminal reply (`data`), or one bracketed paste (`paste`).
 * `InputSequence.match` takes one handler per `kind`.
 */
export const InputSequence = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("data"), sequence: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("paste"), content: Schema.String }),
]).pipe(Schema.toTaggedUnion("kind"));

/** One whole input sequence. */
export type InputSequence = typeof InputSequence.Type;

/**
 * `chunks` as they come from a terminal, which may cut an escape sequence in two or put several in one, as whole
 * sequences: pi-tui's `StdinBuffer`, so a component sees one key at a time. An incomplete sequence waits for its rest
 * (`options.timeout`, default 50 ms) and a lone ESC for what may follow it (`options.escapeTimeout`, default 10 ms),
 * on pi-tui's own timers; when `chunks` ends, what is still waiting is given as it is. A paste is given whole, without
 * its markers.
 */
export function splitInput<E, R>(
	chunks: Stream.Stream<string, E, R>,
	options?: StdinBufferOptions,
): Stream.Stream<InputSequence, E, R> {
	return Stream.callback<InputSequence, E, R>((queue) =>
		Effect.gen(function* () {
			const buffer = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const created = new StdinBuffer(options);
					created.on("data", (sequence) => Queue.offerUnsafe(queue, { kind: "data", sequence }));
					created.on("paste", (content) => Queue.offerUnsafe(queue, { kind: "paste", content }));
					return created;
				}),
				(created) =>
					Effect.sync(() => {
						created.destroy();
						created.removeAllListeners();
					}),
			);
			yield* Stream.runForEach(chunks, (chunk) => Effect.sync(() => buffer.process(chunk)));
			yield* Queue.offerAll(
				queue,
				Arr.map(buffer.flush(), (sequence): InputSequence => ({ kind: "data", sequence })),
			);
			yield* Queue.end(queue);
		}),
	);
}
