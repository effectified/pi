import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classify } from "../src/classify.ts";
import { failing } from "./scripted.ts";

const NOW = Date.parse("2026-11-24T00:00:00Z");

describe("classify", () => {
	it("lets the next route try after an error pi-ai calls retryable", () => {
		for (const message of ["overloaded", "503 Service Unavailable", "fetch failed", "Provider returned error"]) {
			expect(classify(failing(message), undefined, NOW)).toEqual({ _tag: "Retryable" });
		}
	});

	it("ends the request for an error pi-ai does not call retryable", () => {
		for (const message of ["400 invalid request: bad tool schema", "401 Unauthorized", "content policy refusal"]) {
			expect(classify(failing(message), undefined, NOW)).toEqual({ _tag: "Final" });
		}
	});

	it("ends the request when the provider gave it up, whatever the text says", () => {
		expect(classify(failing("overloaded", "aborted"), undefined, NOW)).toEqual({ _tag: "Final" });
	});

	it("ends the request for an exhausted quota, although it arrives as a 429", () => {
		expect(classify(failing("429 insufficient_quota"), { status: 429, headers: {} }, NOW)).toEqual({ _tag: "Final" });
	});

	it("ends the request for a context overflow, which another route would not fix", () => {
		const overflow = failing("500 server error: prompt is too long: 213462 tokens > 200000 maximum");
		expect(classify(overflow, undefined, NOW)).toEqual({ _tag: "Final" });
	});

	it("does not read a response that did not fail", () => {
		expect(classify(fauxAssistantMessage("rate limit"), undefined, NOW)).toEqual({ _tag: "Final" });
	});

	it("reads a rate limit from pi-ai's wording", () => {
		for (const message of [
			"429 Too Many Requests",
			"Rate limit reached for requests",
			"rate_limit_error",
			"ResourceExhausted",
		]) {
			expect(classify(failing(message), undefined, NOW)).toEqual({
				_tag: "RateLimited",
				retryAfterMillis: undefined,
			});
		}
	});

	it("reads a rate limit from the status the adapter reported, whatever the text says", () => {
		expect(classify(failing("overloaded"), { status: 429, headers: {} }, NOW)).toEqual({
			_tag: "RateLimited",
			retryAfterMillis: undefined,
		});
		expect(classify(failing("overloaded"), { status: 503, headers: { "retry-after": "7" } }, NOW)).toEqual({
			_tag: "Retryable",
		});
	});

	it("takes the wait from a retry-after-ms or retry-after header, in any letter case", () => {
		const limited = failing("429 Too Many Requests");
		const hint = (headers: Record<string, string>) => classify(limited, { status: 429, headers }, NOW);
		expect(hint({ "retry-after-ms": "1500" })).toEqual({ _tag: "RateLimited", retryAfterMillis: 1500 });
		expect(hint({ "Retry-After": "7" })).toEqual({ _tag: "RateLimited", retryAfterMillis: 7000 });
		expect(hint({ "retry-after": "0.5" })).toEqual({ _tag: "RateLimited", retryAfterMillis: 500 });
		// The more exact header wins.
		expect(hint({ "retry-after": "7", "retry-after-ms": "250" })).toEqual({
			_tag: "RateLimited",
			retryAfterMillis: 250,
		});
	});

	it("takes the wait from a retry-after header that is a date, against the Clock time given", () => {
		const limited = failing("429 Too Many Requests");
		expect(
			classify(limited, { status: 429, headers: { "retry-after": "Tue, 24 Nov 2026 00:00:30 GMT" } }, NOW),
		).toEqual({ _tag: "RateLimited", retryAfterMillis: 30_000 });
	});

	it("has no hint for a header it cannot read or a wait that has passed", () => {
		const limited = failing("429 Too Many Requests");
		const hint = (headers: Record<string, string>) => classify(limited, { status: 429, headers }, NOW);
		const unreadable: Record<string, string>[] = [
			{ "retry-after": "soon" },
			{ "retry-after": "-3" },
			{ "retry-after-ms": "0" },
			{ "retry-after": "Tue, 24 Nov 2026 00:00:00 GMT" },
		];
		for (const headers of unreadable) {
			expect(hint(headers)).toEqual({ _tag: "RateLimited", retryAfterMillis: undefined });
		}
	});

	it("takes the wait from pi-ai's text when a server asked for more than the request allows", () => {
		const message = "Server requested 120s retry delay (max: 60s). 429 rate limit exceeded";
		expect(classify(failing(message), undefined, NOW)).toEqual({ _tag: "RateLimited", retryAfterMillis: 120_000 });
	});
});
