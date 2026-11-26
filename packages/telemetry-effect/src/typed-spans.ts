// The spans of telemetry schemas in Effect: an Effect run in a span of a schema's name, with its attributes and events
// typed as pi-telemetry's typed span starter types them.

import type {
	createTypedSpanStarter,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
} from "@earendil-works/pi-telemetry";
import { Clock, Effect, type Tracer } from "effect";
import { toSpanAttributes } from "./attributes.ts";

/** One or more telemetry schemas, as pi-telemetry's typed helpers take them. */
export type Schemas = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

/** The span names of `S`. */
export type SpanName<S extends Schemas> = S[number] extends infer Schema
	? Schema extends TelemetrySchemaDefinition
		? TelemetrySchemaSpanName<Schema>
		: never
	: never;

/** The schema of `S` that declares the span `Name`. */
type SchemaOf<S extends Schemas, Name extends string> = Extract<S[number], { readonly spans: Record<Name, unknown> }>;

/** The attributes a span of `Name` starts with: pi-telemetry's, required and optional as the schema declares. */
export type StartAttributes<S extends Schemas, Name extends string> = Name extends TelemetrySchemaSpanName<
	SchemaOf<S, Name>
>
	? TelemetrySchemaSpanStartAttributes<SchemaOf<S, Name>, Name>
	: never;

/** The attributes a span of `Name` may be given after its start. */
export type EndAttributes<S extends Schemas, Name extends string> = Name extends TelemetrySchemaSpanName<
	SchemaOf<S, Name>
>
	? TelemetrySchemaSpanEndAttributes<SchemaOf<S, Name>, Name>
	: never;

/** The events a span of `Name` declares. */
export type EventName<S extends Schemas, Name extends string> = Name extends TelemetrySchemaSpanName<SchemaOf<S, Name>>
	? TelemetrySchemaSpanEventName<SchemaOf<S, Name>, Name>
	: never;

/** The attributes of the event `Event` of a span of `Name`. */
export type EventAttributes<
	S extends Schemas,
	Name extends string,
	Event extends string,
> = Name extends TelemetrySchemaSpanName<SchemaOf<S, Name>>
	? Event extends TelemetrySchemaSpanEventName<SchemaOf<S, Name>, Name>
		? TelemetrySchemaSpanEventAttributes<SchemaOf<S, Name>, Name, Event>
		: never
	: never;

/** The attributes argument: required when the attributes have a required one, as pi-telemetry asks. */
type AttributesArgument<A> = Record<string, never> extends A ? [attributes?: A] : [attributes: A];

/** The open span of a schema, as its Effect sees it: pi-telemetry's `SchemaTelemetrySpan`, each record an Effect. */
export interface Span<S extends Schemas, Name extends string> {
	/** The Effect span: its status is its Effect's exit. */
	readonly span: Tracer.Span;
	/** Records the event `event` with its schema's attributes, at the `Clock`'s time. */
	readonly addEvent: <Event extends EventName<S, Name>>(
		event: Event,
		...args: AttributesArgument<EventAttributes<S, Name, Event>>
	) => Effect.Effect<void>;
	/** Sets attributes the schema declares for after the start. */
	readonly setAttributes: (attributes: EndAttributes<S, Name>) => Effect.Effect<void>;
}

/** The spans of `S`, by name. */
export interface TypedSpans<S extends Schemas> {
	/**
	 * `body` in a span `name`, a child of the current span, started with `attributes`; Effects `body` runs in it are
	 * its children, and so are the spans Pi starts on `PiTelemetry.currentSpan` there. The span ends with `body`'s
	 * exit: a failure, a defect or an interruption marks it failed, as Pi's `errorWhen` reads.
	 */
	readonly withSpan: <Name extends SpanName<S>, A, E, R>(
		name: Name,
		attributes: StartAttributes<S, Name>,
		body: (span: Span<S, Name>) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
}

/**
 * The spans `schemas` declare, as pi-telemetry's `createTypedSpanStarter` types them: names, start and end attributes
 * and events. A pure value: the schemas serve the types only, as in Pi, and schemas that declare a span name twice do
 * not type-check. The spans are Effect spans of the fiber's tracer; Pi's own spans join them through `PiTelemetry`.
 */
export function make<const S extends Schemas>(
	_schemas: Parameters<typeof createTypedSpanStarter<S>>[1],
): TypedSpans<S> {
	return {
		withSpan: (name, attributes, body) =>
			Effect.useSpan(name, { attributes: toSpanAttributes(attributes) }, (span) =>
				Effect.withParentSpan(body(handle(span)), span),
			),
	};
}

/** The typed handle of `span`. */
function handle<S extends Schemas, Name extends string>(span: Tracer.Span): Span<S, Name> {
	return {
		span,
		addEvent: (event, ...[attributes]) =>
			Effect.map(Clock.currentTimeNanos, (now) => span.event(event, now, toSpanAttributes(attributes))),
		setAttributes: (attributes) =>
			Effect.sync(() => {
				const defined = toSpanAttributes(attributes);
				for (const name in defined) span.attribute(name, defined[name]);
			}),
	};
}
