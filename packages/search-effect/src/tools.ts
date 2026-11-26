// The search and fetch tools: a model's call is brought within the limits and answered by the provider; the model
// reads compact text, and the host finds the evidence of the call in the result's details.

import { Tool } from "@effectified/pi-durable";
import { Effect, Schema, SchemaTransformation } from "effect";
import { capFetch, capSearch, defaultLimits, type Limits } from "./limits.ts";
import { Count, Evidence, type Retrieval, SearchProvider } from "./provider/index.ts";
import { fetchText, searchText } from "./render.ts";

/** The search tool's name, as a model calls it and a conversation selects it. */
export const SEARCH = "web_search";

/** The fetch tool's name. */
export const FETCH = "web_fetch";

/** The search tool: it needs the `SearchProvider` of the registry's context. */
export type SearchTool = Tool.Tool<typeof SEARCH, typeof SearchParameters, Schema.String, never, SearchProvider>;

/** The fetch tool: it needs the `SearchProvider` of the registry's context. */
export type FetchTool = Tool.Tool<typeof FETCH, typeof FetchParameters, Schema.String, never, SearchProvider>;

/** Both tools as the extension `search`: a plain object, which is what `Registry.layer` installs. */
export interface SearchExtension {
	readonly name: "search";
	readonly tools: readonly [SearchTool, FetchTool];
}

/**
 * The extension `search` for `Registry.layer`: both tools within `limits`, each absent limit its default. The
 * registry then requires a `SearchProvider`. It has no hooks, so its place among the extensions does not matter.
 */
export function extension(limits: Partial<Limits> = {}): SearchExtension {
	const fixed: Limits = {
		maxResults: limits.maxResults ?? defaultLimits.maxResults,
		defaultResults: limits.defaultResults ?? defaultLimits.defaultResults,
		snippetCharacters: limits.snippetCharacters ?? defaultLimits.snippetCharacters,
		maxUrls: limits.maxUrls ?? defaultLimits.maxUrls,
		maxCharacters: limits.maxCharacters ?? defaultLimits.maxCharacters,
		allowedDomains: limits.allowedDomains,
		blockedDomains: limits.blockedDomains,
		publishedAfter: limits.publishedAfter,
		publishedBefore: limits.publishedBefore,
	};
	return { name: "search", tools: [search(fixed), fetch(fixed)] };
}

const SearchParameters = Schema.Struct({
	query: Schema.String.annotate({ description: "What to look for, in plain words." }),
	maxResults: Schema.optional(Count.annotate({ description: "How many results to return." })),
	includeDomains: Schema.optional(
		Schema.Array(Schema.String).annotate({ description: "Only results from these domains, such as example.com." }),
	),
	excludeDomains: Schema.optional(
		Schema.Array(Schema.String).annotate({ description: "No results from these domains." }),
	),
	publishedAfter: Schema.optional(dateParameter("Only pages published after this ISO 8601 date.")),
	publishedBefore: Schema.optional(dateParameter("Only pages published before this ISO 8601 date.")),
});

/**
 * The tool `web_search` within `limits`. The model reads a numbered list of titles, addresses and snippets; the
 * result's details hold the evidence. A provider failure and a request no limit lets through are error results the
 * model reads. `replay: "safe"`: a call cut off by a crash asks the provider again, and the stored evidence is that
 * of the answer the model read.
 */
export function search(limits: Limits): SearchTool {
	return Tool.make(SEARCH, {
		description:
			"Search the web. Returns titles, addresses and short excerpts; read a page in full with the fetch tool.",
		parameters: SearchParameters,
		success: Schema.String,
		replay: "safe",
		handler: ({ query, ...asked }) =>
			Effect.gen(function* () {
				const provider = yield* SearchProvider;
				const retrieval = yield* provider.search(query, yield* capSearch(limits, asked));
				return yield* answer(searchText(retrieval, limits.snippetCharacters), retrieval);
			}).pipe(Effect.catch((error) => Effect.succeed(Tool.error(error.message)))),
	});
}

/**
 * A date as a model writes one, ISO 8601 text, decoded to an instant. Effect's `DateTimeUtc` decodes the same text
 * but gives its JSON Schema no description, and a model needs one to know what to write.
 */
function dateParameter(description: string) {
	return Schema.String.annotate({ description }).pipe(
		Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString),
	);
}

const FetchParameters = Schema.Struct({
	urls: Schema.Array(Schema.String).annotate({
		description: "The addresses of the pages to read, each with https://.",
	}),
	maxCharacters: Schema.optional(Count.annotate({ description: "How much of each page's text to return." })),
});

/**
 * The tool `web_fetch` within `limits`. The model reads each page's text, cut to the limit with a note, and which
 * pages were not read and why; the result's details hold the evidence. Failures and replay are as for `search`.
 */
export function fetch(limits: Limits): FetchTool {
	return Tool.make(FETCH, {
		description: "Read web pages. Returns the text of each page at the given addresses.",
		parameters: FetchParameters,
		success: Schema.String,
		replay: "safe",
		handler: (asked) =>
			Effect.gen(function* () {
				const provider = yield* SearchProvider;
				const plan = yield* capFetch(limits, asked);
				const retrieval = yield* provider.fetch(plan.urls, { maxCharacters: plan.maxCharacters });
				// The plan's length, not the limit's: a model may ask for less than it is allowed.
				return yield* answer(fetchText(retrieval, plan.maxCharacters, plan.skipped), retrieval);
			}).pipe(Effect.catch((error) => Effect.succeed(Tool.error(error.message)))),
	});
}

/** The result of a call: `text` for the model, the evidence of `retrieval` as the details for the host. */
function answer(text: string, retrieval: Retrieval): Effect.Effect<Tool.Reply<string>> {
	// Evidence is JSON by construction (strings, an instant, a JSON body): a failure to encode it is a defect.
	return Effect.map(Effect.orDie(Evidence.toJson(retrieval)), (details) => Tool.result(text, { details }));
}
