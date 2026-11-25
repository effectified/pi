import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type SearchError,
	SearchProviderFailure,
	SearchRateLimited,
	SearchResponseInvalid,
	SearchTransportFailure,
	SearchUnauthorized,
} from "../src/provider/index.ts";

describe("the provider errors", () => {
	it("each say in one sentence what happened", () => {
		const errors: ReadonlyArray<SearchError> = [
			new SearchRateLimited({ provider: "exa", retryAfterMillis: 1500 }),
			new SearchRateLimited({ provider: "exa" }),
			new SearchUnauthorized({ provider: "exa", status: 401 }),
			new SearchProviderFailure({ provider: "exa", status: 500, detail: "Internal error" }),
			new SearchProviderFailure({ provider: "exa", status: 503 }),
			new SearchTransportFailure({ provider: "exa", detail: "connection reset" }),
			new SearchResponseInvalid({ provider: "exa", detail: "Expected string, got 1" }),
		];
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			// A hint is rounded up to whole seconds: waiting less would be refused again.
			["SearchRateLimited", "exa is rate limited. Retry after 2 s."],
			["SearchRateLimited", "exa is rate limited."],
			["SearchUnauthorized", "exa rejected the credentials (HTTP 401)."],
			["SearchProviderFailure", "exa failed with HTTP 500: Internal error"],
			["SearchProviderFailure", "exa failed with HTTP 503."],
			["SearchTransportFailure", "exa could not be reached: connection reset"],
			["SearchResponseInvalid", "exa answered with a response that could not be read: Expected string, got 1"],
		]);
	});

	it("are failures an Effect program handles by tag", async () => {
		const waited = await Effect.runPromise(
			Effect.fail(new SearchRateLimited({ provider: "exa", retryAfterMillis: 7000 })).pipe(
				Effect.catchTag("SearchRateLimited", (error) => Effect.succeed(error.retryAfterMillis)),
			),
		);
		expect(waited).toBe(7000);
	});
});
