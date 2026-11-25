// The typed failures of a search provider: what `search` and `fetch` fail with, whatever the provider behind them.
// Each message is one sentence a model can read; none holds a credential.

import { Schema } from "effect";

/** The provider refused the call for now: too many requests. `retryAfterMillis` is its hint, when it gave one. */
export class SearchRateLimited extends Schema.TaggedError<SearchRateLimited>()("SearchRateLimited", {
	provider: Schema.String,
	retryAfterMillis: Schema.optional(Schema.Number),
}) {
	override get message(): string {
		return this.retryAfterMillis === undefined
			? `${this.provider} is rate limited.`
			: `${this.provider} is rate limited. Retry after ${Math.ceil(this.retryAfterMillis / 1000)} s.`;
	}
}

/** The provider rejected the credentials: a missing, wrong or unentitled key. Retrying does not help. */
export class SearchUnauthorized extends Schema.TaggedError<SearchUnauthorized>()("SearchUnauthorized", {
	provider: Schema.String,
	status: Schema.Number,
}) {
	override get message(): string {
		return `${this.provider} rejected the credentials (HTTP ${this.status}).`;
	}
}

/** The provider answered with a failure status. `detail` is what it said, when it said something. */
export class SearchProviderFailure extends Schema.TaggedError<SearchProviderFailure>()("SearchProviderFailure", {
	provider: Schema.String,
	status: Schema.Number,
	detail: Schema.optional(Schema.String),
}) {
	override get message(): string {
		return this.detail === undefined
			? `${this.provider} failed with HTTP ${this.status}.`
			: `${this.provider} failed with HTTP ${this.status}: ${this.detail}`;
	}
}

/** No response arrived: the connection failed, or the body could not be read. */
export class SearchTransportFailure extends Schema.TaggedError<SearchTransportFailure>()("SearchTransportFailure", {
	provider: Schema.String,
	detail: Schema.String,
}) {
	override get message(): string {
		return `${this.provider} could not be reached: ${this.detail}`;
	}
}

/** The provider answered with success, but its body is not what its API promises. */
export class SearchResponseInvalid extends Schema.TaggedError<SearchResponseInvalid>()("SearchResponseInvalid", {
	provider: Schema.String,
	detail: Schema.String,
}) {
	override get message(): string {
		return `${this.provider} answered with a response that could not be read: ${this.detail}`;
	}
}

/** Every failure of a provider call. */
export type SearchError =
	| SearchRateLimited
	| SearchUnauthorized
	| SearchProviderFailure
	| SearchTransportFailure
	| SearchResponseInvalid;
