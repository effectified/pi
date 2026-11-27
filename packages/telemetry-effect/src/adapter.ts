// pi-telemetry's adapter contract on Effect: a Pi span is an Effect span of the tracer the adapter was built with.

import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { Array as Arr, Clock, Context, Effect, Exit, Option, Predicate, References, Result, Tracer } from "effect";
import { setSpanAttributes, toSpanAttributes } from "./attributes.ts";
import { makeMetrics } from "./metrics.ts";
import { fromCarrier, toCarrier } from "./trace-context.ts";

/**
 * A pi-telemetry adapter on the services of the context it is made in: its `Tracer` creates the spans, its `Clock`
 * stamps their ends and events, its metric registry takes the measurements, and its loggers take the events that have
 * no span. The result starts root spans; it is what a host hands to Pi (`HarnessOptions.telemetry`).
 */
export const makeTelemetryContext: Effect.Effect<TelemetryContext> = Effect.map(
	Effect.context<never>(),
	(context): TelemetryContext => {
		const clock = Context.get(context, Clock.Clock);
		const adapter: Adapter = {
			// A span that is current while the adapter is made is not the parent of what the adapter logs later.
			context: Context.omit(Tracer.ParentSpan)(context),
			// As Effect ends its own spans: no clock read when span timing is switched off.
			now: Context.get(context, References.TracerTimingEnabled) ? () => clock.currentTimeNanosUnsafe() : () => ZERO,
			metrics: makeMetrics(context),
			propagation: {
				inject: (target) => {
					const span = spans.get(target);
					return span === undefined ? undefined : toCarrier(span);
				},
				extract: (carrier) =>
					Option.match(fromCarrier(carrier), {
						onNone: () => root,
						onSome: (parent) => parentHandle(adapter, parent),
					}),
			},
		};
		const root = parentHandle(adapter, undefined);
		adapters.set(root, adapter);
		return root;
	},
);

/**
 * The Pi span handle of an Effect span, for Pi code called from inside it: the spans Pi starts on the handle are
 * children of `span`, and Pi's events, attributes and links are recorded on `span` while it is open. Its status is
 * not Pi's to set: the Effect that owns the span ends it with its exit. Without a span that can record (none, or an
 * external one) the handle starts spans under that parent and sends events to the logger. A `telemetry` that
 * `makeTelemetryContext` did not make cannot take an Effect span as a parent: its handle starts that adapter's root
 * spans and records nothing else.
 */
export function spanHandle(telemetry: TelemetryContext, span: Option.Option<Tracer.AnySpan>): TelemetrySpan {
	const adapter = adapters.get(telemetry);
	if (adapter === undefined) {
		return {
			...NOOP_TELEMETRY_CONTEXT,
			metrics: telemetry.metrics,
			propagation: telemetry.propagation,
			startSpan: (options, callback) => telemetry.startSpan(options, callback),
		};
	}
	const current = Option.getOrUndefined(span);
	return current?._tag === "Span" ? recordingHandle(adapter, current, () => {}) : parentHandle(adapter, current);
}

/** What all contexts of one adapter share: where its Effects run, its clock, and the capabilities Pi reads. */
interface Adapter {
	readonly context: Context.Context<never>;
	readonly now: () => bigint;
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
}

const ZERO = BigInt(0);

// The adapter behind each root context, so a handle can be made for a root that Pi's types know only as a context.
const adapters = new WeakMap<TelemetryContext, Adapter>();

// The Effect span behind each handle, read when a handle is a link target or is injected. Roots have none.
const spans = new WeakMap<TelemetryContext, Tracer.AnySpan>();

/**
 * A handle with no span to record on: the adapter's root (`parent` undefined) or an external parent. The spans it
 * starts are roots or children of `parent`. An event becomes a log line, with the event's name as the message and
 * its attributes as annotations; attributes, status and links describe a span and are dropped.
 */
function parentHandle(adapter: Adapter, parent: Tracer.ExternalSpan | undefined): TelemetrySpan {
	// Every member, optional ones too: a capability pi-telemetry adds fails to compile here until it is decided.
	const handle: Required<TelemetrySpan> = {
		metrics: adapter.metrics,
		propagation: adapter.propagation,
		startSpan: (options, callback) => startSpan(adapter, parent, options, callback),
		addEvent: (name, attributes) => {
			const log = Effect.annotateLogs(Effect.log(name), toSpanAttributes(attributes));
			Effect.runSyncWith(adapter.context)(parent === undefined ? log : Effect.withParentSpan(log, parent));
		},
		addLink: () => {},
		setAttributes: () => {},
		setStatus: () => {},
	};
	if (parent !== undefined) spans.set(handle, parent);
	return handle;
}

/**
 * A handle that records on `span` until `span` ends; after that every call is inert, as the contract asks. The
 * span's status goes to `setStatus`, because only the owner of a span ends it.
 */
