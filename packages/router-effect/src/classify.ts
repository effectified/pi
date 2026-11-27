// How a failed provider response is read: may the next route be tried, and was it a rate limit with a wait hint.

import {
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type ProviderResponse,
} from "@effectified/pi-ai";
import { DateTime, Option, Record, Schema, String as Str } from "effect";

/** What a failed response means for routing. `FailureKind.match` picks a handler per tag. */
export const FailureKind = Schema.TaggedUnion({
	/** The request fails with this response: no other route is tried. */
	Final: {},
	/** A transient failure of the provider: the next route may be tried. */
	Retryable: {},
	/** A transient rate limit: the next route may be tried, and the route's concurrency key backs off. */
	RateLimited: { retryAfterMillis: Schema.UndefinedOr(Schema.Finite) },
});

/** What a failed response means for routing. */
export type FailureKind = typeof FailureKind.Type;

/** pi-ai's wordings of a rate limit, taken from the retryable patterns of its `utils/retry.ts`. */
const RATE_LIMIT =
	/rate.?limit|too many requests|rate increased too quickly|(?<![a-z0-9])429(?![a-z0-9])|ResourceExhausted/i;

/**
 * Reads the failed `response` of a route. The verdict is pi-ai's: a response is retryable when
 * `isRetryableAssistantError` says so, which leaves out aborts and exhausted quotas, and when it is not a context
 * overflow, which another route would not fix and which Pi must see to compact. `answer` is the HTTP response the
 * provider's adapter reported through `onResponse`, when it reported one; `now` is the Clock time, for a
 * `retry-after` header that is a date.
 */
export function classify(response: AssistantMessage, answer: ProviderResponse | undefined, now: number): FailureKind {
	if (isContextOverflow(response) || !isRetryableAssistantError(response)) return { _tag: "Final" };
	const text = response.errorMessage ?? "";
	if (answer?.status !== 429 && !RATE_LIMIT.test(text)) return { _tag: "Retryable" };
	return { _tag: "RateLimited", retryAfterMillis: headerHint(answer, now) ?? textHint(text) };
}

/** The wait a `retry-after-ms` or `retry-after` header asks for. Wire input: anything unreadable is no hint. */
function headerHint(answer: ProviderResponse | undefined, now: number): number | undefined {
	if (answer === undefined) return undefined;
	const headers = Record.mapKeys(answer.headers, (name) => Str.toLowerCase(name));
	const millis = Number.parseFloat(Option.getOrElse(Record.get(headers, "retry-after-ms"), () => ""));
	if (Number.isFinite(millis)) return positive(millis);
	return Option.match(Record.get(headers, "retry-after"), {
		onNone: () => undefined,
		onSome: (retryAfter) => {
			const seconds = Number.parseFloat(retryAfter);
			// The header is a number of seconds or an HTTP date.
			return positive(Number.isNaN(seconds) ? untilDate(retryAfter, now) : seconds * 1000);
		},
	});
}

/** The milliseconds from `now` to the HTTP date `text`; not a number when it is no date. */
function untilDate(text: string, now: number): number {
	return Option.match(DateTime.make(text), {
		onNone: () => Number.NaN,
		onSome: (date) => DateTime.toEpochMillis(date) - now,
	});
}

/** pi-ai's own text when a server asked for a longer wait than the request's `maxRetryDelayMs` allows. */
const SERVER_REQUESTED = /Server requested (\d+)s retry delay/;

function textHint(text: string): number | undefined {
	const seconds = SERVER_REQUESTED.exec(text)?.[1];
	return seconds === undefined ? undefined : Number.parseInt(seconds, 10) * 1000;
}

function positive(millis: number): number | undefined {
	return Number.isFinite(millis) && millis > 0 ? Math.ceil(millis) : undefined;
}
