// The Chord context the Chord calls of a fiber are made under, set for a region by a host or a facet's handler.

import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@earendil-works/chord/context";
import { Context } from "effect";

/**
 * The parent of the Chord context every call of this package makes: its values, cancellation and telemetry reach the
 * call, under the fiber's current span. Default: Chord's background context. Inside an Effect handler of a facet it
 * is the handler's `ctx`, so the calls the handler makes act for its caller and end with its call.
 */
export const ParentContext: Context.Reference<ChordContext> = Context.Reference<ChordContext>(
	"@effectified/pi-chord/ParentContext",
	{ defaultValue: () => BACKGROUND_CONTEXT },
);
