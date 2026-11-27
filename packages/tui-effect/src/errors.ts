// The typed failures of this package: what a wrapped pi-tui function throws or rejects with, as one closed union.

import { Predicate, Schema } from "effect";

/** A color value pi-tui cannot parse (`parseColor`): not a name, hex, `rgb()`, `oklch()` or palette index it knows. */
export class InvalidColor extends Schema.TaggedError<InvalidColor, { readonly brand: unique symbol }>()(
	"InvalidColor",
	{
		// @effect-diagnostics-next-line schemaNumber:off The rejected value is kept as given: NaN and Infinity included.
		value: Schema.Union([Schema.String, Schema.Number]),
		message: Schema.String,
	},
) {}

/** The native clipboard failed a transfer; `cause` is what pi-tui's native helper rejected with. */
export class ClipboardError extends Schema.TaggedError<ClipboardError, { readonly brand: unique symbol }>()(
	"ClipboardError",
	{
		operation: Schema.Literals(["getText", "getImage", "getFilePaths", "setText"]),
		cause: Schema.Defect(),
	},
) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/** An autocomplete provider rejected a request for suggestions; `cause` is what it rejected with. */
export class AutocompleteError extends Schema.TaggedError<AutocompleteError, { readonly brand: unique symbol }>()(
	"AutocompleteError",
	{ cause: Schema.Defect() },
) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/**
 * Every failure of this package, as one closed union: `TuiError.match` picks a handler per tag. pi-tui exports no
 * error class: these are what its functions throw or reject with.
 */
export const TuiError = Schema.Union([InvalidColor, ClipboardError, AutocompleteError]).pipe(
	Schema.toTaggedUnion("_tag"),
);

/** Every failure of this package. */
export type TuiError = typeof TuiError.Type;
