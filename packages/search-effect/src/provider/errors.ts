// The typed failures of a search provider: what `search` and `fetch` fail with, whatever the provider behind them.
// Each message is one sentence a model can read; none holds a credential.

import { Schema } from "effect";
import { ProviderName } from "./provider-name.ts";

/** The provider refused the call for now: too many requests. `retryAfterMillis` is its hint, when it gave one. */
export class SearchRateLimited extends Schema.TaggedError<SearchRateLimited, { readonly brand: unique symbol }>()(
	"SearchRateLimited",
	{ provider: ProviderName, retryAfterMillis: Schema.optional(Schema.Finite) },
) {
	override get message(): string {
		return this.retryAfterMillis === undefined
			? `${this.provider} is rate limited.`
			: `${this.provider} is rate limited. Retry after ${Math.ceil(this.retryAfterMillis / 1000)} s.`;
	}
}

/** The provider rejected the credentials: a missing, wrong or unentitled key. Retrying does not help. */
export class SearchUnauthorized extends Schema.TaggedError<SearchUnauthorized, { readonly brand: unique symbol }>()(
	"SearchUnauthorized",
	{ provider: ProviderName, status: Schema.Int },
) {
	override get message(): string {
		return `${this.provider} rejected the credentials (HTTP ${this.status}).`;
	}
}

/** The provider answered with a failure status. `detail` is what it said, when it said something. */
export class SearchProviderFailure extends Schema.TaggedError<
	SearchProviderFailure,
	{ readonly brand: unique symbol }
>()("SearchProviderFailure", {
	provider: ProviderName,
	status: Schema.Int,
	detail: Schema.optional(Schema.String),
}) {
	override get message(): string {
		return this.detail === undefined
			? `${this.provider} failed with HTTP ${this.status}.`
			: `${this.provider} failed with HTTP ${this.status}: ${this.detail}`;
	}
}

/** No response arrived: the connection failed, or the body could not be read. */
export class SearchTransportFailure extends Schema.TaggedError<
	SearchTransportFailure,
	{ readonly brand: unique symbol }
>()("SearchTransportFailure", { provider: ProviderName, detail: Schema.String }) {
	override get message(): string {
		return `${this.provider} could not be reached: ${this.detail}`;
	}
}

/** The provider answered with success, but its body is not what its API promises. */
export class SearchResponseInvalid extends Schema.TaggedError<
	SearchResponseInvalid,
	{ readonly brand: unique symbol }
>()("SearchResponseInvalid", { provider: ProviderName, detail: Schema.String }) {
	override get message(): string {
		return `${this.provider} answered with a response that could not be read: ${this.detail}`;
	}
}

/**
 * Every failure of a provider call, as one Schema: a caller tells them apart with `SearchError.match`, tests one with
 * `SearchError.guards`, or picks one with `Effect.catchTag`.
 */
export const SearchError = Schema.Union([
	SearchRateLimited,
	SearchUnauthorized,
	SearchProviderFailure,
	SearchTransportFailure,
	SearchResponseInvalid,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure of a provider call. */
export type SearchError = typeof SearchError.Type;
