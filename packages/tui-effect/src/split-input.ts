// Raw terminal input split into whole sequences by pi-tui's `StdinBuffer`, as a Stream.

import { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "@earendil-works/pi-tui";
import { Effect, Queue, Stream } from "effect";

/** One whole input sequence: a key, a mouse report or a terminal reply (`data`), or one bracketed paste (`paste`). */
export type InputSequence =
	| { readonly kind: "data"; readonly sequence: StdinBufferEventMap["data"][0] }
	| { readonly kind: "paste"; readonly content: StdinBufferEventMap["paste"][0] };

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
			for (const sequence of buffer.flush()) Queue.offerUnsafe(queue, { kind: "data", sequence });
			yield* Queue.end(queue);
		}),
	);
}
