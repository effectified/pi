// The decision a person made about a request: approved or denied, for which arguments, by whom and when.

import { Clock, Effect, Schema } from "effect";
import type { Request } from "./request.ts";

// What both decisions say.
const made = {
	/** The digest of the arguments the person saw: the request's `digest`. */
	digest: Schema.String,
	/** Who decided: an opaque principal the host supplies after it authenticated the person. Never checked here. */
	by: Schema.String,
	/** When, in epoch milliseconds. */
	at: Schema.Number,
};

/** The call may run with the arguments of `digest`. */
export const Approved = Schema.TaggedStruct("Approved", made);

/** The call must not run; `note` is told to the model. */
export const Denied = Schema.TaggedStruct("Denied", { ...made, note: Schema.optionalKey(Schema.String) });

/** What a person decided about one request. */
export const Decision = Schema.Union([Approved, Denied]);

/** What a person decided about one request. */
export type Decision = typeof Decision.Type;

/** An approval of `request` by `by`, made now on the `Clock`. */
export function approve(request: Pick<Request, "digest">, by: string): Effect.Effect<Decision> {
	return Effect.map(Clock.currentTimeMillis, (at) => ({ _tag: "Approved", digest: request.digest, by, at }));
}

/** A denial of `request` by `by`, made now on the `Clock`; `note` is told to the model. */
export function deny(request: Pick<Request, "digest">, by: string, note?: string): Effect.Effect<Decision> {
	return Effect.map(Clock.currentTimeMillis, (at) => ({
		_tag: "Denied",
		digest: request.digest,
		by,
		at,
		...(note === undefined ? {} : { note }),
	}));
}
