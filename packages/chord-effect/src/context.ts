// `@effectified/pi-chord/context`: Chord's context, the one a Pi call takes, made from the calling fiber.

// Chord's context types (`Context`, `ContextKey`), so a program names them without importing Chord.
export type * from "@earendil-works/chord/context";
// Chord's derivations of a context: synchronous, free of I/O, each a new context that leaves its parent as it was.
// `withTelemetry` takes the span handle of `@effectified/pi-telemetry`'s `PiTelemetry.currentSpan`.
export {
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withContextValue,
	withoutAbortSignal,
	withTelemetry,
} from "@earendil-works/chord/context";
export * as ChordContext from "./chord-context.ts";
