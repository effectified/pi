// What a provider call gives: hits in one shape for every provider, and the evidence of the call they came from.

import { Schema } from "effect";
import { Evidence } from "./evidence.ts";

/** One page a search found or a fetch read. A field the provider did not give is absent, never made up. */
export const Hit = Schema.Struct({
	url: Schema.String,
	title: Schema.optional(Schema.String),
	/** A short excerpt: what a search gives. */
	snippet: Schema.optional(Schema.String),
	/** The page's text: what a fetch gives. */
	text: Schema.optional(Schema.String),
	/** As the provider wrote it, usually ISO 8601. */
	publishedDate: Schema.optional(Schema.String),
	author: Schema.optional(Schema.String),
	/** The provider's relevance score. Hits are in the provider's order whether it gives one or not. */
	score: Schema.optional(Schema.Number),
});

/** One page a search found or a fetch read. */
export type Hit = typeof Hit.Type;

/** A page a fetch asked for and the provider could not read, with the provider's reason. */
export const Unfetched = Schema.Struct({
	url: Schema.String,
	reason: Schema.String,
});

/** A page a fetch asked for and the provider could not read. */
export type Unfetched = typeof Unfetched.Type;

/** The result of one `search` or `fetch`: the evidence of the call, and what it normalises to. */
export const Retrieval = Schema.Struct({
	...Evidence.fields,
	hits: Schema.Array(Hit),
	/** Pages a fetch could not read; empty for a search. */
	unfetched: Schema.Array(Unfetched),
});

/** The result of one `search` or `fetch`. */
export type Retrieval = typeof Retrieval.Type;
