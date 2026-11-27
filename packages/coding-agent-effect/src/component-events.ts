// A component of interactive mode whose constructor takes callbacks, made with callbacks that feed a Stream of what
// they are called with: the shared form of the selectors and dialogs.

import { type Cause, Effect, Queue, type Scope, Stream } from "effect";

/** What the callback `F` is called with. */
type Args<F> = F extends (...args: infer P) => unknown ? P : never;

/** One call of a callback of `C`: the callback's name in `C`, and the arguments Pi called it with. */
export type ComponentEvent<C> = {
	[K in keyof C]-?: { readonly kind: K; readonly args: Args<NonNullable<C[K]>> };
}[keyof C];

/** A component of interactive mode and what the user does in it. */
export interface WithEvents<A, C> {
	/** Pi's component: add it to a container or show it as an overlay, and give it focus. */
	readonly component: A;
	/** Each call of the component's callbacks, in order, until the scope closes. */
	readonly events: Stream.Stream<ComponentEvent<C>>;
}

/** The callback named `kind` in `C`, which hands each of its calls to the events. */
export type Emit<C> = <K extends keyof C>(kind: K) => (...args: Args<NonNullable<C[K]>>) => void;

/**
 * The component `make` builds with the callbacks of `emit`, and their calls as a Stream until the scope closes.
 * `release`, when given, stops what the component runs on its own (a timer, a request) when the scope closes.
 * Untraced: the dialog or selector that makes the component is the span.
 */
export const withEvents = Effect.fnUntraced(function* <A, C>(
	make: (emit: Emit<C>) => A,
	release?: (component: A) => void,
): Effect.fn.Return<WithEvents<A, C>, never, Scope.Scope> {
	// Ended, not shut down, when the scope closes: the events stream ends, and what was not taken yet stays to take.
	// Unbounded: Pi's callbacks cannot wait.
	const queue = yield* Effect.acquireRelease(Queue.unbounded<ComponentEvent<C>, Cause.Done>(), Queue.end);
	// `{ kind, args }` is the member of `ComponentEvent<C>` for `kind`; TypeScript cannot pick it from the union.
	const emit: Emit<C> =
		(kind) =>
		(...args) =>
			void Queue.offerUnsafe(queue, { kind, args } as unknown as ComponentEvent<C>);
	const component =
		release === undefined
			? make(emit)
			: yield* Effect.acquireRelease(
					Effect.sync(() => make(emit)),
					(made) => Effect.sync(() => release(made)),
				);
	return { component, events: Stream.fromQueue(queue) };
});
