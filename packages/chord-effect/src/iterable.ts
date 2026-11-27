// Chord's async iterables (archives, JSONL) as Streams, and Streams as the iterables Chord reads.

import type { Context } from "@earendil-works/chord/context";
import { Effect, Option, Ref, Stream } from "effect";
import { scoped } from "./chord-context.ts";

/**
 * The iterable `open` gives as a Stream. `open` gets a Chord context under the fiber's span, aborted when the stream's
 * scope closes, so a consumer that stops early ends what Chord holds for the iteration (an export holds the store's
 * commit queue). What `open` or the iteration throws goes to `rejected`.
 */
export function fromIterable<A, E>(
	open: (context: Context) => AsyncIterable<A>,
	rejected: (thrown: unknown) => Effect.Effect<never, E>,
): Stream.Stream<A, E> {
	return Stream.unwrap(
		Effect.map(scoped(), (context) => {
			let iterable: AsyncIterable<A>;
			try {
				// Chord checks some arguments when the iterable is made, before the iteration.
				iterable = open(context);
			} catch (thrown) {
				return Stream.fromEffect(rejected(thrown));
			}
			return Stream.catch(
				Stream.fromAsyncIterable(iterable, (thrown) => thrown),
				(thrown) => Stream.fromEffect(rejected(thrown)),
			);
		}),
	);
}

/** A Stream handed to Chord as an iterable, and its own failure, kept apart from what Chord rejects with. */
export interface Input<A, E> {
	readonly iterable: AsyncIterable<A>;
	/**
	 * What a rejection of the Chord call that read `iterable` fails with: the Stream's own failure once it failed (Chord
	 * rejects with it as it reads), else what `otherwise` makes of the rejection.
	 */
	readonly rejected: <F>(
		otherwise: (thrown: unknown) => Effect.Effect<never, F>,
	) => (thrown: unknown) => Effect.Effect<never, E | F>;
}

/** `stream` as an iterable Chord reads, run with the services of the calling fiber. */
export const toIterable = Effect.fnUntraced(function* <A, E, R>(
	stream: Stream.Stream<A, E, R>,
): Effect.fn.Return<Input<A, E>, never, R> {
	const context = yield* Effect.context<R>();
	const failure = yield* Ref.make(Option.none<E>());
	const tracked = Stream.tapError(stream, (error) => Ref.set(failure, Option.some(error)));
	const input: Input<A, E> = {
		iterable: Stream.toAsyncIterableWith(tracked, context),
		rejected:
			<F>(otherwise: (thrown: unknown) => Effect.Effect<never, F>) =>
			(thrown: unknown) =>
				Effect.flatMap(
					Ref.get(failure),
					Option.match({
						onNone: (): Effect.Effect<never, E | F> => otherwise(thrown),
						onSome: Effect.fail,
					}),
				),
	};
	return input;
});
