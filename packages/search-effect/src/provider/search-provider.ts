// The provider port: web search and page fetch as a service a product provides, whoever answers behind it.

import { Context, type Effect } from "effect";
import type { SearchError } from "./errors.ts";
import type { FetchOptions, SearchOptions } from "./options.ts";
import type { Retrieval } from "./retrieval.ts";

/** What a provider does. Both calls are interruptible, and neither retries: a caller decides what a failure costs. */
export interface SearchProviderService {
	/** Searches the web for `query`. */
	readonly search: (query: string, options?: SearchOptions) => Effect.Effect<Retrieval, SearchError>;
	/** Reads the pages at `urls`. A page the provider cannot read is in `unfetched`; only a failed call fails. */
	readonly fetch: (urls: ReadonlyArray<string>, options?: FetchOptions) => Effect.Effect<Retrieval, SearchError>;
}

/** The search provider of this program. A provider file gives it as a Layer (`@effectified/pi-search/exa`). */
export class SearchProvider extends Context.Service<SearchProvider, SearchProviderService>()(
	"@effectified/pi-search/provider/search-provider/SearchProvider",
) {}
