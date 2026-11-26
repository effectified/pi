// A Chord context made from Effect: cancelled when its scope closes or after a span of the Clock, under the fiber's
// current span, awaited as an Effect.

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type Duration, Effect, type Scope } from "effect";
import { traced } from "./traced.ts";

/**
 * A child of `parent` (default: Chord's background context) that is cancelled when the current scope closes, so the
 * Pi calls made with it end with the fiber that owns the scope: interrupting the fiber closes its scope and aborts
 * the context. A scope that closes after a success or a failure aborts it too: the context lives as long as its
 * scope. Its telemetry is the fiber's current Effect span when the program provides `PiTelemetry`, so the spans Pi
 * starts under it are children of that span; outside any span, or without `PiTelemetry`, it is the parent's. The
 * parent's values and cancellation are kept.
 */
export function scoped(parent: Context = BACKGROUND_CONTEXT): Effect.Effect<Context, never, Scope.Scope> {
	return Effect.map(controlled(parent), ({ context }) => context);
}

/**
 * A child of `parent` that is cancelled after `duration` of the `Clock`, with the reason `AbortSignal.timeout` gives
 * (a `DOMException` named `TimeoutError`), or when the current scope closes, whichever comes first. A test moves the
 * deadline with `TestClock.adjust`. Its telemetry is the fiber's current span, as for `scoped`.
 */
export function timeout(
	duration: Duration.Input,
	parent: Context = BACKGROUND_CONTEXT,
): Effect.Effect<Context, never, Scope.Scope> {
	return Effect.gen(function* () {
		const { context, controller } = yield* controlled(parent);
		yield* Effect.forkScoped(
			Effect.andThen(
				Effect.sleep(duration),
				Effect.sync(() => controller.abort(new DOMException("signal timed out", "TimeoutError"))),
			),
			{ startImmediately: true },
		);
		return context;
	});
}

/**
 * Completes with the abort reason once `context` is cancelled, at once when it already is, and never when it cannot
 * be (no signal). Race a wait against it to end the wait with the context, as Chord's `awaitWithContext` does.
 */
export function aborted(context: Context): Effect.Effect<unknown> {
	const signal = context.abortSignal;
	if (signal === undefined) return Effect.never;
	return Effect.callback<unknown>((resume) => {
		if (signal.aborted) return resume(Effect.succeed(signal.reason));
		const onAbort = (): void => resume(Effect.succeed(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}

/** A child of `parent` under the fiber's current span, with a signal of its own, aborted when the current scope closes. */
function controlled(
	parent: Context,
): Effect.Effect<{ readonly context: Context; readonly controller: AbortController }, never, Scope.Scope> {
	return Effect.flatMap(traced(parent), (under) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const controller = new AbortController();
				return { context: withAbortSignal(controller.signal, under), controller };
			}),
			({ controller }) => Effect.sync(() => controller.abort()),
		),
	);
}
