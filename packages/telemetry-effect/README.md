# @effectified/pi-telemetry

[`@earendil-works/pi-telemetry`](../telemetry/README.md) on Effect's own observability services, in both directions.
For `effect` 4.1.

- **Pi telemetry into Effect.** An adapter for pi-telemetry's `TelemetryContext`: a Pi span is a span of Effect's
  `Tracer`, a Pi metric is an Effect `Metric`, a Pi event that has no span is a line of Effect's logger. Whatever
  exports your Effect program's telemetry exports Pi's too.
- **Effect trace context into Pi.** The Pi span handle of the current Effect span, so the spans Pi starts are
  children of the Effect span that called it. Carriers are W3C Trace Context, so a trace continues after a restart.

The package adds no telemetry of its own. It forwards what Pi records; Pi's schemas (`AI_TELEMETRY_SCHEMA`,
`DURABLE_TELEMETRY_SCHEMA`) keep prompts, tool arguments and results out of attributes.

## Installation

```bash
npm install @effectified/pi-telemetry @earendil-works/pi-telemetry effect
```

## Pi telemetry into Effect

`PiTelemetry` is a service whose value is a pi-telemetry `TelemetryContext`. Hand it to anything in Pi that takes
one.

```typescript
import { Effect } from "effect";
import { PiTelemetry } from "@effectified/pi-telemetry";

const program = Effect.gen(function* () {
	const telemetry = yield* PiTelemetry;

	// What Pi does with the value: spans around callbacks, metrics, carriers.
	yield* Effect.promise(() =>
		telemetry.startSpan({ name: "pi.durable.phase", attributes: { "task.id": "t1" } }, async (span) => {
			span.addEvent("pi.durable.checkpoint", { phase: "run" });
			span.setAttributes({ outcome: "done" });
		}),
	);
	telemetry.metrics?.counter("pi.ai.tokens", { unit: "token" }).add(120, { kind: "input" });
});

await Effect.runPromise(program.pipe(Effect.provide(PiTelemetry.layer)));
```

