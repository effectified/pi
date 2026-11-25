// pi-telemetry's metric instruments on Effect's `Metric`: each Pi instrument updates the Effect metric of its name.

import type {
	HistogramOptions,
	InstrumentOptions,
	SpanAttributes,
	TelemetryMetrics,
} from "@earendil-works/pi-telemetry";
import { type Context, Metric } from "effect";
import { toMetricAttributes } from "./attributes.ts";

/**
 * Pi's metric capability on the metric registry of `context`. A counter is an incremental Effect counter, an up-down
 * counter a counter that may go down, a histogram an Effect histogram. A measurement's attributes select the series;
 * the instrument's `unit` is the metric attribute `unit`, where Effect's exporters read it. A histogram's exemplar
 * context is not used: Effect metrics have no exemplars.
 */
export function makeMetrics(context: Context.Context<never>): TelemetryMetrics {
	const record =
		(metric: Metric.Metric<number, unknown>) =>
		(value: number, attributes?: SpanAttributes): void => {
			const series =
				attributes === undefined ? metric : Metric.withAttributes(metric, toMetricAttributes(attributes));
			series.updateUnsafe(value, context);
		};
	return {
		counter: (name, options) => ({ add: record(Metric.counter(name, { ...metadata(options), incremental: true })) }),
		upDownCounter: (name, options) => ({ add: record(Metric.counter(name, metadata(options))) }),
		histogram: (name, options) => ({
			record: record(
				Metric.histogram(name, { ...metadata(options), boundaries: [...(options?.boundaries ?? BOUNDARIES)] }),
			),
		}),
	};
}

/**
 * The buckets of a histogram Pi declares without boundaries (Effect requires them): the OpenTelemetry SDK's default
 * explicit bucket boundaries, which suit the millisecond durations Pi records.
 */
const BOUNDARIES: readonly number[] = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

/** An instrument's description and unit as the options of an Effect metric. */
function metadata(options: InstrumentOptions | HistogramOptions | undefined): {
	readonly description: string | undefined;
	readonly attributes: Metric.Metric.AttributeSet | undefined;
} {
	return {
		description: options?.description,
		attributes: options?.unit === undefined ? undefined : { unit: options.unit },
	};
}