function recordingHandle(adapter: Adapter, span: Tracer.Span, setStatus: (status: SpanStatus) => void): TelemetrySpan {
	// As in `parentHandle`: every member.
	const handle: Required<TelemetrySpan> = {
		metrics: adapter.metrics,
		propagation: adapter.propagation,
		startSpan: (options, callback) => startSpan(adapter, span, options, callback),
		addEvent: (name, attributes) => {
			if (isOpen(span)) span.event(name, adapter.now(), toSpanAttributes(attributes));
		},
		addLink: (link) => {
			const links = toLinks([link]);
			if (isOpen(span) && links.length > 0) span.addLinks(links);
		},
		setAttributes: (attributes) => {
			if (isOpen(span)) setSpanAttributes(span, attributes);
		},
		setStatus: (status) => {
			if (isOpen(span)) setStatus(status);
		},
	};
	spans.set(handle, span);
	return handle;
}

/**
 * Starts the Effect span of a Pi span and calls `callback` with its handle, synchronously and once. The span stays
 * open until the callback's value or promise settles, then ends with the last explicit status, or else `ok` for a
 * value and `error` for a throw or rejection. The callback's value or rejection is passed on unchanged. A span whose
 * parent has ended is not recorded: its callback runs with an inert handle.
 */
function startSpan<T>(
	adapter: Adapter,
	parent: Tracer.AnySpan | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?._tag === "Span" && !isOpen(parent)) return inertHandle(adapter).startSpan(options, callback);
	const span = Effect.runSyncWith(adapter.context)(
		Effect.makeSpan(options.name, {
			// The adapter's root starts new traces, whatever span was current where the adapter was made.
			...(parent === undefined ? { root: true } : { parent }),
			attributes: toSpanAttributes(options.attributes),
			links: toLinks(options.links ?? []),
		}),
	);
	let explicit: Exit.Exit<void, PiSpanFailure> | undefined;
	const handle = recordingHandle(adapter, span, (status) => {
		explicit = toExit(status);
	});
	const end = (automatic: Exit.Exit<void, PiSpanFailure>): void => span.end(adapter.now(), explicit ?? automatic);
	let result: T | Promise<T>;
	try {
		result = callback(handle);
	} catch (error) {
		end(thrownExit(error));
		return Promise.reject(error);
	}
	return Promise.resolve(result).then(
		(value) => {
			end(Exit.void);
			return value;
		},
		(error: unknown) => {
			end(thrownExit(error));
			return Promise.reject(error);
		},
	);
}

/** A span of an ended parent: nothing is recorded, callbacks still run, and the adapter's capabilities remain. */
function inertHandle(adapter: Adapter): TelemetrySpan {
	const inert: TelemetrySpan = {
		...NOOP_TELEMETRY_CONTEXT,
		metrics: adapter.metrics,
		propagation: adapter.propagation,
		startSpan: (options, callback) => NOOP_TELEMETRY_CONTEXT.startSpan(options, () => callback(inert)),
	};
	return inert;
}

/** Whether `span` still records; pi-telemetry asks that every call after settlement is ignored. */
function isOpen(span: Tracer.Span): boolean {
	return span.status._tag === "Started";
}

/** Pi links as Effect links. A target without an Effect span (a root, a no-op or another adapter's) is left out. */
function toLinks(links: readonly SpanLink[]): Tracer.SpanLink[] {
	return Arr.filterMap(links, (link) => {
		const span = spans.get(link.context);
		return span === undefined
			? Result.failVoid
			: Result.succeed({ span, attributes: toSpanAttributes(link.attributes) });
	});
}

/**
 * What a Pi `error` status is in the exit of its Effect span: Pi's error detail, its name and message, which Effect's
 * exporters report as the exception's type and message, or `undefined` when Pi gave no detail.
 */
type PiSpanFailure = Extract<SpanStatus, { status: "error" }>["error"];

/**
 * A Pi status as the exit an Effect span ends with, detached from the caller's object. Not `Match`: its result type
 * unifies an `Exit` to `Effect`, and a span ends with an `Exit`; the status has two cases, narrowed by TypeScript.
 */
function toExit(status: SpanStatus): Exit.Exit<void, PiSpanFailure> {
	if (status.status === "ok") return Exit.void;
	// Copied field by field: the caller may pass an `Error`, whose `message` a spread would not copy.
	return Exit.fail(status.error && { name: status.error.name, message: status.error.message });
}

/**
 * The exit of a span whose callback threw or rejected with `error` (any value, hence the check): an `Error` gives its
 * name and message, as pi-telemetry's reference adapter records them. Nothing else of the value reaches the span, so
 * no payload a caller throws is exported.
 */
function thrownExit(error: unknown): Exit.Exit<void, PiSpanFailure> {
	return Exit.fail(Predicate.isError(error) ? { name: error.name, message: error.message } : undefined);
}
