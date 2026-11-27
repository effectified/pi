// A request for autocomplete suggestions as an Effect: interrupting it aborts the provider's request.

import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { AutocompleteError } from "./errors.ts";

/** What `AutocompleteProvider.getSuggestions` takes: the editor's lines, the cursor and its options. */
type Request = Parameters<AutocompleteProvider["getSuggestions"]>;

/**
 * The suggestions `provider` has for the cursor at `cursorLine`, `cursorCol` of `lines`, or `null` when it has none:
 * a slash command, its argument, or a path after `@` for pi-tui's `CombinedAutocompleteProvider`. `options.force` asks
 * as an explicit Tab does. Interrupting the fiber aborts the request through the provider's signal (a file search
 * stops); a rejection is `AutocompleteError`.
 */
export const getSuggestions = Effect.fn("Tui.getSuggestions")(
	(
		provider: AutocompleteProvider,
		lines: Request[0],
		cursorLine: Request[1],
		cursorCol: Request[2],
		options: Omit<Request[3], "signal"> = {},
	) =>
		Effect.tryPromise({
			try: (signal) => provider.getSuggestions(lines, cursorLine, cursorCol, { ...options, signal }),
			catch: (cause) => AutocompleteError.make({ cause }),
		}),
);
