// pi-tui's spinners as scoped components: animating from when they are made until the scope closes.

import { CancellableLoader, Loader, type TUI } from "@earendil-works/pi-tui";
import { Effect, type Scope } from "effect";
import { Tui } from "./tui-service.ts";

/** What pi-tui's `Loader` takes after the TUI: the spinner's and the message's color, the message, the indicator. */
export type LoaderArgs = ConstructorParameters<typeof Loader> extends [TUI, ...infer Rest] ? Rest : never;

/**
 * A spinner with a message for the running TUI (pi-tui's `Loader`), animating on pi-tui's own timer until the scope
 * closes. Add it to a container to show it; `setMessage` changes the message.
 */
export function loader(...args: LoaderArgs): Effect.Effect<Loader, never, Tui | Scope.Scope> {
	return Effect.acquireRelease(
		Tui.useSync((tui) => new Loader(tui, ...args)),
		(made) => Effect.sync(() => made.stop()),
	);
}

/**
 * A spinner the user can cancel (pi-tui's `CancellableLoader`, the `tui.select.cancel` keybinding while it has
 * focus), animating until the scope closes. `untilCancelled` ends work when the user cancels.
 */
export function cancellableLoader(...args: LoaderArgs): Effect.Effect<CancellableLoader, never, Tui | Scope.Scope> {
	return Effect.acquireRelease(
		Tui.useSync((tui) => new CancellableLoader(tui, ...args)),
		(made) => Effect.sync(() => made.dispose()),
	);
}

/**
 * `effect`, interrupted when the user cancels `cancellable`, or at once if they already did: the Effect form of
 * pi-tui's `signal` and `onAbort`.
 */
export function untilCancelled<A, E, R>(
	cancellable: CancellableLoader,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
	// A work that completes without waiting would win a race with a cancel made before: check it first.
	return Effect.suspend(() =>
		cancellable.aborted
			? Effect.interrupt
			: Effect.raceFirst(effect, Effect.andThen(cancelled(cancellable.signal), Effect.interrupt)),
	);
}

/** Completes once `signal` is aborted. */
function cancelled(signal: AbortSignal): Effect.Effect<void> {
	return Effect.callback<void>((resume) => {
		const onAbort = (): void => resume(Effect.void);
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}
