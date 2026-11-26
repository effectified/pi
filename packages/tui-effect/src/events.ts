// A component's callback property (`onSubmit`, `onChange`, `onSelect`, ...) as a Stream of what it is called with.

import { Effect, Queue, Stream } from "effect";

/**
 * The keys of `T` named `on...` that hold an optional callback of one argument or none, such as `Editor`'s
 * `onSubmit` and `onChange`, `Input`'s `onEscape`, `SelectList`'s `onSelect` and `onCancel`, the TUI's `onDebug`.
 */
export type EventKey<T> = {
	[K in keyof T]-?: K extends `on${string}`
		? NonNullable<T[K]> extends (...args: infer P) => void
			? P extends [] | [unknown]
				? K
				: never
			: never
		: never;
}[keyof T];

/** What a callback of `EventKey` is called with: its argument, or `undefined` for a callback of none. */
export type EventOf<F> = F extends (...args: infer P) => void ? (P extends [infer A] ? A : undefined) : never;

/**
 * Each call of `target[key]` while the stream runs, as an element: an `Editor`'s submitted texts with `"onSubmit"`, a
 * `SelectList`'s chosen items with `"onSelect"`. The stream sets the callback when it starts and puts the one before
 * back when it ends, so one stream at a time listens to a callback.
 */
export function events<T extends object, K extends EventKey<T>>(
	target: T,
	key: K,
): Stream.Stream<EventOf<NonNullable<T[K]>>> {
	type Event = EventOf<NonNullable<T[K]>>;
	// `EventKey` makes `target[key]` an optional callback of at most one argument; TypeScript cannot narrow `T[K]` from it.
	const slot = target as unknown as Record<K, ((event: Event) => void) | undefined>;
	return Stream.callback<Event>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const previous = slot[key];
				const handler = (event: Event): void => void Queue.offerUnsafe(queue, event);
				slot[key] = handler;
				return { previous, handler };
			}),
			({ previous, handler }) =>
				Effect.sync(() => {
					if (slot[key] === handler) slot[key] = previous;
				}),
		),
	);
}