The adapter is built from the context its Layer is built in: that context's `Tracer` creates the spans, its `Clock`
stamps span ends and events, its metric registry takes the measurements, its loggers take the log lines. Provide the
tracer to the Layer, not only to the program (see [Exporting](#exporting-with-otlp)). `makeTelemetryContext` is the
same adapter as a plain Effect, for a host that does not use the Layer.

| pi-telemetry | Effect |
|---|---|
| Span | `Tracer` span, kind `internal`. A span started on the adapter is a root (`root: true`); a span started on a span is its child |
| Start attributes, `setAttributes()` | Span attributes. `undefined` is left out, a later value replaces an earlier one |
| `addEvent()` | Span event, stamped by `Clock` |
| `addLink()`, `SpanOptions.links` | Span links. A target that has no Effect span is left out |
| Status `ok` | The span ends with a success exit |
| Status `error` with `{ name, message }` | The span ends with a failure holding `{ name, message }`, which Effect's OTLP tracer exports as status `Error` and an `exception` event |
| A callback that throws or rejects | The same failure, from the `Error`'s name and message; any other thrown value gives a failure without detail. The value itself is passed on to the caller unchanged and never reaches the span |
| Counter | `Metric.counter(name, { incremental: true })` |
| Up-down counter | `Metric.counter(name)` (not incremental, so OTLP exports a non-monotonic sum) |
| Histogram | `Metric.histogram(name, { boundaries })`; without boundaries, the OpenTelemetry default buckets (0, 5, 10, 25, ... 10000) |
| Measurement attributes | Metric attributes, as strings (an array as JSON) |
| Instrument `unit` | The metric attribute `unit`, which Effect's OTLP exporter reads as the unit |
| Carrier | `{ traceparent }`, and `tracestate` when the trace arrived with one |

A handle that has no span to record on (the adapter itself, a parent extracted from a carrier, the current-span handle
outside any span) sends `addEvent()` to Effect's logger: the event's name is the message, its attributes are log
annotations, the level is `Info`.

## Effect trace context into Pi

Pi code takes its parent span explicitly: a Chord `Context` carries a `TelemetrySpan`, and pi-ai request options take
one as `telemetry`. `PiTelemetry.currentSpan` gives that handle for the Effect span it is read in.

```typescript
import { Effect } from "effect";
import { PiTelemetry } from "@effectified/pi-telemetry";

// models: a pi-ai `Models`; model and conversation: what the request needs.
const ask = Effect.gen(function* () {
	const span = yield* PiTelemetry.currentSpan;
	return yield* Effect.promise(() => models.completeSimple(model, conversation, { telemetry: span }));
}).pipe(Effect.withSpan("chat.turn"));
// The trace: chat.turn > pi.ai.request
```

For a Pi call that takes a Chord `Context`, the host puts the handle into the context. This package does not import
Chord, so this step is host code:

```typescript
// Host code: it imports Chord, which this package does not depend on.
import { BACKGROUND_CONTEXT, withTelemetry } from "@earendil-works/chord/context";

const submit = Effect.gen(function* () {
	const span = yield* PiTelemetry.currentSpan;
	const context = withTelemetry(span, BACKGROUND_CONTEXT);
	// root: what `harness.root()` of a Pi Durable harness gives.
	return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, context));
}).pipe(Effect.withSpan("chat.turn"));
```

Read the handle where the Pi call is made: it belongs to the span that is current at that point. While that span is
open, Pi's `addEvent()`, `setAttributes()` and `addLink()` on the handle are recorded on it. `setStatus()` on the
handle does nothing: the Effect that owns the span ends it with its exit. After the span has ended the handle is
inert, as pi-telemetry asks of a settled span.

Outside any Effect span the handle starts root spans. Under an external parent (`Effect.withParentSpan`) it starts
children of that parent.

## Carriers

Pi stores an opaque carrier with a durable task or submission and reads it later, possibly in another process. The
adapter's `propagation` capability writes W3C Trace Context:

```typescript
const carrier = span.propagation?.inject(span);
// { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }

const parent = telemetry.propagation?.extract(carrier);
// A context whose spans are in the same trace, with the injected span as their parent (an Effect external span).
```

- `inject()` gives `undefined` for a context without a span, and for a tracer whose ids are not W3C ids (32 and 16
  lowercase hex digits). No invalid header is ever stored.
- `extract()` checks the whole `traceparent`. An absent, unknown or malformed carrier gives the adapter itself, so
  its spans are roots. It never throws.
- The sampled flag is carried both ways. A `tracestate` is carried from an extracted carrier to every carrier
  injected below it, unchanged.

## Exporting with OTLP

Effect ships OTLP exporters in `effect/observability` (`Otlp`, `OtlpTracer`, `OtlpMetrics`, `OtlpLogger`).
`Otlp.layerJson` installs all three. Build `PiTelemetry.layer` with it, so the adapter picks up the exporting
tracer:

```typescript
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp } from "effect/observability";
import { PiTelemetry } from "@effectified/pi-telemetry";

const Observability = Otlp.layerJson({
	baseUrl: "http://localhost:4318",
	resource: { serviceName: "my-agent" },
}).pipe(Layer.provide(FetchHttpClient.layer));

const Telemetry = PiTelemetry.layer.pipe(Layer.provideMerge(Observability));

await Effect.runPromise(program.pipe(Effect.provide(Telemetry)));
```

The exporter's Layer owns batching and flushes when its scope closes. `PiTelemetry.layer` has no finalizer:
pi-telemetry's contract has no shutdown or flush step, and a span ends when its Pi callback settles.

## Not covered

- **Histogram exemplars.** `record(value, attributes, context)` ignores `context`: Effect metrics have no exemplars.
- **Metric conformance cases.** The adapter passes pi-telemetry's conformance suite for spans, status, links,
  parentage, capabilities and propagation. The suite's two metric cases read a log of single measurements, which
  Effect's aggregating metrics cannot give, so the fixture does not offer them; this package's own tests check the
  metric values.
- **`TelemetryStore`.** Reading stored traces and metrics back is the job of the backend the tracer exports to.
- **Open spans at shutdown.** A span whose Pi callback never settles is never ended; nothing tracks open spans.
- **Failures of the Effect services.** A `Tracer`, metric or logger that throws is not caught: pi-telemetry does not
  ask an adapter to suppress backend failures.
- **Sampling per Pi span.** Sampling follows Effect: `Tracer.MinimumTraceLevel`, the parent's sampled flag, and
  `References.TracerEnabled`. With tracing switched off nothing is recorded and every callback still runs.
- **Effect spans from Pi schemas.** Nothing validates names or attributes against a Pi telemetry schema.
