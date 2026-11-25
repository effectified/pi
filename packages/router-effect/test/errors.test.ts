import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	AttemptUnsettled,
	ConstraintsUnavailable,
	InvalidConstraints,
	NoRouteAvailable,
	RoutesExhausted,
	RouteTableError,
	RouteTableIssue,
	UnknownAlias,
} from "../src/index.ts";
import { failing } from "./scripted.ts";

describe("RouteTableError", () => {
	it("says each kind of issue in words that name the entry", () => {
		const said = (issue: RouteTableIssue) => new RouteTableError({ issues: [issue] }).message;
		expect(said({ _tag: "Malformed", message: "Expected string" })).toBe("Expected string");
		expect(said({ _tag: "DuplicateClassification", label: "public" })).toBe(
			'Classification "public" is listed twice',
		);
		expect(said({ _tag: "DuplicateAlias", alias: "fast" })).toBe('Alias "fast" is defined twice');
		expect(said({ _tag: "EmptyAlias", alias: "fast" })).toBe('Alias "fast" has no route');
		expect(said({ _tag: "UnknownDefaultClassification", alias: "fast", label: "x" })).toBe(
			'Alias "fast" defaults to the unknown classification "x"',
		);
		expect(said({ _tag: "DuplicateRoute", alias: "fast", provider: "a", model: "m" })).toBe(
			'Alias "fast" names a/m twice',
		);
		expect(said({ _tag: "UnknownCeiling", alias: "fast", provider: "a", model: "m", label: "x" })).toBe(
			'Route a/m of alias "fast" has the unknown ceiling "x"',
		);
		expect(said({ _tag: "UnknownConcurrencyKey", alias: "fast", provider: "a", model: "m", key: "k" })).toBe(
			'Route a/m of alias "fast" has the concurrency key "k", which has no limit',
		);
		expect(said({ _tag: "UnknownProvider", alias: "fast", provider: "a" })).toBe(
			'Alias "fast" names the provider "a", which is not registered',
		);
		expect(said({ _tag: "UnknownModel", alias: "fast", provider: "a", model: "m" })).toBe(
			'Alias "fast" names a/m, which the provider does not list',
		);
	});

	it("has a schema for its issues, so a product can store or send them", async () => {
		const issue = { _tag: "UnknownModel", alias: "fast", provider: "a", model: "m" };
		expect(await Effect.runPromise(Schema.decodeUnknownEffect(RouteTableIssue)(issue))).toEqual(issue);
		const unknown = Effect.flip(Schema.decodeUnknownEffect(RouteTableIssue)({ _tag: "Other" }));
		expect((await Effect.runPromise(unknown))._tag).toBe("SchemaError");
	});
});

describe("the errors of a request", () => {
	it("are tagged and say what happened", () => {
		const unknown = new UnknownAlias({ alias: "nope" });
		expect([unknown._tag, unknown.message]).toEqual(["UnknownAlias", 'The route table has no alias "nope"']);

		const invalid = new InvalidConstraints({ alias: "fast", reason: "no such label" });
		expect([invalid._tag, invalid.message]).toEqual([
			"InvalidConstraints",
			'The constraints of a request to alias "fast" are not usable: no such label',
		]);

		const anywhere = new NoRouteAvailable({ alias: "fast", classification: "secret", excluded: [] });
		expect([anywhere._tag, anywhere.message]).toEqual([
			"NoRouteAvailable",
			'No route of alias "fast" may serve content classified "secret" in any region',
		]);
		const regional = new NoRouteAvailable({
			alias: "fast",
			classification: "secret",
			regions: ["eu", "jp"],
			excluded: [],
		});
		expect(regional.message).toBe(
			'No route of alias "fast" may serve content classified "secret" in the regions eu, jp',
		);

		const none = new NoRouteAvailable({ alias: "fast", classification: "public", regions: [], excluded: [] });
		expect(none.message).toBe('No route of alias "fast" may serve content classified "public" in no region');
		const labelled = new NoRouteAvailable({
			alias: "fast",
			classification: "public",
			requires: ["zero-data-retention", "batch"],
			excluded: [],
		});
		expect(labelled.message).toBe(
			'No route of alias "fast" may serve content classified "public" in any region with the labels zero-data-retention, batch',
		);

		const response = failing("overloaded");
		const exhausted = new RoutesExhausted({
			alias: "fast",
			failures: [{ provider: "a", model: "m", message: "overloaded" }],
			response,
		});
		expect([exhausted._tag, exhausted.message]).toEqual([
			"RoutesExhausted",
			'Every route of alias "fast" failed: a/m: overloaded',
		]);
		expect(exhausted.response).toBe(response);
	});

	it("say that the constraints are not known without the source's reason, so Pi never sends the request again", () => {
		// The reason is the product's text: it may hold any word, also one pi-ai retries a request for.
		const error = new ConstraintsUnavailable({ alias: "fast", reason: "the grant store timed out: 503 overloaded" });
		expect([error._tag, error.reason]).toEqual([
			"ConstraintsUnavailable",
			"the grant store timed out: 503 overloaded",
		]);
		expect(error.message).toBe(
			'The constraints of a request to alias "fast" are not known, so it was not sent to any route',
		);
		expect(isRetryableAssistantError(failing(error.message))).toBe(false);
		// The same reason as an error's text would be sent again.
		expect(isRetryableAssistantError(failing(error.reason))).toBe(true);
	});

	it("say which attempt could not be settled without the port's reason, so Pi never sends the request again", () => {
		const response = failing("overloaded");
		const error = new AttemptUnsettled({
			alias: "fast",
			requestId: "lz4k2q9xw-429",
			attempt: 2,
			provider: "a",
			model: "m",
			// The reason is the product's text, and the request id ends in a number: either may read as a status code.
			reason: "the lease store timed out: 503 overloaded",
			response,
		});
		expect([error._tag, error.requestId, error.attempt, error.provider, error.model, error.reason]).toEqual([
			"AttemptUnsettled",
			"lz4k2q9xw-429",
			2,
			"a",
			"m",
			"the lease store timed out: 503 overloaded",
		]);
		expect(error.response).toBe(response);
		expect(error.message).toBe(
			'Attempt 2 of a request to alias "fast" could not be settled, so no other route was tried',
		);
		expect(isRetryableAssistantError(failing(error.message))).toBe(false);
		// The reason, the request id and the provider's own text would each be sent again as an error's text.
		expect(isRetryableAssistantError(failing(error.reason))).toBe(true);
		expect(isRetryableAssistantError(failing(`request ${error.requestId}`))).toBe(true);
		expect(isRetryableAssistantError(response)).toBe(true);
	});

	it("can be told apart by tag when handled", async () => {
		const handled = await Effect.runPromise(
			Effect.fail(new UnknownAlias({ alias: "nope" })).pipe(
				Effect.catchTag("UnknownAlias", (error) => Effect.succeed(`handled ${error.alias}`)),
			),
		);
		expect(handled).toBe("handled nope");
	});
});
