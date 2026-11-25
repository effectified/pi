// Pi Durable's clock options (`now`, `setTimer`) from Effect's `Clock`, so a `TestClock` drives Pi's sleeps.

import type { HarnessOptions } from "@earendil-works/pi-durable";
import { Duration, Effect, FiberSet, type Scope } from "effect";

/**
 * The `now` and `setTimer` of a harness on the `Clock` of the context: Pi's sleeps, retry backoffs and deadlines are
 * read from it and armed on it. Background timers are armed too, so a harness frees idle memory as on Pi's default
 * timers; Effect's clock cannot unreference a timer, so a pending one keeps a Node.js process alive until the
 * harness closes, which disarms it. Each timer is a fiber of the scope: closing it interrupts every timer still
 * armed, one Pi never disarmed included, so none fires after it. Made before the harness opens, it closes after it.
 */
export const clockOptions: Effect.Effect<
	Required<Pick<HarnessOptions, "now" | "setTimer">>,
	never,
	Scope.Scope
> = Effect.clockWith((clock) =>
	Effect.map(FiberSet.makeRuntime(), (run) => ({
		now: () => clock.currentTimeMillisUnsafe(),
		setTimer: (callback, delayMs) => {
			const fiber = run(Effect.andThen(clock.sleep(Duration.millis(delayMs)), Effect.sync(callback)));
			return () => fiber.interruptUnsafe();
		},
	})),
);
