// The metrics of telemetry schemas in Effect: pi-telemetry's typed instruments on `PiTelemetry`, measured as Effects.

import {
	createTypedMetrics,
	NOOP_TELEMETRY_METRICS,
	type SchemaTelemetryCounter,
	type SchemaTelemetryHistogram,
	type TypedTelemetryMetrics,
} from "@earendil-works/pi-telemetry";
import { Effect } from "effect";
import { PiTelemetry } from "./pi-telemetry.ts";
import type { Schemas } from "./typed-spans.ts";

/** The metric definition `Name` has in one of `S`. */
type MetricDefinition<S extends Schemas, Name extends string> = S[number] extends infer Schema
	? Schema extends { readonly metrics: infer Metrics }
		? Name extends keyof Metrics
			? Metrics[Name]
			: never
		: never
	: never;

/** A counter of a schema: pi-telemetry's measurement arguments, the measurement an Effect. */
export interface Counter<S extends Schemas, Name extends string> {
	readonly add: (...args: Parameters<SchemaTelemetryCounter<MetricDefinition<S, Name>>["add"]>) => Effect.Effect<void>;
}

/** A histogram of a schema: pi-telemetry's measurement arguments, the measurement an Effect. */
export interface Histogram<S extends Schemas, Name extends string> {
	readonly record: (
		...args: Parameters<SchemaTelemetryHistogram<MetricDefinition<S, Name>>["record"]>
	) => Effect.Effect<void>;
}

/** The instruments of `S` by name and kind, as pi-telemetry's `TypedTelemetryMetrics` names them. */
export interface TypedMetrics<S extends Schemas> {
	readonly counter: <Name extends Parameters<TypedTelemetryMetrics<S>["counter"]>[0]>(name: Name) => Counter<S, Name>;
	readonly upDownCounter: <Name extends Parameters<TypedTelemetryMetrics<S>["upDownCounter"]>[0]>(
		name: Name,
	) => Counter<S, Name>;
	readonly histogram: <Name extends Parameters<TypedTelemetryMetrics<S>["histogram"]>[0]>(
		name: Name,
	) => Histogram<S, Name>;
}

/**
 * pi-telemetry's `createTypedMetrics` on the metrics of `PiTelemetry`: the instruments `schemas` declare, with their
 * descriptions, units and boundaries, each measurement an Effect. They update the Effect metrics of their names, the
 * series Pi's own instruments update. Schemas that declare a metric name twice do not type-check, as in Pi.
 */
export function make<const S extends Schemas>(
	schemas: Parameters<typeof createTypedMetrics<S>>[1],
): Effect.Effect<TypedMetrics<S>, never, PiTelemetry> {
	return Effect.map(Effect.service(PiTelemetry), (telemetry) => {
		// Pi's instruments take exactly the arguments `Counter` and `Histogram` derive from their types, per name; one
		// implementation for every name sees them with the loose signature of `Loose`.
		const typed = createTypedMetrics(telemetry.metrics ?? NOOP_TELEMETRY_METRICS, schemas) as unknown as Loose;
		const measured: LooseMeasured = {
			counter: (name) => {
				const instrument = typed.counter(name);
				return { add: (...args) => Effect.sync(() => instrument.add(...args)) };
			},
			upDownCounter: (name) => {
				const instrument = typed.upDownCounter(name);
				return { add: (...args) => Effect.sync(() => instrument.add(...args)) };
			},
			histogram: (name) => {
				const instrument = typed.histogram(name);
				return { record: (...args) => Effect.sync(() => instrument.record(...args)) };
			},
		};
		return measured as unknown as TypedMetrics<S>;
	});
}

/** pi-telemetry's typed metrics, seen by one implementation for every name. */
interface Loose {
	readonly counter: (name: string) => { readonly add: (...args: readonly unknown[]) => void };
	readonly upDownCounter: (name: string) => { readonly add: (...args: readonly unknown[]) => void };
	readonly histogram: (name: string) => { readonly record: (...args: readonly unknown[]) => void };
}

/** `TypedMetrics`, seen by one implementation for every name. */
interface LooseMeasured {
	readonly counter: (name: string) => { readonly add: (...args: readonly unknown[]) => Effect.Effect<void> };
	readonly upDownCounter: (name: string) => { readonly add: (...args: readonly unknown[]) => Effect.Effect<void> };
	readonly histogram: (name: string) => { readonly record: (...args: readonly unknown[]) => Effect.Effect<void> };
}
