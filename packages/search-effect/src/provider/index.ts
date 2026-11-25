// The provider port alone: the service, its options, results and errors. It imports nothing of Pi, so a product
// can search without a harness, and a provider file imports only this.

export {
	type SearchError,
	SearchProviderFailure,
	SearchRateLimited,
	SearchResponseInvalid,
	SearchTransportFailure,
	SearchUnauthorized,
} from "./errors.ts";
export * as Evidence from "./evidence.ts";
export { Count, FetchOptions, SearchOptions } from "./options.ts";
export { Hit, Retrieval, Unfetched } from "./retrieval.ts";
export { SearchProvider, type SearchProviderService } from "./search-provider.ts";
