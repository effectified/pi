// What a caller may ask of a search or a fetch, as data: the options every provider understands.

import { Schema } from "effect";

/** A count or a length: a whole number above zero. */
export const Count = Schema.Int.check(Schema.isGreaterThan(0));

/** How a search is narrowed. A provider leaves out what it has no means for; an absent option is its own default. */
export const SearchOptions = Schema.Struct({
	/** The most hits to return. */
	maxResults: Schema.optional(Count),
	/** The most characters of each hit's snippet. */
	snippetCharacters: Schema.optional(Count),
	/** Only hits from these domains (`example.com` covers its subdomains). Empty means any domain. */
	includeDomains: Schema.optional(Schema.Array(Schema.String)),
	/** No hits from these domains. */
	excludeDomains: Schema.optional(Schema.Array(Schema.String)),
	/** Only pages published after this instant. */
	publishedAfter: Schema.optional(Schema.DateTimeUtc),
	/** Only pages published before this instant. */
	publishedBefore: Schema.optional(Schema.DateTimeUtc),
});

/** How a search is narrowed. */
export type SearchOptions = typeof SearchOptions.Type;

/** How pages are read. */
export const FetchOptions = Schema.Struct({
	/** The most characters of each page's text. */
	maxCharacters: Schema.optional(Count),
});

/** How pages are read. */
export type FetchOptions = typeof FetchOptions.Type;
