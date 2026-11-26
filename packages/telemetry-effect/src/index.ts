// Pi telemetry in Effect: Pi spans, metrics and events as Effect spans, metrics and logs, with trace context carried into Pi calls.

// Every type pi-telemetry declares (`TelemetrySpan`, `Telemetry`, ...), so an application names them without
// importing pi-telemetry; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-telemetry";
// A telemetry schema is serializable data, and its helper the identity that keeps its literal types.
export { defineTelemetrySchema } from "@earendil-works/pi-telemetry";
export { makeTelemetryContext } from "./adapter.ts";
export { PiTelemetry } from "./pi-telemetry.ts";
export * as TypedMetrics from "./typed-metrics.ts";
export * as TypedSpans from "./typed-spans.ts";
