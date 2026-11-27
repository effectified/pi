// The telemetry adapter as an Effect service and Layer, and the Pi handle of the current Effect span.

import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Context, Effect, Layer, Tracer } from "effect";
import { makeTelemetryContext, spanHandle } from "./adapter.ts";

/**
 * The pi-telemetry adapter of this program. The service value is pi-telemetry's own `TelemetryContext`, so it can be
 * handed to anything that takes one (`HarnessOptions.telemetry` of a Pi Durable harness).
 */
export class PiTelemetry extends Context.Service<PiTelemetry, TelemetryContext>()(
	"@effectified/pi-telemetry/pi-telemetry/PiTelemetry",
) {
	/**
	 * The adapter on the `Tracer`, `Clock`, metric registry and loggers of the context the Layer is built in. It has
	 * no finalizer: pi-telemetry's contract has no shutdown or flush step, a span ends when its Pi callback settles,
	 * and the Layer of an exporting tracer flushes what it holds when its own scope closes.
	 */
	static readonly layer: Layer.Layer<PiTelemetry> = Layer.effect(PiTelemetry, makeTelemetryContext);

	/**
	 * The Pi span handle of the current Effect span: put it into the context a Pi call takes, and the spans Pi starts
	 * are children of the Effect span this was read in. Outside any span the handle starts root spans.
	 */
	static readonly currentSpan: Effect.Effect<TelemetrySpan, never, PiTelemetry> = Effect.gen(function* () {
		const telemetry = yield* PiTelemetry;
		const span = yield* Effect.serviceOption(Tracer.ParentSpan);
		return spanHandle(telemetry, span);
	});
}
