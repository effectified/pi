// Pi telemetry in Effect: Pi spans, metrics and events as Effect spans, metrics and logs, with trace context carried into Pi calls.

// Every type pi-telemetry declares (`TelemetrySpan`, `Telemetry`, ...), so an application names them without
// importing pi-telemetry; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-telemetry";
export { makeTelemetryContext } from "./adapter.ts";
export { PiTelemetry } from "./pi-telemetry.ts";
