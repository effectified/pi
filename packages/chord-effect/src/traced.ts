// A Chord context under the calling fiber's current Effect span, for the contexts this package makes.

import { type Context, withTelemetry } from "@earendil-works/chord/context";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { Effect, Option, Tracer } from "effect";

/**
 * `parent` with the Pi handle of the fiber's current Effect span (`PiTelemetry.currentSpan`) as its telemetry; `parent`
 * itself when the fiber is in no span or the program has no `PiTelemetry`. `PiTelemetry` is read as an option, so a
 * program without telemetry needs to provide nothing.
 */
export function traced(parent: Context): Effect.Effect<Context> {
	return Effect.gen(function* () {
		const telemetry = yield* Effect.serviceOption(PiTelemetry);
		if (Option.isNone(telemetry) || Option.isNone(yield* Effect.serviceOption(Tracer.ParentSpan))) return parent;
		const span = yield* Effect.provideService(PiTelemetry.currentSpan, PiTelemetry, telemetry.value);
		return withTelemetry(span, parent);
	});
}
