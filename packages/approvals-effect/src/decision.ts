// The decision a person made about a request: approved or denied, for which arguments, by whom and when.

import { Clock, Effect, Schema } from "effect";
import { Digest } from "./digest.ts";
import type { Request } from "./request.ts";

// What both decisions say.
const made = {
	/** The digest of the arguments the person saw: the request's `digest`. */
	digest: Digest,
	/** Who decided: an opaque principal the host supplies after it authenticated the person. Never checked here. */
	by: Schema.String,
	/** When, in epoch milliseconds. */
	at: Schema.Finite,
};

/**
 * What a person decided about one request: `Approved`, the call may run with the arguments of `digest`, or `Denied`,
 * it must not and the model is told `note`. Choose with `Decision.match`.
 */
export const Decision = Schema.TaggedUnion({
	Approved: made,
	Denied: { ...made, note: Schema.optionalKey(Schema.String) },
});

/** What a person decided about one request. */
export type Decision = typeof Decision.Type;

/** The call may run with the arguments of `digest`. */
export const Approved = Decision.cases.Approved;

/** The call may run with the arguments of `digest`. */
export type Approved = typeof Approved.Type;

/** The call must not run; `note` is told to the model. */
export const Denied = Decision.cases.Denied;

/** The call must not run. */
export type Denied = typeof Denied.Type;

/** An approval of `request` by `by`, made now on the `Clock`. */
export const approve: (request: Pick<Request, "digest">, by: string) => Effect.Effect<Approved> = Effect.fn(
	"Approvals.approve",
)(function* (request, by) {
	const at = yield* Clock.currentTimeMillis;
	return Approved.make({ digest: request.digest, by, at });
});

/** A denial of `request` by `by`, made now on the `Clock`; `note` is told to the model. */
export const deny: (request: Pick<Request, "digest">, by: string, note?: string) => Effect.Effect<Denied> = Effect.fn(
	"Approvals.deny",
)(function* (request, by, note) {
	const at = yield* Clock.currentTimeMillis;
	// No `note` key without a note, so a denial is the same JSON when it is stored.
	return Denied.make({ digest: request.digest, by, at, ...(note === undefined ? {} : { note }) });
});
